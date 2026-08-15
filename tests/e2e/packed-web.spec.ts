import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { parseDocument } from 'yaml'
import { PRIMARY_REPLAY, childReplayJsonls } from './replay-fixture.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BUNDLE_PATCH = join(REPO_ROOT, 'cordis.patch.yml')
const OVERLAY = join(REPO_ROOT, 'tests/e2e/replay.cordis.yml')
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

interface StaticPluginRow {
  readonly id: string
  readonly name: string
}

let activeProcess: ProcessHandle | undefined
let activeBrowser: Browser | undefined
let temporaryRoot: string | undefined

/** Return whether a decoded YAML value is a mapping. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode one YAML document and reject structural or parser errors. */
function parseYamlSequence(source: string, label: string): readonly unknown[] {
  const document = parseDocument(source, { strict: true })
  if (document.errors.length > 0) {
    throw new Error(`${label}: ${document.errors[0]!.message}`)
  }
  const value: unknown = document.toJS()
  if (!Array.isArray(value)) throw new Error(`${label}: expected a top-level sequence`)
  return value
}

/** Extract every statically named plugin row inserted by the shipped bundle patch. */
function bundledStaticRows(): readonly StaticPluginRow[] {
  const operations = parseYamlSequence(readFileSync(BUNDLE_PATCH, 'utf8'), 'bundle patch')
  const rows = operations.flatMap((operation, operationIndex) => {
    if (!isRecord(operation)) {
      throw new Error(`bundle patch: operation ${operationIndex + 1} is not a mapping`)
    }
    const insert = operation['insert']
    if (insert === undefined) return []
    if (!Array.isArray(insert)) {
      throw new Error(`bundle patch: operation ${operationIndex + 1} insert is not a sequence`)
    }
    return insert.map((value, rowIndex): StaticPluginRow => {
      if (!isRecord(value)) {
        throw new Error(`bundle patch: inserted row ${rowIndex + 1} is not a mapping`)
      }
      const id = value['id']
      const name = value['name']
      if (typeof id !== 'string' || typeof name !== 'string') {
        throw new Error(`bundle patch: inserted row ${rowIndex + 1} needs static string id and name`)
      }
      return Object.freeze({ id, name })
    })
  })
  if (rows.length === 0) throw new Error('bundle patch: no static plugin rows found')
  if (new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('bundle patch: static plugin ids must be unique')
  }
  if (new Set(rows.map(row => row.name)).size !== rows.length) {
    throw new Error('bundle patch: static plugin module names must be unique')
  }
  return Object.freeze(rows)
}

/** Decode the resolved Loader profile into semantic id/name pairs. */
function resolvedPluginRows(source: string): readonly Partial<StaticPluginRow>[] {
  return parseYamlSequence(source, 'dump-config').map((value, index) => {
    if (!isRecord(value)) throw new Error(`dump-config: row ${index + 1} is not a mapping`)
    const id = value['id']
    const name = value['name']
    if (id !== undefined && typeof id !== 'string') {
      throw new Error(`dump-config: row ${index + 1} has a non-string id`)
    }
    if (name !== undefined && typeof name !== 'string') {
      throw new Error(`dump-config: row ${index + 1} has a non-string module name`)
    }
    return {
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
    }
  })
}

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

