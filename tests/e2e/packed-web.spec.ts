import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OVERLAY = join(REPO_ROOT, 'tests/e2e/replay.cordis.yml')
const OVERRIDE = join(REPO_ROOT, 'tests/e2e/fixtures/replay.override.json')
const UNUSED_FIXTURE = join(REPO_ROOT, 'tests/e2e/fixtures/unused.session.jsonl')
const require = createRequire(import.meta.url)
const DSH_PACKAGE = require.resolve('@deepseek-ai/dsh/package.json')
const DSH_BIN = join(dirname(DSH_PACKAGE), 'lib/bin.js')
const REPLAY_PACKAGE = dirname(require.resolve('@deepseek-ai/dsh-llm-replay/package.json'))

interface RpcHistory {
  readonly events: Array<{ readonly event: { readonly type: string; readonly seq: number; readonly data: unknown } }>
  readonly hasMore: boolean
}

interface SessionList {
  readonly items: Array<{ readonly sessionId: string; readonly cwd?: string }>
}

interface ProcessHandle {
  readonly child: ChildProcessWithoutNullStreams
  readonly output: { text: string }
}

let activeProcess: ProcessHandle | undefined
let activeBrowser: Browser | undefined
let temporaryRoot: string | undefined

/** Execute the locally linked DSH CLI with an isolated profile home. */
function dsh(args: readonly string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT): string {
  return execFileSync(process.execPath, [DSH_BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
}

/** Invoke one Web RPC and unwrap its typed result envelope. */
async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-autopilot-${method}-${Date.now()}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

/** Start Web and resolve the OS-selected listening URL. */
function startWeb(args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{
  baseUrl: string
  handle: ProcessHandle
}> {
  const child = spawn(process.execPath, [DSH_BIN, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end()
  const output = { text: '' }
  const handle = { child, output }
  activeProcess = handle
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`dsh web did not become ready within 90s:\n${output.text}`))
    }, 90_000)
    const observe = (chunk: Buffer): void => {
      output.text += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output.text)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolve({ baseUrl: match[1], handle })
    }
    child.stdout.on('data', observe)
    child.stderr.on('data', observe)
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`dsh web exited before readiness (${String(code)}):\n${output.text}`))
    })
  })
}

/** Stop the live Web process and allow persistence teardown to drain. */
async function stopWeb(handle: ProcessHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
  const exited = new Promise<void>(resolve => handle.child.once('exit', () => { resolve() }))
  handle.child.kill('SIGTERM')
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolve => setTimeout(() => { resolve(false) }, 15_000)),
  ])
  if (!graceful) {
    handle.child.kill('SIGKILL')
    await exited
  }
}

/** Poll history until the complete two-round run and its user-facing handoff are durable. */
async function waitForCompletion(baseUrl: string, sessionId: string, output: { text: string }): Promise<RpcHistory> {
  const deadline = Date.now() + 90_000
  let latest: RpcHistory | undefined
  while (Date.now() < deadline) {
    latest = await rpc<RpcHistory>(baseUrl, 'session.history', { sessionId, maxMessages: 100 })
    const events = latest.events.map(item => item.event)
    const complete = events.some(event => event.type === 'goal/change'
      && typeof event.data === 'object' && event.data !== null
      && (event.data as { operation?: unknown }).operation === 'complete')
    const turns = events.filter(event => event.type === 'turn/end').length
    const steps = events.filter(event => event.type === 'step/start').length
    if (complete && turns >= 2 && steps >= 10) return latest
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Autopilot did not finish two rounds and ten steps:\n${JSON.stringify(latest, null, 2)}\n${output.text}`)
}

/** Extract the model-facing text returned by one tool result event. */
function toolResultText(event: RpcHistory['events'][number]['event']): string | undefined {
  if (event.type !== 'tool/result' || typeof event.data !== 'object' || event.data === null) return undefined
  const content = (event.data as {
    message?: { content?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
  }).message?.content
  return content?.flatMap(block => block.content ?? [])
    .find(block => block.type === 'text')?.text
}

/** Extract ordinary text from one durable assistant message. */
function assistantText(event: RpcHistory['events'][number]['event']): string | undefined {
  if (event.type !== 'assistant/message' || typeof event.data !== 'object' || event.data === null) return undefined
  const content = (event.data as {
    message?: { content?: Array<{ type?: string; text?: string }> }
  }).message?.content
  return content?.find(block => block.type === 'text')?.text
}

/** Return every file below one temporary persistence root. */
function filesBelow(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
}

/** Connect one exact project directory through the real Web workspace picker. */
async function connectWorkspace(page: Page, root: string, name: string): Promise<void> {
  const welcome = page.getByRole('button', { name: /^(?:Continue|继续)$/u })
  if (await welcome.count() > 0) await welcome.click()
  await page.getByRole('button', { name: /^(?:Add workspace|添加工作区)$/u }).click()
  const dialog = page.getByRole('dialog', { name: /^(?:Select Workspace Directory|选择工作区目录)$/u })
  await dialog.waitFor({ timeout: 15_000 })
  await dialog.getByRole('button', { name: /^(?:Edit path|编辑路径)$/u }).click()
  const pathInput = dialog.getByRole('textbox', { name: /^(?:Edit path|编辑路径)$/u })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: /^(?:Open|打开)$/u, exact: true }).click()
  await page.locator('textarea:enabled').waitFor({ timeout: 20_000 })
}

/** Resolve the session the browser attached to the chosen project. */
async function waitForWorkspaceSession(baseUrl: string, cwd: string): Promise<string> {
  const deadline = Date.now() + 20_000
  const canonicalCwd = realpathSync(cwd)
  while (Date.now() < deadline) {
    const listed = await rpc<SessionList>(baseUrl, 'session.list', {})
    const found = listed.items.find(item => item.cwd !== undefined
      && realpathSync(item.cwd) === canonicalCwd)
    if (found !== undefined) return found.sessionId
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Web did not attach a session to ${cwd}`)
}

