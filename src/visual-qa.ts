/** Bounded Host-browser verification with exact Autopilot provenance. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { registerRecoveryContribution } from './recovery-coordinator.ts'
import type { AutonomyLeaseView } from './service.ts'

export const name = 'dsh-autopilot-visual-qa'
export const inject = ['autonomy', 'fs', 'goals', 'tools']

/** Local origins used until a deployment supplies an explicit exact allowlist. */
export const DEFAULT_VISUAL_QA_ORIGINS: readonly string[] = Object.freeze([
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://localhost',
  'https://localhost',
])

const MAX_STEPS = 128
const MAX_TIMEOUT_MS = 300_000
const MAX_STEP_TIMEOUT_MS = 60_000
const MAX_PREVIEW_CHARS = 100_000
const MAX_PNG_BYTES = 50 * 1024 * 1024
const MAX_PIXELS = 50_000_000

/** Deployment-fixed browser binary, request policy, and resource ceilings. */
export interface VisualQaConfig {
  readonly channel?: 'chromium' | 'chrome' | 'chrome-beta' | 'chrome-dev' | 'chrome-canary' | 'msedge' | 'msedge-beta' | 'msedge-dev' | 'msedge-canary'
  readonly executablePath?: string
  readonly allowedOrigins?: string[]
  readonly maxSteps?: number
  readonly timeoutMs?: number
  readonly stepTimeoutMs?: number
  readonly maxBodyPreviewChars?: number
  readonly maxPngBytes?: number
  readonly maxPixels?: number
  readonly viewportWidth?: number
  readonly viewportHeight?: number
}

interface ResolvedVisualQaConfig {
  readonly channel?: VisualQaConfig['channel']
  readonly executablePath?: string
  readonly allowedOrigins: ReadonlySet<string>
  readonly maxSteps: number
  readonly timeoutMs: number
  readonly stepTimeoutMs: number
  readonly maxBodyPreviewChars: number
  readonly maxPngBytes: number
  readonly maxPixels: number
  readonly viewportWidth: number
  readonly viewportHeight: number
}

/** One supported deterministic page operation after the initial navigation. */
export type VisualQaStep =
  | { readonly action: 'click'; readonly selector: string }
  | { readonly action: 'fill'; readonly selector: string; readonly value: string }
  | { readonly action: 'press'; readonly selector: string; readonly key: string }
  | { readonly action: 'wait'; readonly selector: string }
  | { readonly action: 'assert-text'; readonly selector?: string; readonly text: string }

/** One successful text assertion retained in a Visual QA result. */
export interface VisualQaAssertion {
  readonly selector: string
  readonly text: string
  readonly passed: true
}

/** Exact Autopilot generation owning a screenshot receipt. */
export interface VisualQaRunIdentity {
  readonly sessionId: string
  readonly runId: string
  readonly runGeneration: number
  readonly goalId: string
  readonly revisionAtStart: number
}

/** Host-temporary screenshot receipt without a Host path. */
export interface VisualQaScreenshotReceipt {
  readonly id: string
  readonly owner: VisualQaRunIdentity
  readonly completedRevision: number
  readonly sha256: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/** Pixel and dimension comparison against one workspace PNG. */
export interface VisualQaComparison {
  readonly referencePng: string
  readonly referenceSha256: string
  readonly dimensionsMatch: boolean
  readonly actualWidth: number
  readonly actualHeight: number
  readonly referenceWidth: number
  readonly referenceHeight: number
  readonly differentPixels: number | null
  readonly pixelDiffRatio: number | null
}

/** Successful bounded browser-verification result. */
export interface VisualQaResult {
  readonly url: string
  readonly title: string
  readonly assertions: readonly VisualQaAssertion[]
  readonly bodyPreview: string
  readonly bodyPreviewTruncated: boolean
  readonly screenshot: VisualQaScreenshotReceipt
  readonly comparison?: VisualQaComparison
}

/** Stable browser-verification failure with a model-visible code prefix. */
export class VisualQaError extends Error {
  /** Machine-readable failure classification. */
  readonly code:
    | 'VISUAL_QA_INVALID'
    | 'VISUAL_QA_UNAUTHORIZED'
    | 'VISUAL_QA_ORIGIN_BLOCKED'
    | 'VISUAL_QA_TIMEOUT'
    | 'VISUAL_QA_ABORTED'
    | 'VISUAL_QA_BROWSER_FAILED'
    | 'VISUAL_QA_ASSERTION_FAILED'
    | 'VISUAL_QA_PNG_INVALID'

