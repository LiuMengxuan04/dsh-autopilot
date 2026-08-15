import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Browser, BrowserContext, Locator, Page, Route, WebSocketRoute } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const playwright = vi.hoisted(() => ({ launch: vi.fn() }))

vi.mock('playwright', () => ({ chromium: { launch: playwright.launch } }))

import * as VisualQa from '../../src/visual-qa.ts'
import { createHarness, createTestAgent } from '../helpers.ts'

interface FakeBrowserOptions {
  readonly screenshot?: Buffer
  readonly body?: string
  readonly title?: string
  readonly externalOnClick?: string
  readonly hangAt?: 'goto' | 'screenshot'
  readonly failAt?: 'context' | 'goto' | 'screenshot'
  readonly redirectAfterGoto?: string
  readonly urlAfterScreenshot?: string
  readonly afterScreenshot?: () => void
  readonly subrequestOnGoto?: string
  readonly webSocketOnGoto?: string
}

class FakeRoute {
  aborted = false
  continued = false

  constructor(readonly requestUrl: string) {}

  request(): { url(): string } {
    return { url: () => this.requestUrl }
  }

  abort(): Promise<void> {
    this.aborted = true
    return Promise.resolve()
  }

  continue(): Promise<void> {
    this.continued = true
    return Promise.resolve()
  }
}

class FakeWebSocketRoute {
  closed = false
  connected = false

  constructor(private readonly requestUrl: string) {}

  url(): string {
    return this.requestUrl
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  connectToServer(): WebSocketRoute {
    this.connected = true
    return this as unknown as WebSocketRoute
  }
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    readonly selector: string,
  ) {}

  click(): Promise<void> {
    this.page.actions.push(`click:${this.selector}`)
    return this.page.clicked()
  }

  fill(value: string): Promise<void> {
    this.page.actions.push(`fill:${this.selector}:${value}`)
    return Promise.resolve()
  }

  press(key: string): Promise<void> {
    this.page.actions.push(`press:${this.selector}:${key}`)
    return Promise.resolve()
  }

  waitFor(): Promise<void> {
    this.page.actions.push(`wait:${this.selector}`)
    return Promise.resolve()
  }

  textContent(): Promise<string | null> {
    return Promise.resolve(this.page.text.get(this.selector) ?? null)
  }

  innerText(): Promise<string> {
    return Promise.resolve(this.page.text.get(this.selector) ?? '')
  }
}

class FakePage {
  readonly actions: string[] = []
  readonly text: ReadonlyMap<string, string>
  currentUrl = 'about:blank'
  private pendingReject: ((error: Error) => void) | undefined

  constructor(
    private readonly context: FakeBrowserContext,
    private readonly options: FakeBrowserOptions,
  ) {
    const body = options.body ?? 'ready body'
    this.text = new Map([['body', body], ['#status', 'ready']])
  }

  locator(selector: string): Locator {
    return new FakeLocator(this, selector) as unknown as Locator
  }

  async goto(url: string): Promise<null> {
    if (this.options.failAt === 'goto') throw new Error('goto failed')
    if (this.options.hangAt === 'goto') {
      await new Promise<never>((_resolve, reject) => { this.pendingReject = reject })
    }
    await this.context.request(url)
    if (this.options.subrequestOnGoto !== undefined) await this.context.request(this.options.subrequestOnGoto)
    if (this.options.webSocketOnGoto !== undefined) await this.context.webSocket(this.options.webSocketOnGoto)
    this.currentUrl = this.options.redirectAfterGoto ?? url
    return null
  }

  url(): string {
    return this.currentUrl
  }

  title(): Promise<string> {
    return Promise.resolve(this.options.title ?? 'Visual QA')
  }

  async screenshot(): Promise<Buffer> {
    if (this.options.failAt === 'screenshot') throw new Error('screenshot failed')
    if (this.options.hangAt === 'screenshot') {
      await new Promise<never>((_resolve, reject) => { this.pendingReject = reject })
    }
    const result = this.options.screenshot ?? png(1, 1, 6, Buffer.from([10, 20, 30, 255]))
    if (this.options.urlAfterScreenshot !== undefined) this.currentUrl = this.options.urlAfterScreenshot
    this.options.afterScreenshot?.()
    return result
  }