afterEach(async () => {
  await activeBrowser?.close()
  activeBrowser = undefined
  if (activeProcess !== undefined) await stopWeb(activeProcess)
  activeProcess = undefined
  if (temporaryRoot !== undefined && process.env['DSH_AUTOPILOT_E2E_PRESERVE'] !== '1') {
    rmSync(temporaryRoot, { recursive: true, force: true })
  } else if (temporaryRoot !== undefined) {
    process.stderr.write(`dsh-autopilot e2e preserved: ${temporaryRoot}\n`)
  }
  temporaryRoot = undefined
})

describe('packed bundle in a real DSH Web profile', () => {
  it('installs, runs a Host-only Cordis extension, verifies two rounds, and persists completion', async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-autopilot-e2e-'))
    const dist = join(temporaryRoot, 'dist')
    const dshHome = join(temporaryRoot, 'dsh-home')
    const agentsHome = join(temporaryRoot, 'agents-home')
    const sessions = join(temporaryRoot, 'sessions')
    const workspace = join(temporaryRoot, 'workspace')
    mkdirSync(dist)
    mkdirSync(workspace)

    execFileSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' })
    execFileSync('pnpm', ['pack', '--pack-destination', dist], { cwd: REPO_ROOT, stdio: 'pipe' })
    const tarballs = readdirSync(dist).filter(file => file.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const tarball = join(dist, tarballs[0]!)

    const profileEnv = { ...process.env, DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome }
    dsh(['plugin', '--profile', 'web', 'add', tarball, REPLAY_PACKAGE], profileEnv, workspace)
    const dumped = dsh(['--profile', 'web', '--dump-config'], profileEnv, workspace)
    for (const id of ['dsh-autopilot-service', 'dsh-autopilot-commands', 'dsh-autopilot-tools', 'dsh-autopilot-skills']) {
      expect(dumped.match(new RegExp(`(?:^|\\n)\\s*(?:- )?id: ${id}(?:\\n|$)`, 'gu'))).toHaveLength(1)
    }

    const doctor = dsh(
      ['plugin', '--profile', 'web', 'exec', 'dsh-autopilot', 'doctor', '--profile', 'web'],
      { ...profileEnv, DSH_AUTOPILOT_DSH_BIN: DSH_BIN },
      workspace,
    )
    expect(doctor).toContain('correctly installed')

    const verifierScript = [
      "import { readFileSync } from 'node:fs'",
      "if (readFileSync('e2e-proof.txt', 'utf8') !== 'DSH_AUTOPILOT_E2E\\n') process.exit(1)",
    ].join('; ')
    const verifyCommand = `${JSON.stringify(process.execPath)} --input-type=module -e ${JSON.stringify(verifierScript)}`
    const { baseUrl, handle } = await startWeb(
      ['--profile', 'web', '--patch', OVERLAY, '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...profileEnv,
          DSH_PERMISSION_MODE: 'workspace-write',
          DSH_SNAPSHOT_FILE: UNUSED_FIXTURE,
          DSH_SNAPSHOT_OVERRIDE: OVERRIDE,
          DSH_AUTOPILOT_E2E_SESSIONS: sessions,
          DSH_AUTOPILOT_E2E_VERIFY: verifyCommand,
        },
      },
    )

    const browserChannel = process.env['DSH_AUTOPILOT_E2E_BROWSER_CHANNEL']
    activeBrowser = await chromium.launch(browserChannel === undefined
      ? {}
      : { channel: browserChannel as 'msedge' | 'chrome' })
    const page = await activeBrowser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    onTestFailed(async () => {
      if (temporaryRoot === undefined) return
      await page.screenshot({ path: join(temporaryRoot, 'failure.png'), fullPage: true }).catch(() => undefined)
    })
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectWorkspace(page, temporaryRoot, 'workspace')
    const sessionId = await waitForWorkspaceSession(baseUrl, workspace)
    expect(await rpc<{ agentPreset: string }>(baseUrl, 'agentPreset.select', {
      sessionId,
      agentPreset: 'cordis',
    })).toEqual({ agentPreset: 'cordis' })
    const input = page.locator('textarea:enabled').first()
    await input.fill('/autopilot start --rounds 8 --duration 7d Create, run, and clean up a Host-only Cordis proof tool, then create and verify the E2E proof artifact.')
    await input.press('Enter')

    const history = await waitForCompletion(baseUrl, sessionId, handle.output)
    const events = history.events.map(item => item.event)
    expect(readFileSync(join(workspace, 'e2e-proof.txt'), 'utf8')).toBe('DSH_AUTOPILOT_E2E\n')
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(10)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(events.flatMap(event => event.type === 'tool/call'
      ? [(event.data as { name: string }).name]
      : [])).toEqual([
      'cordis_define',
      'cordis_run',
      'autopilot_host_probe',
      'get_autopilot',
      'cordis_stop',
      'cordis_undefine',
      'write',
      'autopilot_verify',
    ])
    expect(events.flatMap(event => event.type === 'user/message'
      && (event.data as { source?: { kind?: string; round?: number } }).source?.kind === 'goal'
      ? [(event.data as { source: { round: number } }).source.round]
      : [])).toEqual([1, 2])
    const skillCatalog = events.find(event => event.type === 'user/message'
      && (event.data as { source?: { kind?: string } }).source?.kind === 'skill-catalog')
    expect((skillCatalog?.data as {
      source?: { entries?: Array<{ name?: string }> }
    } | undefined)?.source?.entries).toContainEqual(expect.objectContaining({ name: 'autonomous-development' }))
    expect(events.filter(event => event.type === 'tool/result'
      && typeof event.data === 'object' && event.data !== null && 'error' in event.data)).toEqual([])
    const statusPayload = events.map(toolResultText)
      .find(text => text?.includes('"dynamicPackages": 1'))
    expect(statusPayload).toBeDefined()
    expect(JSON.parse(statusPayload!)).toMatchObject({
      lease: { dynamicPackages: 1, selfModification: 'host-only' },
    })
    expect(events.map(toolResultText)).toEqual(expect.arrayContaining([
      expect.stringContaining('Defined proof-1/pkg-1'),
      expect.stringContaining('proof-1/pkg-1 is running'),
      'HOST_ONLY:receipt-ok',
      expect.stringContaining('Dynamic Plugin proof-1 is stopped'),
      expect.stringContaining('Removed dynamic Plugin proof-1'),
    ]))
    const verifierPayload = events.map(toolResultText)
      .find(text => text?.includes('"verdict": "pass"'))
    expect(verifierPayload).toBeDefined()
    expect(JSON.parse(verifierPayload!)).toMatchObject({ verdict: 'pass' })

    const commandRun = events.find(event => event.type === 'command/run')
    expect(commandRun?.data).toMatchObject({ name: 'autopilot', source: { kind: 'user' } })
    const verifyCall = events.find(event => event.type === 'tool/call'
      && (event.data as { name?: unknown }).name === 'autopilot_verify')
    const complete = events.find(event => event.type === 'goal/change'
      && (event.data as { operation?: unknown }).operation === 'complete')
    const verifyResult = events.find(event => event.type === 'tool/result'
      && toolResultText(event)?.includes('"verdict": "pass"'))
    const finalReply = events.find(event => event.type === 'assistant/message'
      && assistantText(event)?.startsWith('Autopilot completed successfully.'))
    expect(verifyCall!.seq).toBeLessThan(complete!.seq)
    expect(complete!.seq).toBeLessThan(verifyResult!.seq)
    expect(verifyResult!.seq).toBeLessThan(finalReply!.seq)
    expect(assistantText(finalReply!)).toContain('deployment-fixed verification passed')

    await stopWeb(handle)
    activeProcess = undefined
    await activeBrowser.close()
    activeBrowser = undefined
    const logs = filesBelow(sessions).filter(file => file.endsWith('session.jsonl'))
    expect(logs).toHaveLength(1)
    const persisted = readFileSync(logs[0]!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      type: string
      data?: { operation?: string; name?: string }
    })
    expect(persisted.some(event => event.type === 'goal/change' && event.data?.operation === 'complete')).toBe(true)
    expect(persisted.some(event => event.type === 'command/run' && event.data?.name === 'autopilot')).toBe(true)
  })
})