  /**
   * @param message - Actionable non-secret failure detail.
   * @param code - Stable failure classification.
   */
  constructor(message: string, code: VisualQaError['code']) {
    super(`[${code}] ${message}`)
    this.name = 'VisualQaError'
    this.code = code
  }
}

interface PngImage {
  readonly width: number
  readonly height: number
  readonly rgba: Buffer
}

interface ActiveVisualQaRun {
  readonly agent: Agent
  readonly identity: VisualQaRunIdentity
  readonly abort: AbortController
  readonly settled: Promise<void>
  settle(): void
  browser?: Browser
  browserContext?: BrowserContext
  readonly tempRoot: string
  closeTask?: Promise<void>
}

/** Cordis configuration schema for the bounded Host browser. */
export const Config: s<VisualQaConfig> = s.object({
  channel: s.union([
    'chromium', 'chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary',
    'msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary',
  ] as const),
  executablePath: s.string(),
  allowedOrigins: s.array(s.string()).default([...DEFAULT_VISUAL_QA_ORIGINS]),
  maxSteps: s.number().step(1).min(1).max(MAX_STEPS).default(32),
  timeoutMs: s.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(30_000),
  stepTimeoutMs: s.number().step(1).min(1).max(MAX_STEP_TIMEOUT_MS).default(10_000),
  maxBodyPreviewChars: s.number().step(1).min(1).max(MAX_PREVIEW_CHARS).default(5_000),
  maxPngBytes: s.number().step(1).min(1).max(MAX_PNG_BYTES).default(10 * 1024 * 1024),
  maxPixels: s.number().step(1).min(1).max(MAX_PIXELS).default(16_000_000),
  viewportWidth: s.number().step(1).min(320).max(7_680).default(1_440),
  viewportHeight: s.number().step(1).min(240).max(4_320).default(900),
})

function configuredInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
  minimum = 1,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${field} must be a safe integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

/** Normalize one deployment allowlist member into an exact HTTP(S) origin. */
export function normalizeAllowedOrigin(value: string): string {
  if (value.length === 0 || value.length > 2_048) throw new TypeError('allowed origin must contain 1 through 2048 characters')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`allowed origin ${JSON.stringify(value)} is not an absolute URL`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0
    || url.username.length > 0 || url.password.length > 0 || url.pathname !== '/'
    || url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError(`allowed origin ${JSON.stringify(value)} must be an exact HTTP(S) origin`)
  }
  return url.origin
}