  async clicked(): Promise<void> {
    if (this.options.externalOnClick !== undefined) {
      await this.context.request(this.options.externalOnClick)
      throw new Error('click request failed')
    }
  }

  closePending(): void {
    this.pendingReject?.(new Error('browser closed'))
    this.pendingReject = undefined
  }

  isPending(): boolean {
    return this.pendingReject !== undefined
  }
}

class FakeBrowserContext {
  readonly page: FakePage
  closed = 0
  private routeHandler: ((route: Route) => Promise<unknown> | unknown) | undefined
  private webSocketHandler: ((route: WebSocketRoute) => Promise<unknown> | unknown) | undefined

  constructor(options: FakeBrowserOptions) {
    this.page = new FakePage(this, options)
  }

  route(_pattern: string, handler: (route: Route) => Promise<unknown> | unknown): Promise<void> {
    this.routeHandler = handler
    return Promise.resolve()
  }

  newPage(): Promise<Page> {
    return Promise.resolve(this.page as unknown as Page)
  }

  routeWebSocket(
    _pattern: string,
    handler: (route: WebSocketRoute) => Promise<unknown> | unknown,
  ): Promise<void> {
    this.webSocketHandler = handler
    return Promise.resolve()
  }

  async request(url: string): Promise<void> {
    const route = new FakeRoute(url)
    await this.routeHandler?.(route as unknown as Route)
    if (route.aborted) throw new Error('request blocked')
    if (!route.continued) throw new Error('request was not routed')
  }

  async webSocket(url: string): Promise<void> {
    const route = new FakeWebSocketRoute(url)
    await this.webSocketHandler?.(route as unknown as WebSocketRoute)
    if (route.closed) throw new Error('WebSocket blocked')
    if (!route.connected) throw new Error('WebSocket was not routed')
  }

  close(): Promise<void> {
    this.closed += 1
    this.page.closePending()
    return Promise.resolve()
  }
}

class FakeBrowser {
  readonly context: FakeBrowserContext
  closed = 0

  constructor(
    options: FakeBrowserOptions = {},
    private readonly contextFailure = options.failAt === 'context',
  ) {
    this.context = new FakeBrowserContext(options)
  }

  newContext(): Promise<BrowserContext> {
    return this.contextFailure
      ? Promise.reject(new Error('context failed'))
      : Promise.resolve(this.context as unknown as BrowserContext)
  }

  close(): Promise<void> {
    this.closed += 1
    return this.context.close()
  }
}

const roots: string[] = []
let sequence = 0