/** Poll history until the repair round and verified user-facing handoff are durable. */
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
    const finalFeedback = events.some(event => event.type === 'assistant/message'
      && assistantText(event)?.startsWith('Autopilot completed successfully.'))
    if (complete && finalFeedback && turns >= 3 && steps >= 14) return latest
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Autopilot did not finish its repair round and final handoff:\n${JSON.stringify(latest, null, 2)}\n${output.text}`)
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

/** Extract the opaque call id correlated with one authoritative tool result. */
function toolResultCallId(event: RpcHistory['events'][number]['event']): string | undefined {
  if (event.type !== 'tool/result' || typeof event.data !== 'object' || event.data === null) return undefined
  const source = (event.data as { message?: { source?: { callId?: unknown } } }).message?.source
  return typeof source?.callId === 'string' ? source.callId : undefined
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
  await welcome.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await welcome.isVisible()) {
    await welcome.click()
    await welcome.waitFor({ state: 'hidden', timeout: 15_000 })
  }
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
  it('runs managed Cordis, repairs a failed verification, and persists the final handoff', async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-autopilot-e2e-'))
    const dist = join(temporaryRoot, 'dist')
    const dshHome = join(temporaryRoot, 'dsh-home')
    const agentsHome = join(temporaryRoot, 'agents-home')
    const sessions = join(temporaryRoot, 'sessions')
    const workspace = join(temporaryRoot, 'workspace')
    const replayOverride = join(temporaryRoot, 'replay.override.json')
    const childReplayContents = childReplayJsonls()
    const childReplays = childReplayContents.map((_, index) => join(dirname(replayOverride), `child-${index + 1}.session.jsonl`))
    mkdirSync(dist)
    mkdirSync(workspace)
    writeFileSync(replayOverride, `${JSON.stringify(PRIMARY_REPLAY, null, 2)}\n`, 'utf8')
    for (const [index, content] of childReplayContents.entries()) {
      writeFileSync(childReplays[index]!, content, 'utf8')
    }

    execFileSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' })
    execFileSync('pnpm', ['pack', '--pack-destination', dist], { cwd: REPO_ROOT, stdio: 'pipe' })
    const tarballs = readdirSync(dist).filter(file => file.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const tarball = join(dist, tarballs[0]!)

    const profileEnv = { ...process.env, DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome }
    dsh(['plugin', '--profile', 'web', 'add', tarball, REPLAY_PACKAGE], profileEnv, workspace)
    const dumped = dsh(['--profile', 'web', '--dump-config'], profileEnv, workspace)
    const expectedRows = bundledStaticRows()
    const dumpedRows = resolvedPluginRows(dumped)
    for (const expected of expectedRows) {
      expect(dumpedRows.filter(row => row.id === expected.id)).toEqual([
        expect.objectContaining(expected),
      ])
      expect(dumpedRows.filter(row => row.name === expected.name)).toEqual([
        expect.objectContaining(expected),
      ])
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
          DSH_SNAPSHOT_OVERRIDE: replayOverride,
          DSH_SNAPSHOT_CHILD_FILES: childReplays.join(delimiter),
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
    await input.fill('/autopilot start --rounds 8 --duration 7d Use the managed Host-only Cordis lifecycle, create the proof artifact, repair verifier findings, and finish with a concrete user-facing summary.')
    await input.press('Enter')

    const history = await waitForCompletion(baseUrl, sessionId, handle.output)
    const events = history.events.map(item => item.event)
    expect(readFileSync(join(workspace, 'e2e-proof.txt'), 'utf8')).toBe('DSH_AUTOPILOT_E2E\n')
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(17)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(3)
    expect(events.flatMap(event => event.type === 'tool/call'
      ? [(event.data as { name: string }).name]
      : [])).toEqual([
      'autopilot_flow',
      'autopilot_plan',
      'autopilot_flow',
      'autopilot_task',
      'autopilot_cordis_apply',
      'managed_host_probe',
      'autopilot_cordis_remove',
      'write',
      'autopilot_task',
      'autopilot_verify',
      'autopilot_plan',
      'autopilot_flow',
      'autopilot_task',
      'write',
      'autopilot_task',
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
    const resultFor = (callId: string): string | undefined => {
      const event = events.find(candidate => toolResultCallId(candidate) === callId)
      return event === undefined ? undefined : toolResultText(event)
    }
    expect(JSON.parse(resultFor('call_cordis_apply')!)).toMatchObject({
      logicalId: 'managed-proof', status: 'running', recovered: false,
    })
    expect(resultFor('call_host_probe')).toBe('MANAGED_HOST:receipt-ok')
    expect(JSON.parse(resultFor('call_cordis_remove')!)).toMatchObject({
      lease: {
        dynamicPackages: 1,
        selfModification: 'host-only',
        dynamicExtensions: [{ logicalId: 'managed-proof', status: 'removed' }],
      },
    })
    const failedVerification = JSON.parse(resultFor('call_verify_fail')!) as {
      verdict: string; checks: Array<{ name: string; passed: boolean }>; next: string
    }
    expect(failedVerification).toMatchObject({
      verdict: 'fail',
      checks: [{ name: 'e2e-artifact', passed: false }],
      next: expect.stringContaining('repair'),
    })
    const passedVerification = JSON.parse(resultFor('call_verify_pass')!) as {
      verdict: string
      checks: Array<{ name: string; passed: boolean }>
      reviewers: Array<{ role: string; verdict: string }>
    }
    expect(passedVerification).toMatchObject({
      verdict: 'pass',
      checks: [{ name: 'e2e-artifact', passed: true }],
      reviewers: [{ role: 'acceptance-reviewer', verdict: 'pass' }],
    })

    const commandRun = events.find(event => event.type === 'command/run')
    expect(commandRun?.data).toMatchObject({ name: 'autopilot', source: { kind: 'user' } })
    const verifyCalls = events.filter(event => event.type === 'tool/call'
      && (event.data as { name?: unknown }).name === 'autopilot_verify')
    const complete = events.find(event => event.type === 'goal/change'
      && (event.data as { operation?: unknown }).operation === 'complete')
    const failedResult = events.find(event => toolResultCallId(event) === 'call_verify_fail')
    const passedResult = events.find(event => toolResultCallId(event) === 'call_verify_pass')
    const finalReply = events.find(event => event.type === 'assistant/message'
      && assistantText(event)?.startsWith('Autopilot completed successfully.'))
    expect(verifyCalls).toHaveLength(2)
    expect(verifyCalls[0]!.seq).toBeLessThan(failedResult!.seq)
    expect(failedResult!.seq).toBeLessThan(verifyCalls[1]!.seq)
    expect(verifyCalls[1]!.seq).toBeLessThan(complete!.seq)
    expect(complete!.seq).toBeLessThan(passedResult!.seq)
    expect(passedResult!.seq).toBeLessThan(finalReply!.seq)
    expect(assistantText(finalReply!)).toContain('failed first candidate was repaired')
    expect(assistantText(finalReply!)).toContain('fresh independent review passed')

    await stopWeb(handle)
    activeProcess = undefined
    await activeBrowser.close()
    activeBrowser = undefined
    const logs = filesBelow(sessions).filter(file => file.endsWith('session.jsonl'))
    expect(logs.length).toBeGreaterThanOrEqual(9)
    const persistedLogs = logs.map(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      type: string
      data?: { operation?: string; name?: string }
    }))
    const persisted = persistedLogs.find(records => records
      .some(event => event.type === 'command/run' && event.data?.name === 'autopilot'))
    expect(persisted).toBeDefined()
    if (persisted === undefined) throw new Error('parent session persistence log is missing')
    expect(persisted.some(event => event.type === 'goal/change' && event.data?.operation === 'complete')).toBe(true)
    expect(persisted.some(event => event.type === 'command/run' && event.data?.name === 'autopilot')).toBe(true)
    expect(persisted.some(event => event.type === 'assistant/message'
      && JSON.stringify(event.data).includes('Autopilot completed successfully.'))).toBe(true)
  })
})