/** Resolve and freeze deployment configuration before registering the tool. */
export function resolveVisualQaConfig(config: VisualQaConfig): ResolvedVisualQaConfig {
  if (config.channel !== undefined && config.executablePath !== undefined) {
    throw new TypeError('channel and executablePath are mutually exclusive deployment settings')
  }
  if (config.executablePath !== undefined && config.executablePath.trim().length === 0) {
    throw new TypeError('executablePath must not be empty')
  }
  const allowed = config.allowedOrigins ?? DEFAULT_VISUAL_QA_ORIGINS
  if (allowed.length === 0) throw new TypeError('allowedOrigins must contain at least one exact origin')
  const allowedOrigins = new Set<string>()
  for (const item of allowed) {
    const origin = normalizeAllowedOrigin(item)
    if (allowedOrigins.has(origin)) throw new TypeError(`allowed origin ${JSON.stringify(origin)} is duplicated`)
    allowedOrigins.add(origin)
  }
  const timeoutMs = configuredInteger(config.timeoutMs, 30_000, 'timeoutMs', MAX_TIMEOUT_MS)
  const stepTimeoutMs = configuredInteger(config.stepTimeoutMs, 10_000, 'stepTimeoutMs', MAX_STEP_TIMEOUT_MS)
  if (stepTimeoutMs > timeoutMs) throw new TypeError('stepTimeoutMs cannot exceed timeoutMs')
  return Object.freeze({
    ...(config.channel === undefined ? {} : { channel: config.channel }),
    ...(config.executablePath === undefined ? {} : { executablePath: config.executablePath }),
    allowedOrigins,
    maxSteps: configuredInteger(config.maxSteps, 32, 'maxSteps', MAX_STEPS),
    timeoutMs,
    stepTimeoutMs,
    maxBodyPreviewChars: configuredInteger(
      config.maxBodyPreviewChars, 5_000, 'maxBodyPreviewChars', MAX_PREVIEW_CHARS,
    ),
    maxPngBytes: configuredInteger(config.maxPngBytes, 10 * 1024 * 1024, 'maxPngBytes', MAX_PNG_BYTES),
    maxPixels: configuredInteger(config.maxPixels, 16_000_000, 'maxPixels', MAX_PIXELS),
    viewportWidth: configuredInteger(config.viewportWidth, 1_440, 'viewportWidth', 7_680, 320),
    viewportHeight: configuredInteger(config.viewportHeight, 900, 'viewportHeight', 4_320, 240),
  })
}

function parseHttpUrl(value: string, label: string): URL {
  if (value.length === 0 || value.length > 2_048) {
    throw new VisualQaError(`${label} must contain 1 through 2048 characters`, 'VISUAL_QA_INVALID')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new VisualQaError(`${label} must be an absolute HTTP(S) URL`, 'VISUAL_QA_INVALID')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0
    || url.username.length > 0 || url.password.length > 0) {
    throw new VisualQaError(`${label} must be an absolute HTTP(S) URL without userinfo`, 'VISUAL_QA_INVALID')
  }
  return url
}

/** Return whether an HTTP(S) or mapped WebSocket request belongs to the exact deployment origin allowlist. */
export function isAllowedVisualQaUrl(value: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value)
    if (url.username.length > 0 || url.password.length > 0) return false
    if (url.protocol === 'http:' || url.protocol === 'https:') return allowedOrigins.has(url.origin)
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      const mappedProtocol = url.protocol === 'ws:' ? 'http:' : 'https:'
      return allowedOrigins.has(`${mappedProtocol}//${url.host}`)
    }
    return false
  } catch {
    return false
  }
}

function requireRun(ctx: Context, agent: Agent): { readonly lease: AutonomyLeaseView; readonly identity: VisualQaRunIdentity } {
  const lease = ctx.autonomy.get(agent)
  const goal = ctx.goals.get(agent)
  if (lease === undefined || goal === undefined || String(goal.id) !== String(lease.goalId)
    || lease.activation !== 'armed' || lease.phase !== 'running'
    || goal.activation !== 'armed' || goal.phase !== 'active') {
    throw new VisualQaError(
      'browser verification requires the exact armed Autopilot Goal and run',
      'VISUAL_QA_UNAUTHORIZED',
    )
  }
  return {
    lease,
    identity: Object.freeze({
      sessionId: String(agent.id),
      runId: lease.id,
      runGeneration: lease.generation,
      goalId: String(lease.goalId),
      revisionAtStart: lease.revision,
    }),
  }
}

function sameRun(identity: VisualQaRunIdentity, lease: AutonomyLeaseView | undefined): lease is AutonomyLeaseView {
  return lease !== undefined && lease.id === identity.runId && lease.generation === identity.runGeneration
    && String(lease.goalId) === identity.goalId && lease.activation === 'armed' && lease.phase === 'running'
}

function requireSameRun(ctx: Context, agent: Agent, identity: VisualQaRunIdentity): AutonomyLeaseView {
  const lease = ctx.autonomy.get(agent)
  const goal = ctx.goals.get(agent)
  if (!sameRun(identity, lease) || goal === undefined || String(goal.id) !== identity.goalId
    || goal.activation !== 'armed' || goal.phase !== 'active') {
    throw new VisualQaError('Autopilot ownership changed during browser verification', 'VISUAL_QA_UNAUTHORIZED')
  }
  return lease
}