beforeEach(() => {
  playwright.launch.mockReset()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function testPaeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft
  const distances = [Math.abs(prediction - left), Math.abs(prediction - above), Math.abs(prediction - upperLeft)]
  return distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
    ? left : distances[1]! <= distances[2]! ? above : upperLeft
}

function png(
  width: number,
  height: number,
  colorType: 0 | 2 | 4 | 6,
  pixels: Buffer,
  filters: readonly number[] = [0],
): Buffer {
  const bytesPerPixel = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  const rowBytes = width * bytesPerPixel
  const raw = Buffer.alloc(height * (rowBytes + 1))
  for (let row = 0; row < height; row += 1) {
    const filter = filters[row] ?? filters[0] ?? 0
    const inputOffset = row * rowBytes
    const outputOffset = row * (rowBytes + 1)
    raw[outputOffset] = filter
    for (let column = 0; column < rowBytes; column += 1) {
      const value = pixels[inputOffset + column]!
      const left = column < bytesPerPixel ? 0 : pixels[inputOffset + column - bytesPerPixel]!
      const above = row === 0 ? 0 : pixels[inputOffset + column - rowBytes]!
      const upperLeft = row === 0 || column < bytesPerPixel ? 0 : pixels[inputOffset + column - rowBytes - bytesPerPixel]!
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : testPaeth(left, above, upperLeft)
      raw[outputOffset + column + 1] = (value - predictor + 256) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-visual-test-'))
  roots.push(root)
  return root
}

async function assembled(
  browser: FakeBrowser,
  config: VisualQa.VisualQaConfig = { allowedOrigins: ['http://127.0.0.1:4173'] },
): Promise<{ readonly ctx: Context; readonly agent: Agent; readonly root: string; readonly fiber: Fiber }> {
  const root = await workspace()
  const harness = await createHarness({ cwd: root })
  await harness.ctx.plugin(LocalFileSystem, { cwd: root })
  playwright.launch.mockResolvedValue(browser as unknown as Browser)
  const fiber = await harness.ctx.plugin(VisualQa, config)
  const goal = harness.ctx.goals.create(harness.agent, { objective: 'verify the local UI' })
  await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
  return { ...harness, root, fiber }
}

function execute(ctx: Context, agent: Agent, args: unknown, signal = new AbortController().signal) {
  sequence += 1
  return ctx.tools.execute({
    callId: CallId(`visual-qa-${sequence}`),
    name: 'autopilot_visual_qa',
    arguments: args,
    agent,
    signal,
  })
}

function errorMessage(result: Awaited<ReturnType<typeof execute>>): string {
  if (!result.isError) throw new Error('expected tool failure')
  return result.error.message
}

describe('visual QA policy and PNG operations', () => {
  it('normalizes exact origins and rejects malformed or ambiguous deployment policy', () => {
    expect(VisualQa.normalizeAllowedOrigin('HTTP://LOCALHOST:80')).toBe('http://localhost')
    expect(() => VisualQa.normalizeAllowedOrigin('')).toThrow('1 through 2048')
    expect(() => VisualQa.normalizeAllowedOrigin('x')).toThrow('absolute URL')
    expect(() => VisualQa.normalizeAllowedOrigin('ftp://localhost')).toThrow('exact HTTP')
    expect(() => VisualQa.normalizeAllowedOrigin('http://u:p@localhost')).toThrow('exact HTTP')
    expect(() => VisualQa.normalizeAllowedOrigin('http://localhost/path')).toThrow('exact HTTP')
    expect(() => VisualQa.normalizeAllowedOrigin('http://localhost/?x=1')).toThrow('exact HTTP')
    expect(() => VisualQa.normalizeAllowedOrigin('http://localhost/#x')).toThrow('exact HTTP')
    expect(() => VisualQa.resolveVisualQaConfig({ channel: 'chromium', executablePath: '/browser' })).toThrow('mutually')
    expect(() => VisualQa.resolveVisualQaConfig({ executablePath: ' ' })).toThrow('must not be empty')
    expect(() => VisualQa.resolveVisualQaConfig({ allowedOrigins: [] })).toThrow('at least one')
    expect(() => VisualQa.resolveVisualQaConfig({ allowedOrigins: ['http://localhost', 'http://localhost:80'] })).toThrow('duplicated')
    expect(() => VisualQa.resolveVisualQaConfig({ maxSteps: 0 })).toThrow('maxSteps')
    expect(() => VisualQa.resolveVisualQaConfig({ timeoutMs: 0 })).toThrow('timeoutMs')
    expect(() => VisualQa.resolveVisualQaConfig({ stepTimeoutMs: 20, timeoutMs: 10 })).toThrow('cannot exceed')
    expect(() => VisualQa.resolveVisualQaConfig({ viewportWidth: 100 })).toThrow('viewportWidth')
    expect(() => VisualQa.resolveVisualQaConfig({ viewportHeight: 100 })).toThrow('viewportHeight')
    const resolved = VisualQa.resolveVisualQaConfig({ channel: 'chrome', allowedOrigins: ['https://example.test'] })
    expect(resolved.channel).toBe('chrome')
    expect(resolved.allowedOrigins).toEqual(new Set(['https://example.test']))
    expect(VisualQa.isAllowedVisualQaUrl('https://example.test/a', resolved.allowedOrigins)).toBe(true)
    expect(VisualQa.isAllowedVisualQaUrl('https://other.test/a', resolved.allowedOrigins)).toBe(false)
    expect(VisualQa.isAllowedVisualQaUrl('https://u@example.test/a', resolved.allowedOrigins)).toBe(false)
    expect(VisualQa.isAllowedVisualQaUrl('https://:p@example.test/a', resolved.allowedOrigins)).toBe(false)
    expect(VisualQa.isAllowedVisualQaUrl('wss://example.test/socket', resolved.allowedOrigins)).toBe(true)
    expect(VisualQa.isAllowedVisualQaUrl('ws://example.test/socket', resolved.allowedOrigins)).toBe(false)
    expect(VisualQa.isAllowedVisualQaUrl('data:text/plain,x', resolved.allowedOrigins)).toBe(false)
    expect(VisualQa.isAllowedVisualQaUrl('not a URL', resolved.allowedOrigins)).toBe(false)
  })

  it('decodes every supported color layout and PNG row filter', () => {
    const filters = [0, 1, 2, 3, 4]
    const rgbaPixels = Buffer.from(filters.flatMap((_, row) => [row, row + 1, row + 2, 255, row + 3, row + 4, row + 5, 128]))
    const decoded = VisualQa.decodeVisualQaPng(png(2, 5, 6, rgbaPixels, filters), 10)
    expect(decoded).toEqual({ width: 2, height: 5, rgba: rgbaPixels })
    expect(VisualQa.decodeVisualQaPng(png(1, 1, 0, Buffer.from([7])), 1).rgba)
      .toEqual(Buffer.from([7, 7, 7, 255]))
    expect(VisualQa.decodeVisualQaPng(png(1, 1, 2, Buffer.from([1, 2, 3])), 1).rgba)
      .toEqual(Buffer.from([1, 2, 3, 255]))
    expect(VisualQa.decodeVisualQaPng(png(1, 1, 4, Buffer.from([9, 10])), 1).rgba)
      .toEqual(Buffer.from([9, 9, 9, 10]))
    expect(VisualQa.decodeVisualQaPng(png(2, 2, 0, Buffer.from([0, 20, 0, 8]), [0, 4]), 4).rgba.length).toBe(16)
    expect(VisualQa.decodeVisualQaPng(png(2, 2, 0, Buffer.from([10, 20, 0, 8]), [0, 4]), 4).rgba.length).toBe(16)
  })

  it('compares exact pixels and reports dimension mismatches', () => {
    const first = png(2, 1, 6, Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]))
    const second = png(2, 1, 6, Buffer.from([1, 2, 3, 255, 7, 8, 9, 255]))
    expect(VisualQa.compareVisualQaPng(first, second, 10)).toMatchObject({
      dimensionsMatch: true,
      differentPixels: 1,
      pixelDiffRatio: 0.5,
    })
    expect(VisualQa.compareVisualQaPng(first, png(1, 1, 6, Buffer.from([1, 2, 3, 255])), 10))
      .toMatchObject({ dimensionsMatch: false, differentPixels: null, pixelDiffRatio: null })
  })

  it('rejects malformed, excessive, truncated, and unsupported PNG data', () => {
    expect(() => VisualQa.decodeVisualQaPng(Buffer.from('bad'), 1)).toThrow('signature')
    const valid = png(1, 1, 6, Buffer.from([1, 2, 3, 255]))
    const ancillary = Buffer.concat([
      valid.subarray(0, valid.length - 12), pngChunk('tEXt', Buffer.from('note')), valid.subarray(valid.length - 12),
    ])
    expect(VisualQa.decodeVisualQaPng(ancillary, 1).width).toBe(1)
    expect(() => VisualQa.decodeVisualQaPng(valid, 0)).toThrow('maxPixels')
    expect(() => VisualQa.decodeVisualQaPng(valid.subarray(0, valid.length - 2), 1)).toThrow('missing')
    const truncatedChunk = Buffer.from(valid)
    truncatedChunk.writeUInt32BE(0xfffffff0, 8)
    expect(() => VisualQa.decodeVisualQaPng(truncatedChunk, 1)).toThrow('truncated PNG chunk')
    const duplicateHeader = Buffer.concat([valid.subarray(0, 33), valid.subarray(8)])
    expect(() => VisualQa.decodeVisualQaPng(duplicateHeader, 1)).toThrow('invalid PNG header')
    const badDepth = Buffer.from(valid)
    badDepth[24] = 16
    expect(() => VisualQa.decodeVisualQaPng(badDepth, 1)).toThrow('non-interlaced')
    const badMethod = Buffer.from(valid)
    badMethod[26] = 1
    expect(() => VisualQa.decodeVisualQaPng(badMethod, 1)).toThrow('compression')
    const badFilterPng = png(1, 1, 6, Buffer.from([1, 2, 3, 255]), [5])
    expect(() => VisualQa.decodeVisualQaPng(badFilterPng, 1)).toThrow('row filter')
    const corrupt = Buffer.from(valid)
    const idat = corrupt.indexOf('IDAT')
    corrupt[idat + 5] = corrupt[idat + 5]! ^ 0xff
    expect(() => VisualQa.decodeVisualQaPng(corrupt, 1)).toThrow('inflated')
    const wrongLength = Buffer.from(valid)
    wrongLength.writeUInt32BE(2, 16)
    expect(() => VisualQa.decodeVisualQaPng(wrongLength, 2)).toThrow('stream length')
  })
})

describe('visual QA model tool', () => {
  it('runs every step, bounds the body, compares a workspace reference, and returns a path-free run receipt', async () => {
    const screenshot = png(1, 1, 6, Buffer.from([10, 20, 30, 255]))
    const browser = new FakeBrowser({ screenshot, body: 'ready body with additional text' })
    const harness = await assembled(browser, {
      allowedOrigins: ['http://127.0.0.1:4173'],
      executablePath: '/deployment/browser',
      maxBodyPreviewChars: 10,
    })
    await writeFile(join(harness.root, 'reference.png'), screenshot)
    const tempBefore = new Set((await readdir(tmpdir())).filter(name => name.startsWith('dsh-autopilot-visual-qa-')))

    const result = await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173/app',
      steps: [
        { action: 'wait', selector: '#status' },
        { action: 'fill', selector: '#name', value: 'Ada' },
        { action: 'press', selector: '#name', key: 'Enter' },
        { action: 'click', selector: '#submit' },
        { action: 'assert-text', selector: '#status', text: 'ready' },
        { action: 'assert-text', text: 'ready body' },
      ],
      referencePng: 'reference.png',
    })

    expect(result.isError).toBe(false)
    const value = result.value as unknown as VisualQa.VisualQaResult
    expect(value).toMatchObject({
      url: 'http://127.0.0.1:4173/app',
      title: 'Visual QA',
      bodyPreview: 'ready body…',
      bodyPreviewTruncated: true,
      comparison: { dimensionsMatch: true, differentPixels: 0, pixelDiffRatio: 0 },
      screenshot: {
        bytes: screenshot.length,
        width: 1,
        height: 1,
        owner: {
          sessionId: String(harness.agent.id),
          runId: harness.ctx.autonomy.get(harness.agent)!.id,
          runGeneration: harness.ctx.autonomy.get(harness.agent)!.generation,
        },
      },
    })
    expect(value.screenshot.id).toMatch(/^vqa-[a-f0-9]{64}$/u)
    expect(value.screenshot.sha256).toBe(createHash('sha256').update(screenshot).digest('hex'))
    expect(JSON.stringify(value)).not.toContain(tmpdir())
    expect(browser.context.page.actions).toEqual([
      'wait:#status', 'fill:#name:Ada', 'press:#name:Enter', 'click:#submit',
    ])
    expect(playwright.launch).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: '/deployment/browser', headless: true,
    }))
    expect(browser.closed).toBeGreaterThan(0)
    expect((await readdir(tmpdir())).filter(name => name.startsWith('dsh-autopilot-visual-qa-')))
      .toEqual([...tempBefore])
  })

  it('blocks initial origins, routed subrequests, and resulting cross-origin navigation', async () => {
    const initialBrowser = new FakeBrowser()
    const initial = await assembled(initialBrowser)
    const blockedInitial = await execute(initial.ctx, initial.agent, {
      url: 'https://example.com', steps: [],
    })
    expect(errorMessage(blockedInitial)).toContain('VISUAL_QA_ORIGIN_BLOCKED')
    expect(playwright.launch).not.toHaveBeenCalled()

    const requestBrowser = new FakeBrowser({ externalOnClick: 'https://example.com/tracker' })
    playwright.launch.mockResolvedValue(requestBrowser as unknown as Browser)
    const blockedRequest = await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [{ action: 'click', selector: '#external' }],
    })
    expect(errorMessage(blockedRequest)).toContain('https://example.com/tracker')

    const gotoRequestBrowser = new FakeBrowser({ subrequestOnGoto: 'https://example.com/script.js' })
    playwright.launch.mockResolvedValue(gotoRequestBrowser as unknown as Browser)
    const blockedGotoRequest = await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    expect(errorMessage(blockedGotoRequest)).toContain('https://example.com/script.js')

    const blockedSocketBrowser = new FakeBrowser({ webSocketOnGoto: 'wss://example.com/socket' })
    playwright.launch.mockResolvedValue(blockedSocketBrowser as unknown as Browser)
    const blockedSocket = await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    expect(errorMessage(blockedSocket)).toContain('wss://example.com/socket')

    const allowedSocketBrowser = new FakeBrowser({ webSocketOnGoto: 'ws://127.0.0.1:4173/socket' })
    playwright.launch.mockResolvedValue(allowedSocketBrowser as unknown as Browser)
    expect((await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })).isError).toBe(false)

    const navigationBrowser = new FakeBrowser()
    navigationBrowser.context.page.currentUrl = 'http://127.0.0.1:4173'
    const originalClick = navigationBrowser.context.page.clicked.bind(navigationBrowser.context.page)
    navigationBrowser.context.page.clicked = async () => {
      await originalClick()
      navigationBrowser.context.page.currentUrl = 'https://example.com/escaped'
    }
    playwright.launch.mockResolvedValue(navigationBrowser as unknown as Browser)
    const blockedNavigation = await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [{ action: 'click', selector: '#nav' }],
    })
    expect(errorMessage(blockedNavigation)).toContain('blocked origin')

    const redirectBrowser = new FakeBrowser({ redirectAfterGoto: 'https://example.com/redirect' })
    playwright.launch.mockResolvedValue(redirectBrowser as unknown as Browser)
    const blockedRedirect = await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    expect(errorMessage(blockedRedirect)).toContain('redirect')

    const lateBrowser = new FakeBrowser({ urlAfterScreenshot: 'https://example.com/late' })
    playwright.launch.mockResolvedValue(lateBrowser as unknown as Browser)
    const blockedLate = await execute(initial.ctx, initial.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    expect(errorMessage(blockedLate)).toContain('late')
  })

  it('rejects unauthorized, malformed, excessive, and failed assertions', async () => {
    const root = await workspace()
    const unauthorizedHarness = await createHarness({ cwd: root })
    await unauthorizedHarness.ctx.plugin(LocalFileSystem, { cwd: root })
    const browser = new FakeBrowser()
    playwright.launch.mockResolvedValue(browser as unknown as Browser)
    await unauthorizedHarness.ctx.plugin(VisualQa, { allowedOrigins: ['http://127.0.0.1:4173'], maxSteps: 1 })
    expect(errorMessage(await execute(unauthorizedHarness.ctx, unauthorizedHarness.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('UNAUTHORIZED')

    const harness = await assembled(browser, { allowedOrigins: ['http://127.0.0.1:4173'], maxSteps: 1 })
    expect(errorMessage(await execute(harness.ctx, createTestAgent('workspace-less'), {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('workspace-backed')
    expect(errorMessage(await execute(harness.ctx, harness.agent, { url: 'x', steps: [] }))).toContain('absolute')
    expect(errorMessage(await execute(harness.ctx, harness.agent, { url: '', steps: [] }))).toContain('1 through')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'ftp://127.0.0.1:4173', steps: [],
    }))).toContain('HTTP(S)')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [{ action: 'click' }],
    }))).toContain('step selector')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [{ action: 'click', selector: '#a' }, { action: 'wait', selector: '#b' }],
    }))).toContain('maxSteps')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [{ action: 'assert-text', text: 'missing' }],
    }))).toContain('ASSERTION_FAILED')

    const successful = new FakeBrowser({ body: 'short' })
    playwright.launch.mockResolvedValue(successful as unknown as Browser)
    const noReference = await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    expect(noReference.isError).toBe(false)
    expect(noReference.value).toMatchObject({ bodyPreview: 'short', bodyPreviewTruncated: false })
    expect(noReference.value).not.toHaveProperty('comparison')

    const channelBrowser = new FakeBrowser()
    const channel = await assembled(channelBrowser, {
      allowedOrigins: ['http://127.0.0.1:4173'], channel: 'chromium',
    })
    expect((await execute(channel.ctx, channel.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })).isError).toBe(false)
    expect(playwright.launch).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'chromium' }))
  })

  it('contains reference reads to the workspace and reports invalid references', async () => {
    const browser = new FakeBrowser()
    const harness = await assembled(browser)
    const outside = join(tmpdir(), `visual-outside-${Date.now()}.png`)
    roots.push(outside)
    await writeFile(outside, png(1, 1, 6, Buffer.from([1, 2, 3, 255])))
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: outside,
    }))).toContain('relative workspace path')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: '../outside.png',
    }))).toContain('relative workspace path')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: 'C:\\outside.png',
    }))).toContain('relative workspace path')
    await symlink(outside, join(harness.root, 'linked-outside.png'))
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: 'linked-outside.png',
    }))).toContain('inside the Agent workspace')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: 'missing.png',
    }))).toContain('existing regular')

    const screenshot = png(1, 1, 6, Buffer.from([10, 20, 30, 255]))
    await writeFile(join(harness.root, 'large.png'), Buffer.concat([screenshot, Buffer.from([0])]))
    const smallLimitBrowser = new FakeBrowser({ screenshot })
    const smallLimit = await assembled(smallLimitBrowser, {
      allowedOrigins: ['http://127.0.0.1:4173'], maxPngBytes: screenshot.length,
    })
    await writeFile(join(smallLimit.root, 'large.png'), Buffer.concat([screenshot, Buffer.from([0])]))
    expect(errorMessage(await execute(smallLimit.ctx, smallLimit.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: 'large.png',
    }))).toContain('exceeds maxPngBytes')

    await writeFile(join(harness.root, 'changing.png'), screenshot)
    const originalStat = harness.ctx.fs.stat.bind(harness.ctx.fs)
    let referenceStats = 0
    vi.spyOn(harness.ctx.fs, 'stat').mockImplementation(async (...args) => {
      const info = await originalStat(...args)
      referenceStats += 1
      return referenceStats === 2 && info !== undefined
        ? { ...info, version: `${String(info.version)}-changed` as typeof info.version }
        : info
    })
    playwright.launch.mockResolvedValue(new FakeBrowser({ screenshot }) as unknown as Browser)
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [], referencePng: 'changing.png',
    }))).toContain('changed while')
  })

  it('classifies launch, context, page, screenshot, and PNG failures and always closes resources', async () => {
    const browser = new FakeBrowser({ failAt: 'context' })
    const harness = await assembled(browser)
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('BROWSER_FAILED')
    expect(browser.closed).toBeGreaterThan(0)

    playwright.launch.mockRejectedValue(new Error('launch failed'))
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('launch failed')

    for (const failing of [new FakeBrowser({ failAt: 'goto' }), new FakeBrowser({ failAt: 'screenshot' })]) {
      playwright.launch.mockResolvedValue(failing as unknown as Browser)
      expect(errorMessage(await execute(harness.ctx, harness.agent, {
        url: 'http://127.0.0.1:4173', steps: [],
      }))).toContain('BROWSER_FAILED')
      expect(failing.closed).toBeGreaterThan(0)
    }

    const badPng = new FakeBrowser({ screenshot: Buffer.from('not png') })
    playwright.launch.mockResolvedValue(badPng as unknown as Browser)
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('PNG_INVALID')

    const oversized = new FakeBrowser({ screenshot: Buffer.alloc(100) })
    const limited = await assembled(oversized, {
      allowedOrigins: ['http://127.0.0.1:4173'], maxPngBytes: 99,
    })
    expect(errorMessage(await execute(limited.ctx, limited.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('exceeds maxPngBytes')

    playwright.launch.mockRejectedValue('non-error rejection')
    expect(errorMessage(await execute(harness.ctx, harness.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('browser operation failed')

    let ownershipChanged = false
    const changedBrowser = new FakeBrowser({ afterScreenshot: () => { ownershipChanged = true } })
    const changed = await assembled(changedBrowser)
    const originalGet = changed.ctx.autonomy.get.bind(changed.ctx.autonomy)
    const getSpy = vi.spyOn(changed.ctx.autonomy, 'get').mockImplementation(agent => {
      return ownershipChanged ? undefined : originalGet(agent)
    })
    expect(errorMessage(await execute(changed.ctx, changed.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }))).toContain('ownership changed')
    getSpy.mockRestore()

  })

  it('aborts on caller cancellation, total timeout, Autopilot termination, and HMR disposal', async () => {
    const callerBrowser = new FakeBrowser({ hangAt: 'goto' })
    const caller = await assembled(callerBrowser)
    const controller = new AbortController()
    const callerResult = execute(caller.ctx, caller.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }, controller.signal)
    await vi.waitFor(() => { expect(callerBrowser.context.page.isPending()).toBe(true) })
    await caller.ctx.parallel('autonomy/changed', {
      agent: createTestAgent('other-agent'),
      operation: 'pause',
      view: caller.ctx.autonomy.get(caller.agent)!,
    })
    controller.abort(new Error('caller stopped'))
    expect(errorMessage(await callerResult)).toContain('VISUAL_QA_ABORTED')
    expect(callerBrowser.closed).toBeGreaterThan(0)

    const timeoutBrowser = new FakeBrowser({ hangAt: 'goto' })
    const timeout = await assembled(timeoutBrowser, {
      allowedOrigins: ['http://localhost:4173'], timeoutMs: 5, stepTimeoutMs: 5,
    })
    const timeoutResult = await execute(timeout.ctx, timeout.agent, {
      url: 'http://localhost:4173', steps: [],
    })
    expect(errorMessage(timeoutResult)).toContain('VISUAL_QA_TIMEOUT')

    const terminalBrowser = new FakeBrowser({ hangAt: 'goto' })
    const terminal = await assembled(terminalBrowser)
    const terminalResult = execute(terminal.ctx, terminal.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    await vi.waitFor(() => { expect(terminalBrowser.context.page.isPending()).toBe(true) })
    await terminal.ctx.autonomy.pause(terminal.agent, 'operator stopped')
    expect(errorMessage(await terminalResult)).toContain('VISUAL_QA_ABORTED')

    const hmrBrowser = new FakeBrowser({ hangAt: 'goto' })
    const hmr = await assembled(hmrBrowser)
    const hmrResult = execute(hmr.ctx, hmr.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    })
    await vi.waitFor(() => { expect(hmrBrowser.context.page.isPending()).toBe(true) })
    await hmr.fiber.dispose()
    expect(errorMessage(await hmrResult)).toContain('VISUAL_QA_ABORTED')
    expect(hmrBrowser.closed).toBeGreaterThan(0)

    const lateBrowser = new FakeBrowser()
    const late = await assembled(lateBrowser)
    const lateController = new AbortController()
    let resolveLaunch!: (browser: Browser) => void
    playwright.launch.mockReturnValue(new Promise<Browser>(resolve => { resolveLaunch = resolve }))
    const launchCalls = playwright.launch.mock.calls.length
    const lateResult = execute(late.ctx, late.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }, lateController.signal)
    await vi.waitFor(() => { expect(playwright.launch.mock.calls.length).toBeGreaterThan(launchCalls) })
    lateController.abort('stopped')
    expect(errorMessage(await lateResult)).toContain('browser verification was aborted')
    resolveLaunch(lateBrowser as unknown as Browser)
    await vi.waitFor(() => { expect(lateBrowser.closed).toBeGreaterThan(0) })

    const preAbortedBrowser = new FakeBrowser()
    const preAborted = await assembled(preAbortedBrowser)
    const preAbortedController = new AbortController()
    playwright.launch.mockImplementation(() => {
      preAbortedController.abort('pre-aborted launch')
      return Promise.resolve(preAbortedBrowser as unknown as Browser)
    })
    expect(errorMessage(await execute(preAborted.ctx, preAborted.agent, {
      url: 'http://127.0.0.1:4173', steps: [],
    }, preAbortedController.signal))).toContain('browser verification was aborted')
  })
})