function boundedText(value: string | undefined, field: string, maximum: number): string {
  if (value === undefined || value.trim().length === 0 || value.length > maximum) {
    throw new VisualQaError(`${field} must contain 1 through ${maximum} characters`, 'VISUAL_QA_INVALID')
  }
  return value
}

function normalizeSteps(input: readonly {
  readonly action: VisualQaStep['action']
  readonly selector?: string
  readonly value?: string
  readonly key?: string
  readonly text?: string
}[], maxSteps: number): readonly VisualQaStep[] {
  if (input.length > maxSteps) {
    throw new VisualQaError(`steps exceed deployment maxSteps=${maxSteps}`, 'VISUAL_QA_INVALID')
  }
  return Object.freeze(input.map((step): VisualQaStep => {
    if (step.action === 'click' || step.action === 'wait') {
      return Object.freeze({ action: step.action, selector: boundedText(step.selector, 'step selector', 2_000) })
    }
    if (step.action === 'fill') {
      return Object.freeze({
        action: step.action,
        selector: boundedText(step.selector, 'step selector', 2_000),
        value: boundedText(step.value, 'fill value', 32_000),
      })
    }
    if (step.action === 'press') {
      return Object.freeze({
        action: step.action,
        selector: boundedText(step.selector, 'step selector', 2_000),
        key: boundedText(step.key, 'press key', 128),
      })
    }
    return Object.freeze({
      action: step.action,
      ...(step.selector === undefined ? {} : { selector: boundedText(step.selector, 'step selector', 2_000) }),
      text: boundedText(step.text, 'assertion text', 32_000),
    })
  }))
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const aboveDistance = Math.abs(prediction - above)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft
}

function pngFailure(message: string): never {
  throw new VisualQaError(message, 'VISUAL_QA_PNG_INVALID')
}

/** Decode bounded, non-interlaced 8-bit PNG pixels without reading Host paths. */
export function decodeVisualQaPng(bytes: Uint8Array, maxPixels: number): PngImage {
  const buffer = Buffer.from(bytes)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.length < signature.length || !buffer.subarray(0, 8).equals(signature)) pngFailure('invalid PNG signature')
  let cursor = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = -1
  let interlace = -1
  const compressed: Buffer[] = []
  let sawHeader = false
  let sawEnd = false
  while (cursor + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor)
    const dataStart = cursor + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) pngFailure('truncated PNG chunk')
    const type = buffer.toString('ascii', cursor + 4, cursor + 8)
    const data = buffer.subarray(dataStart, dataEnd)
    cursor = dataEnd + 4
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) pngFailure('invalid PNG header')
      sawHeader = true
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      if (data[10] !== 0 || data[11] !== 0) pngFailure('unsupported PNG compression or filter method')
      interlace = data[12]!
    } else if (type === 'IDAT') {
      compressed.push(data)
    /* v8 ignore next -- V8 attributes the terminating break as an implicit alternate. */
    } else if (type === 'IEND') {
      sawEnd = true
      break
    }
  }
  if (!sawHeader || !sawEnd || compressed.length === 0) pngFailure('PNG is missing IHDR, IDAT, or IEND')
  if (width < 1 || height < 1 || width * height > maxPixels) pngFailure(`PNG exceeds maxPixels=${maxPixels}`)
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
    pngFailure('PNG comparison supports non-interlaced 8-bit grayscale, RGB, grayscale-alpha, or RGBA')
  }
  const bytesPerPixel = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  const rowBytes = width * bytesPerPixel
  const expectedLength = height * (rowBytes + 1)
  let inflated: Buffer
  try {
    inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedLength + 1 })
  } catch {
    pngFailure('PNG pixel stream cannot be inflated within its declared dimensions')
  }
  if (inflated.length !== expectedLength) pngFailure('PNG pixel stream length does not match its dimensions')
  const unfiltered = Buffer.alloc(rowBytes * height)
  for (let row = 0; row < height; row += 1) {
    const inputOffset = row * (rowBytes + 1)
    const outputOffset = row * rowBytes
    const filter = inflated[inputOffset]!
    if (filter > 4) pngFailure(`unsupported PNG row filter ${filter}`)
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = inflated[inputOffset + column + 1]!
      const left = column < bytesPerPixel ? 0 : unfiltered[outputOffset + column - bytesPerPixel]!
      const above = row === 0 ? 0 : unfiltered[outputOffset + column - rowBytes]!
      const upperLeft = row === 0 || column < bytesPerPixel
        ? 0 : unfiltered[outputOffset + column - rowBytes - bytesPerPixel]!
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : paeth(left, above, upperLeft)
      unfiltered[outputOffset + column] = (raw + predictor) & 0xff
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * bytesPerPixel
    const target = pixel * 4
    if (colorType === 0 || colorType === 4) {
      rgba[target] = unfiltered[source]!
      rgba[target + 1] = unfiltered[source]!
      rgba[target + 2] = unfiltered[source]!
    } else {
      rgba[target] = unfiltered[source]!
      rgba[target + 1] = unfiltered[source + 1]!
      rgba[target + 2] = unfiltered[source + 2]!
    }
    rgba[target + 3] = colorType === 4 ? unfiltered[source + 1]!
      : colorType === 6 ? unfiltered[source + 3]! : 255
  }
  return Object.freeze({ width, height, rgba })
}

/** Compare decoded PNG dimensions and exact RGBA pixels. */
export function compareVisualQaPng(actualBytes: Uint8Array, referenceBytes: Uint8Array, maxPixels: number): Omit<VisualQaComparison, 'referencePng' | 'referenceSha256'> {
  const actual = decodeVisualQaPng(actualBytes, maxPixels)
  const reference = decodeVisualQaPng(referenceBytes, maxPixels)
  const dimensionsMatch = actual.width === reference.width && actual.height === reference.height
  let differentPixels: number | null = null
  let pixelDiffRatio: number | null = null
  if (dimensionsMatch) {
    differentPixels = 0
    for (let offset = 0; offset < actual.rgba.length; offset += 4) {
      if (actual.rgba[offset] !== reference.rgba[offset]
        || actual.rgba[offset + 1] !== reference.rgba[offset + 1]
        || actual.rgba[offset + 2] !== reference.rgba[offset + 2]
        || actual.rgba[offset + 3] !== reference.rgba[offset + 3]) differentPixels += 1
    }
    pixelDiffRatio = differentPixels / (actual.width * actual.height)
  }
  return Object.freeze({
    dimensionsMatch,
    actualWidth: actual.width,
    actualHeight: actual.height,
    referenceWidth: reference.width,
    referenceHeight: reference.height,
    differentPixels,
    pixelDiffRatio,
  })
}

async function workspaceReference(
  ctx: Context,
  exec: ToolRunContext,
  path: string,
  maxPngBytes: number,
): Promise<Buffer> {
  const agent = exec.agent
  const cwd = agent?.session.header.cwd
  /* v8 ignore next 3 -- the public tool rejects both conditions before this contained-read helper. */
  if (agent === undefined || cwd === undefined) {
    throw new VisualQaError('reference PNG requires a workspace-backed Agent', 'VISUAL_QA_INVALID')
  }
  if (path.length === 0 || path.includes('\u0000') || path.startsWith('/') || path.startsWith('\\')
    || /^[A-Za-z]:[\\/]/u.test(path) || path.split(/[\\/]/u).includes('..')) {
    throw new VisualQaError('reference PNG must be a relative workspace path without parent traversal', 'VISUAL_QA_INVALID')
  }
  const workspace = await ctx.fs.resolve('.', { cwd, signal: exec.signal })
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal })
  if (!ctx.fs.contains(workspace, target)) {
    throw new VisualQaError('reference PNG must resolve inside the Agent workspace', 'VISUAL_QA_INVALID')
  }
  const before = await ctx.fs.stat(target, exec.signal)
  if (before === undefined || before.type !== 'file') {
    throw new VisualQaError('reference PNG must be an existing regular workspace file', 'VISUAL_QA_INVALID')
  }
  if (before.size !== undefined && before.size > maxPngBytes) {
    throw new VisualQaError(`reference PNG exceeds maxPngBytes=${maxPngBytes}`, 'VISUAL_QA_INVALID')
  }
  const bytes = Buffer.from(await ctx.fs.readBytes(target, exec.signal, maxPngBytes))
  const after = await ctx.fs.stat(target, exec.signal)
  if (after === undefined || after.type !== 'file' || after.version !== before.version) {
    throw new VisualQaError('reference PNG changed while it was being read', 'VISUAL_QA_INVALID')
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec)
  return bytes
}

function abortError(signal: AbortSignal, timedOut: boolean): VisualQaError {
  return timedOut
    ? new VisualQaError('browser verification exceeded its total timeout', 'VISUAL_QA_TIMEOUT')
    : new VisualQaError(
      signal.reason instanceof Error ? signal.reason.message : 'browser verification was aborted',
      'VISUAL_QA_ABORTED',
    )
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) throw abortError(signal, timedOut())
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError(signal, timedOut()))
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}

async function closeActive(active: ActiveVisualQaRun): Promise<void> {
  if (active.closeTask !== undefined) return active.closeTask
  active.closeTask = (async () => {
    const closes: Promise<unknown>[] = []
    if (active.browserContext !== undefined) closes.push(active.browserContext.close())
    if (active.browser !== undefined) closes.push(active.browser.close())
    await Promise.allSettled(closes)
    await rm(active.tempRoot, { recursive: true, force: true })
  })()
  await active.closeTask
}

function createActive(agent: Agent, identity: VisualQaRunIdentity, tempRoot: string): ActiveVisualQaRun {
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  return { agent, identity, tempRoot, abort: new AbortController(), settled, settle }
}

async function executeStep(
  page: Page,
  step: VisualQaStep,
  timeout: number,
  assertions: VisualQaAssertion[],
): Promise<void> {
  if (step.action === 'click') {
    await page.locator(step.selector).click({ timeout })
    return
  }
  if (step.action === 'fill') {
    await page.locator(step.selector).fill(step.value, { timeout })
    return
  }
  if (step.action === 'press') {
    await page.locator(step.selector).press(step.key, { timeout })
    return
  }
  const selector = step.selector ?? 'body'
  const locator = page.locator(selector)
  if (step.action === 'wait') {
    await locator.waitFor({ state: 'visible', timeout })
    return
  }
  const content = await locator.textContent({ timeout })
  if (content === null || !content.includes(step.text)) {
    throw new VisualQaError(
      `expected ${JSON.stringify(selector)} to contain ${JSON.stringify(step.text)}`,
      'VISUAL_QA_ASSERTION_FAILED',
    )
  }
  assertions.push(Object.freeze({ selector, text: step.text, passed: true }))
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Register one request-contained browser QA tool. This is request filtering, not network isolation. */
export function apply(ctx: Context, config: VisualQaConfig = {}): void {
  const resolved = resolveVisualQaConfig(config)
  const activeRuns = new Set<ActiveVisualQaRun>()
  let disposed = false

  ctx.on('autonomy/changed', ({ agent, view }) => {
    for (const active of activeRuns) {
      if (active.agent === agent && !sameRun(active.identity, view)) {
        active.abort.abort(new Error('Autopilot run changed during browser verification'))
      }
    }
  })

  ctx.effect(() => async () => {
    disposed = true
    const draining = [...activeRuns]
    for (const active of draining) active.abort.abort(new Error('Visual QA plugin disposed'))
    await Promise.all(draining.map(active => active.settled))
  }, 'dsh-autopilot.visualQaCleanup')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_visual_qa',
    description: 'Run one bounded Chromium UI verification under the exact armed Autopilot run. Deployment-fixed exact origins gate initial navigation and every routed request. Screenshots exist only in a Host temporary directory and the result exposes a run-bound receipt, never a Host path. Optional referencePng reads only a contained workspace PNG through DSH fs. This request policy is not network isolation.',
    parameters: {
      url: { type: 'string', required: true },
      steps: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string', required: true,
              enum: ['click', 'fill', 'press', 'wait', 'assert-text'],
            },
            selector: { type: 'string' },
            value: { type: 'string' },
            key: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
      referencePng: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || agent.session.header.cwd === undefined) {
        throw new VisualQaError('browser verification requires a workspace-backed Agent', 'VISUAL_QA_UNAUTHORIZED')
      }
      const initial = parseHttpUrl(args.url, 'url')
      if (!resolved.allowedOrigins.has(initial.origin)) {
        throw new VisualQaError(
          `initial origin ${JSON.stringify(initial.origin)} is not deployment-allowed`,
          'VISUAL_QA_ORIGIN_BLOCKED',
        )
      }
      const steps = normalizeSteps(args.steps, resolved.maxSteps)
      const { identity } = requireRun(ctx, agent)
      const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-autopilot-visual-qa-'))
      /* v8 ignore next 4 -- closes the HMR race while the non-cancellable Host mkdtemp call settles. */
      if (disposed) {
        await rm(tempRoot, { recursive: true, force: true })
        throw new VisualQaError('Visual QA plugin is disposed', 'VISUAL_QA_ABORTED')
      }
      const active = createActive(agent, identity, tempRoot)
      activeRuns.add(active)
      const timeout = new AbortController()
      const timeoutHandle = setTimeout(() => timeout.abort(new Error('Visual QA total timeout')), resolved.timeoutMs)
      const signal = AbortSignal.any([exec.signal, active.abort.signal, timeout.signal])
      const timedOut = () => timeout.signal.aborted
      let policyViolation: string | undefined
      const abortClose = () => { void closeActive(active) }
      signal.addEventListener('abort', abortClose, { once: true })
      try {
        const launchPromise = chromium.launch({
          headless: true,
          timeout: resolved.timeoutMs,
          ...(resolved.channel === undefined ? {} : { channel: resolved.channel }),
          ...(resolved.executablePath === undefined ? {} : { executablePath: resolved.executablePath }),
        })
        void launchPromise.then(browser => {
          if (signal.aborted) void browser.close()
        }, () => undefined)
        active.browser = await abortable(launchPromise, signal, timedOut)
        active.browserContext = await abortable(active.browser.newContext({
          viewport: { width: resolved.viewportWidth, height: resolved.viewportHeight },
          acceptDownloads: false,
          serviceWorkers: 'block',
        }), signal, timedOut)
        await active.browserContext.route('**/*', async (route) => {
          const requestUrl = route.request().url()
          if (!isAllowedVisualQaUrl(requestUrl, resolved.allowedOrigins)) {
            policyViolation = requestUrl
            await route.abort('blockedbyclient')
            return
          }
          await route.continue()
        })
        await active.browserContext.routeWebSocket('**/*', async (route) => {
          const requestUrl = route.url()
          if (!isAllowedVisualQaUrl(requestUrl, resolved.allowedOrigins)) {
            policyViolation = requestUrl
            await route.close({ code: 1008, reason: 'origin blocked by DSH Autopilot Visual QA' })
            return
          }
          route.connectToServer()
        })
        const page = await abortable(active.browserContext.newPage(), signal, timedOut)
        try {
          await abortable(
            page.goto(initial.href, { waitUntil: 'domcontentloaded', timeout: resolved.stepTimeoutMs }),
            signal,
            timedOut,
          )
        } catch (error) {
          if (policyViolation !== undefined) {
            throw new VisualQaError(
              `navigation or request to ${JSON.stringify(policyViolation)} was blocked`,
              'VISUAL_QA_ORIGIN_BLOCKED',
            )
          }
          throw error
        }
        if (policyViolation !== undefined || !isAllowedVisualQaUrl(page.url(), resolved.allowedOrigins)) {
          throw new VisualQaError(
            `navigation or request to ${JSON.stringify(policyViolation ?? page.url())} was blocked`,
            'VISUAL_QA_ORIGIN_BLOCKED',
          )
        }
        const assertions: VisualQaAssertion[] = []
        for (const step of steps) {
          try {
            await abortable(executeStep(page, step, resolved.stepTimeoutMs, assertions), signal, timedOut)
          } catch (error) {
            if (policyViolation !== undefined) {
              throw new VisualQaError(
                `navigation or request to ${JSON.stringify(policyViolation)} was blocked`,
                'VISUAL_QA_ORIGIN_BLOCKED',
              )
            }
            throw error
          }
          if (!isAllowedVisualQaUrl(page.url(), resolved.allowedOrigins)) {
            throw new VisualQaError(
              `page navigation reached blocked origin ${JSON.stringify(page.url())}`,
              'VISUAL_QA_ORIGIN_BLOCKED',
            )
          }
        }
        const title = await abortable(page.title(), signal, timedOut)
        const body = await abortable(
          page.locator('body').innerText({ timeout: resolved.stepTimeoutMs }), signal, timedOut,
        )
        const screenshotBytes = await abortable(
          page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', caret: 'hide' }),
          signal,
          timedOut,
        )
        if (screenshotBytes.length > resolved.maxPngBytes) {
          throw new VisualQaError(`screenshot exceeds maxPngBytes=${resolved.maxPngBytes}`, 'VISUAL_QA_PNG_INVALID')
        }
        if (policyViolation !== undefined || !isAllowedVisualQaUrl(page.url(), resolved.allowedOrigins)) {
          throw new VisualQaError(
            `navigation or request to ${JSON.stringify(policyViolation ?? page.url())} was blocked`,
            'VISUAL_QA_ORIGIN_BLOCKED',
          )
        }
        const image = decodeVisualQaPng(screenshotBytes, resolved.maxPixels)
        const screenshotPath = join(active.tempRoot, `${randomUUID()}.png`)
        await abortable(writeFile(screenshotPath, screenshotBytes, { flag: 'wx', mode: 0o600 }), signal, timedOut)
        const screenshotSha256 = sha256(screenshotBytes)
        let comparison: VisualQaComparison | undefined
        if (args.referencePng !== undefined) {
          const reference = await workspaceReference(ctx, exec, args.referencePng, resolved.maxPngBytes)
          comparison = Object.freeze({
            referencePng: args.referencePng,
            referenceSha256: sha256(reference),
            ...compareVisualQaPng(screenshotBytes, reference, resolved.maxPixels),
          })
        }
        const completed = requireSameRun(ctx, agent, identity)
        const previewTruncated = body.length > resolved.maxBodyPreviewChars
        const receiptSeed = JSON.stringify({
          ...identity,
          completedRevision: completed.revision,
          screenshotSha256,
          nonce: randomUUID(),
        })
        const result: VisualQaResult = Object.freeze({
          url: page.url(),
          title,
          assertions: Object.freeze(assertions),
          bodyPreview: previewTruncated ? `${body.slice(0, resolved.maxBodyPreviewChars)}…` : body,
          bodyPreviewTruncated: previewTruncated,
          screenshot: Object.freeze({
            id: `vqa-${sha256(receiptSeed)}`,
            owner: identity,
            completedRevision: completed.revision,
            sha256: screenshotSha256,
            bytes: screenshotBytes.length,
            width: image.width,
            height: image.height,
          }),
          ...(comparison === undefined ? {} : { comparison }),
        })
        return jsonValue(result)
      } catch (error) {
        if (timeout.signal.aborted) throw abortError(signal, true)
        if (signal.aborted) throw abortError(signal, false)
        if (error instanceof VisualQaError) throw error
        throw new VisualQaError(
          error instanceof Error ? error.message : 'browser operation failed',
          'VISUAL_QA_BROWSER_FAILED',
        )
      } finally {
        clearTimeout(timeoutHandle)
        signal.removeEventListener('abort', abortClose)
        await closeActive(active)
        activeRuns.delete(active)
        active.settle()
      }
    },
  })))
  registerRecoveryContribution(ctx, 'visual-qa')
}
