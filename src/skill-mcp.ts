/** Deployment-controlled, Skill-triggered MCP lifecycle for active Autopilot runs. */
import { isAbsolute } from 'node:path'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {
  JsonValue,
  PostToolDecision,
  ToolExecution,
} from '@deepseek-ai/dsh-tools'
import { registerRecoveryContribution } from './recovery-coordinator.ts'

export const name = 'dsh-autopilot-skill-mcp'
export const inject = ['agents', 'autonomy', 'goals', 'skills', 'tools']

const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
const SERVER_ID = /^[a-z][a-z0-9-]{0,63}$/u
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const CONFIG_KEYS = new Set(['servers', 'maxServersPerAgent', 'allowedStdioCommands', 'allowedHttpOrigins'])
const BASE_SERVER_KEYS = ['id', 'transport', 'serverName', 'toolCallTimeoutMs'] as const
const STDIO_SERVER_KEYS = new Set([...BASE_SERVER_KEYS, 'command', 'args', 'env', 'cwd'])
const HTTP_SERVER_KEYS = new Set([...BASE_SERVER_KEYS, 'url', 'headers'])
const MAX_SKILL_SERVERS = 8
const MAX_CONFIGURED_SERVERS = 32
const DEFAULT_MAX_SERVERS_PER_AGENT = 4
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A Skill may reference only deployment-owned server identifiers. */
export interface SkillMcpMetadata {
  readonly mcpServers: readonly string[]
}

/** Deployment-owned stdio MCP server definition. */
export interface SkillMcpStdioServerConfig {
  readonly id: string
  readonly transport: 'stdio'
  readonly serverName: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly toolCallTimeoutMs?: number
}

/** Deployment-owned Streamable HTTP MCP server definition. */
export interface SkillMcpHttpServerConfig {
  readonly id: string
  readonly transport: 'streamable-http'
  readonly serverName: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
}

/** One server a deployment permits Skills to request by ID. */
export type SkillMcpServerConfig = SkillMcpStdioServerConfig | SkillMcpHttpServerConfig

/** Raw deployment policy. Skills never supply values in this object. */
export interface Config {
  readonly servers?: readonly SkillMcpServerConfig[]
  readonly maxServersPerAgent?: number
  readonly allowedStdioCommands?: readonly string[]
  readonly allowedHttpOrigins?: readonly string[]
}

/** MCP client config passed to the published DSH namespace plugin. */
export type ResolvedSkillMcpServer = Readonly<({
  readonly id: string
  readonly serverName: string
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: true
  readonly reconnect: Readonly<{
    readonly enabled: false
    readonly initialDelayMs: 500
    readonly maxDelayMs: 30_000
    readonly maxAttempts: 1
  }>
} & ({
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
} | {
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}))>

/** Fully materialized deployment policy captured when this plugin loads. */
export interface ResolvedSkillMcpConfig {
  readonly servers: ReadonlyMap<string, ResolvedSkillMcpServer>
  readonly maxServersPerAgent: number
}

/** Minimal owned lifecycle returned by `agent.ctx.plugin(McpClient, config)`. */
export interface SkillMcpMountHandle {
  dispose(): Promise<void>
}

/** Host mount seam; tests substitute it without spawning processes or making network calls. */
export type SkillMcpMount = (
  ctx: Context,
  config: ResolvedSkillMcpServer,
) => Promise<SkillMcpMountHandle>

/** Testable loader for the published MCP namespace module. */
export type SkillMcpModuleLoader = () => Promise<unknown>

interface MountedServer {
  readonly config: ResolvedSkillMcpServer
  readonly handle: SkillMcpMountHandle
}

interface RunIdentity {
  readonly id: string
  readonly generation: number
  readonly goalId: string
}

interface AgentMountState {
  readonly agent: Agent
  readonly mounted: Map<string, MountedServer>
  queue: Promise<void>
  cleanupDebt: boolean
  run?: RunIdentity
}

const SHARED_MOUNT_STATES = new WeakMap<Context, Map<Agent, AgentMountState>>()

/** Strictly parse one Skill's controlled server-ID list. */
export function parseSkillMcpReferences(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SKILL_SERVERS) {
    throw new Error(`${path} must be a non-empty array with at most ${MAX_SKILL_SERVERS} server IDs`)
  }
  const references: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !SERVER_ID.test(item)) {
      throw new Error(`${path}[${index}] must be a lower-kebab-case server ID`)
    }
    if (seen.has(item)) throw new Error(`${path} contains duplicate server ID "${item}"`)
    seen.add(item)
    references.push(item)
  }
  return Object.freeze(references)
}

/** Validate and freeze the complete deployment allowlist before any Agent can use it. */
export function resolveSkillMcpConfig(value: Config = {}): ResolvedSkillMcpConfig {
  assertRecord(value, 'skill MCP config')
  rejectUnknownKeys(value, CONFIG_KEYS, 'skill MCP config')
  const servers = value.servers ?? []
  if (!Array.isArray(servers) || servers.length > MAX_CONFIGURED_SERVERS) {
    throw new Error(`skill MCP config.servers must be an array with at most ${MAX_CONFIGURED_SERVERS} entries`)
  }
  const maxServersPerAgent = value.maxServersPerAgent ?? DEFAULT_MAX_SERVERS_PER_AGENT
  positiveInteger(maxServersPerAgent, 'skill MCP config.maxServersPerAgent', MAX_SKILL_SERVERS)
  const allowedCommands = stringSet(value.allowedStdioCommands ?? [], 'skill MCP config.allowedStdioCommands')
  const allowedOrigins = originSet(value.allowedHttpOrigins ?? [])
  const resolved = new Map<string, ResolvedSkillMcpServer>()
  const namespaces = new Set<string>()
  for (const [index, raw] of servers.entries()) {
    const path = `skill MCP config.servers[${index}]`
    assertRecord(raw, path)
    const transport = raw['transport']
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      throw new Error(`${path}.transport must be "stdio" or "streamable-http"`)
    }
    rejectUnknownKeys(raw, transport === 'stdio' ? STDIO_SERVER_KEYS : HTTP_SERVER_KEYS, path)
    const id = matchingString(raw['id'], SERVER_ID, `${path}.id`, 'a lower-kebab-case server ID')
    if (resolved.has(id)) throw new Error(`skill MCP config has duplicate server ID "${id}"`)
    const serverName = matchingString(raw['serverName'], SERVER_NAME, `${path}.serverName`, 'a valid MCP namespace')
    if (namespaces.has(serverName)) throw new Error(`skill MCP config has duplicate serverName "${serverName}"`)
    namespaces.add(serverName)
    const toolCallTimeoutMs = raw['toolCallTimeoutMs'] ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    positiveInteger(toolCallTimeoutMs, `${path}.toolCallTimeoutMs`, MAX_TIMER_DELAY_MS)
    const common = {
      id,
      serverName,
      toolCallTimeoutMs,
      failOnStartupError: true as const,
      reconnect: Object.freeze({
        enabled: false as const,
        initialDelayMs: 500 as const,
        maxDelayMs: 30_000 as const,
        maxAttempts: 1 as const,
      }),
    }
    if (transport === 'stdio') {
      const command = nonEmptyString(raw['command'], `${path}.command`)
      if (!allowedCommands.has(command)) {
        throw new Error(`${path}.command "${command}" is not in allowedStdioCommands`)
      }
      const args = stringArray(raw['args'] ?? [], `${path}.args`)
      const env = stringRecord(raw['env'] ?? {}, `${path}.env`, ENV_NAME)
      const cwd = raw['cwd'] === undefined ? '' : nonEmptyString(raw['cwd'], `${path}.cwd`)
      if (cwd !== '' && !isAbsolute(cwd)) throw new Error(`${path}.cwd must be an absolute path`)
      resolved.set(id, Object.freeze({
        ...common,
        transport,
        command,
        args: Object.freeze(args),
        env: Object.freeze(env),
        cwd,
      }))
      continue
    }
    const url = httpUrl(raw['url'], `${path}.url`)
    const origin = new URL(url).origin
    if (!allowedOrigins.has(origin)) {
      throw new Error(`${path}.url origin "${origin}" is not in allowedHttpOrigins`)
    }
    const headers = stringRecord(raw['headers'] ?? {}, `${path}.headers`, HEADER_NAME, true)
    resolved.set(id, Object.freeze({
      ...common,
      transport,
      url,
      headers: Object.freeze(headers),
    }))
  }
  return Object.freeze({ servers: resolved, maxServersPerAgent })
}

/** Own all per-Agent MCP fibers and tie them to Skill and Autopilot lifecycle events. */
export class SkillMcpLifecycle {
  private readonly config: ResolvedSkillMcpConfig
  private readonly states: Map<Agent, AgentMountState>
  private closed = false

  /** Capture deployment policy and mount authority. */
  constructor(
    private readonly ctx: Context,
    config: Config,
    private readonly mount: SkillMcpMount,
  ) {
    this.config = resolveSkillMcpConfig(config)
    this.states = mountStates(ctx.root)
  }

  /** Register lifecycle effects on the owning Cordis fiber. */
  apply(): void {
    this.ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      await this.retryCleanup(agent)
      for (const skillName of invokedSkillNames(decision.messages)) {
        await this.activate(agent, skillName, signal)
      }
      return decision
    }, { prepend: true })
    this.ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
      const decision = await next()
      if (decision.kind === 'block' || result.isError || exec.name !== 'skill' || exec.agent === undefined) {
        return decision
      }
      const value = Object.hasOwn(decision, 'value') ? decision.value as JsonValue : result.value
      const skillName = successfulSkillName(exec, value)
      if (skillName === undefined) return decision
      await this.activate(exec.agent, skillName, exec.signal)
      return decision
    }, { prepend: true })
    this.ctx.on('autonomy/changed', ({ agent }) => {
      if (this.states.get(agent)?.cleanupDebt === true) {
        void this.retryCleanup(agent).catch((error: unknown) => {
          this.ctx.logger.error(`dsh-autopilot: failed to retry Skill MCP cleanup debt: ${String(error)}`)
        })
        return
      }
      if (this.isAuthorized(agent)) return
      void this.release(agent).catch((error: unknown) => {
        this.ctx.logger.error(`dsh-autopilot: failed to unload inactive Skill MCP servers: ${String(error)}`)
      })
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      void this.release(agent, true).catch((error: unknown) => {
        this.ctx.logger.error(`dsh-autopilot: failed to unload Skill MCP servers for disposed Agent: ${String(error)}`)
      })
    })
    this.ctx.effect(() => async () => {
      this.closed = true
      const states = [...this.states.values()]
      const results = await Promise.allSettled(states.map(state => this.release(state.agent, true)))
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (errors.length > 0) throw new AggregateError(errors.map(result => result.reason), 'Skill MCP unload failed')
    }, 'dsh-autopilot.skillMcpLifecycle')
  }

  /** Wait for all queued mount and teardown work; intended for deterministic host shutdown and tests. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.states.values()].map(state => state.queue))
  }

  /** Retry retained failed server disposals without ever mounting a replacement over cleanup debt. */
  async retryCleanup(agent: Agent): Promise<void> {
    const state = this.states.get(agent)
    if (state?.cleanupDebt !== true) return
    await this.enqueue(state, () => this.disposeAll(state))
  }

  private async activate(agent: Agent, skillName: string, signal: AbortSignal): Promise<void> {
    this.requireOpen()
    signal.throwIfAborted()
    const skill = await this.ctx.skills.get(skillName, {
      cwd: agent.session.header.cwd,
      signal,
      scope: agent,
    })
    this.requireOpen()
    signal.throwIfAborted()
    if (skill === undefined) throw new Error(`skill "${skillName}" disappeared before MCP activation`)
    const references = referencesOf(skill)
    if (references === undefined) return
    const requested = references.map((id) => {
      const server = this.config.servers.get(id)
      if (server === undefined) throw new Error(`skill "${skillName}" requests MCP server "${id}" outside the deployment allowlist`)
      return server
    })
    const state = this.state(agent)
    await this.enqueue(state, async () => {
      this.requireOpen()
      signal.throwIfAborted()
      if (state.cleanupDebt) await this.disposeAll(state)
      const run = this.requireAuthorization(agent)
      if (!sameRun(state.run, run)) await this.disposeAll(state)
      state.run = run
      const additions = requested.filter(server => !state.mounted.has(server.id))
      if (state.mounted.size + additions.length > this.config.maxServersPerAgent) {
        throw new Error(
          `skill "${skillName}" would exceed the deployment limit of ${this.config.maxServersPerAgent} MCP servers per Agent`,
        )
      }
      const added: MountedServer[] = []
      try {
        for (const server of additions) {
          signal.throwIfAborted()
          const handle = await this.mount(agent.ctx, server)
          assertMountHandle(handle, server.id)
          const mounted = { config: server, handle }
          state.mounted.set(server.id, mounted)
          added.push(mounted)
          this.requireOpen()
          const current = this.requireAuthorization(agent)
          if (!sameRun(run, current)) throw new Error('Autopilot authorization changed during MCP startup')
          signal.throwIfAborted()
        }
      } catch (error: unknown) {
        try {
          await this.disposeMounted(state, added.reverse())
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            `skill "${skillName}" MCP startup and rollback failed`,
          )
        }
        throw error
      }
    })
  }

  private state(agent: Agent): AgentMountState {
    let state = this.states.get(agent)
    if (state === undefined) {
      state = { agent, mounted: new Map(), queue: Promise.resolve(), cleanupDebt: false }
      this.states.set(agent, state)
    }
    return state
  }

  private enqueue(state: AgentMountState, operation: () => Promise<void>): Promise<void> {
    const task = state.queue.then(operation, operation)
    state.queue = task.catch(() => {})
    return task
  }

  private async release(agent: Agent, forget = false): Promise<void> {
    const state = this.states.get(agent)
    if (state === undefined) return
    const task = this.enqueue(state, () => this.disposeAll(state))
    const checkpoint = state.queue
    await task
    if (forget && this.states.get(agent) === state && state.queue === checkpoint) this.states.delete(agent)
  }

  private async disposeAll(state: AgentMountState): Promise<void> {
    const mounted = [...state.mounted.values()].reverse()
    if (mounted.length === 0) {
      state.cleanupDebt = false
      delete state.run
      return
    }
    await this.disposeMounted(state, mounted)
  }

  private async disposeMounted(state: AgentMountState, mounted: readonly MountedServer[]): Promise<void> {
    const results = await Promise.allSettled(mounted.map(async (server) => {
      await server.handle.dispose()
      state.mounted.delete(server.config.id)
    }))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length === 0) {
      if (state.mounted.size === 0) {
        state.cleanupDebt = false
        delete state.run
      }
      return
    }
    state.cleanupDebt = true
    const reasons = errors.map(result => result.reason)
    try {
      await this.markCleanupAttention(state)
    } catch (attentionError: unknown) {
      reasons.push(attentionError)
    }
    throw new AggregateError(reasons, 'Skill MCP server disposal failed')
  }

  private async markCleanupAttention(state: AgentMountState): Promise<void> {
    const run = state.run
    const current = this.ctx.autonomy.get(state.agent)
    if (run === undefined || current === undefined
      || current.id !== run.id
      || current.generation !== run.generation
      || String(current.goalId) !== run.goalId
      || current.phase === 'completed'
      || current.phase === 'revoked'
      || current.phase === 'needs-attention') return
    const servers = [...state.mounted.keys()].map(id => JSON.stringify(id)).join(', ')
    await this.ctx.autonomy.markNeedsAttention({
      runId: current.id,
      generation: current.generation,
      revision: current.revision,
      sessionId: String(state.agent.id),
    }, `Skill MCP cleanup failed for deployment server(s): ${servers}`)
  }

  private isAuthorized(agent: Agent): boolean {
    try {
      this.requireAuthorization(agent)
      return true
    } catch {
      return false
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Skill MCP lifecycle is unloading')
  }

  private requireAuthorization(agent: Agent): RunIdentity {
    const view = this.ctx.autonomy.get(agent)
    const goal = this.ctx.goals.get(agent)
    if (view === undefined || goal === undefined
      || view.activation !== 'armed'
      || (view.phase !== 'running' && view.phase !== 'verifying')
      || String(view.goalId) !== String(goal.id)
      || goal.phase !== 'active'
      || goal.activation !== 'armed') {
      throw new Error('Skill MCP activation requires this Agent\'s exact active Autopilot Goal and armed lease')
    }
    return { id: view.id, generation: view.generation, goalId: String(view.goalId) }
  }
}

function mountStates(ctx: Context): Map<Agent, AgentMountState> {
  let states = SHARED_MOUNT_STATES.get(ctx)
  if (states === undefined) {
    states = new Map()
    SHARED_MOUNT_STATES.set(ctx, states)
  }
  return states
}

function invokedSkillNames(messages: readonly UserMessage[]): readonly string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.source.kind === 'skill-invocation') names.add(message.source.name)
  }
  return [...names]
}

/** Create a plugin entrypoint with an explicit Host-owned mount callback. */
export function createSkillMcpPlugin(mount: SkillMcpMount): Plugin.Object<Config> {
  return {
    name,
    inject,
    apply(ctx: Context, config: Config = {}) {
      const lifecycle = new SkillMcpLifecycle(ctx, config, mount)
      lifecycle.apply()
      registerRecoveryContribution(ctx, 'skill-mcp')
    },
  }
}

/** Load the published DSH MCP namespace plugin and mount one instance in an Agent scope. */
export async function mountPublishedMcpClient(
  ctx: Context,
  config: ResolvedSkillMcpServer,
  load: SkillMcpModuleLoader = () => import(MCP_CLIENT_MODULE),
): Promise<Fiber> {
  const loaded = await load()
  if (!isPluginObject(loaded)) {
    throw new Error(`${MCP_CLIENT_MODULE} root export is not a namespace plugin`)
  }
  const { id: _deploymentId, ...mcpConfig } = config
  return ctx.plugin(loaded, mcpConfig)
}

/** Default Cordis entrypoint using `@deepseek-ai/dsh-mcp-client`. */
export function apply(ctx: Context, config: Config = {}): void {
  const lifecycle = new SkillMcpLifecycle(ctx, config, mountPublishedMcpClient)
  lifecycle.apply()
  registerRecoveryContribution(ctx, 'skill-mcp')
}

function successfulSkillName(exec: Readonly<ToolExecution>, value: JsonValue): string | undefined {
  const args = exec.arguments as Readonly<Record<string, unknown>>
  if (typeof args['name'] !== 'string' || !isRecord(value)) return undefined
  const requested = args['name']
  return value['name'] === requested
    && typeof value['provider'] === 'string'
    && typeof value['content'] === 'string'
    ? requested
    : undefined
}

function referencesOf(skill: SkillDefinition): readonly string[] | undefined {
  const metadata = skill.metadata
  if (metadata === undefined || metadata['mcpServers'] === undefined) return undefined
  return parseSkillMcpReferences(metadata['mcpServers'], `skill "${skill.name}" metadata.mcpServers`)
}

function sameRun(left: RunIdentity | undefined, right: RunIdentity): boolean {
  return left !== undefined
    && left.id === right.id
    && left.generation === right.generation
    && left.goalId === right.goalId
}

function assertMountHandle(value: unknown, id: string): asserts value is SkillMcpMountHandle {
  if (!isRecord(value) || typeof value['dispose'] !== 'function') {
    throw new Error(`MCP mount for server "${id}" did not return a disposable handle`)
  }
}

function isPluginObject(value: unknown): value is Plugin.Object<unknown> {
  return isRecord(value) && typeof value['apply'] === 'function'
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path} contains unsupported field "${key}"`)
  }
}

function positiveInteger(value: unknown, path: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${path} must be a positive integer no greater than ${maximum}`)
  }
}

function matchingString(value: unknown, pattern: RegExp, path: string, expected: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${path} must be ${expected}`)
  return value
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${path} must be a non-empty string without NUL bytes`)
  }
  return value
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of strings`)
  return value.map((item, index) => nonEmptyString(item, `${path}[${index}]`))
}

function stringSet(value: unknown, path: string): ReadonlySet<string> {
  const values = stringArray(value, path)
  const set = new Set(values)
  if (set.size !== values.length) throw new Error(`${path} must not contain duplicates`)
  return set
}

function stringRecord(
  value: unknown,
  path: string,
  keyPattern: RegExp,
  rejectLineBreaks = false,
): Record<string, string> {
  assertRecord(value, path)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key)) throw new Error(`${path} contains invalid key "${key}"`)
    const text = nonEmptyString(item, `${path}.${key}`)
    if (rejectLineBreaks && /[\r\n]/u.test(text)) throw new Error(`${path}.${key} must not contain line breaks`)
    result[key] = text
  }
  return result
}

function originSet(values: unknown): ReadonlySet<string> {
  const origins = stringArray(values, 'skill MCP config.allowedHttpOrigins')
  const normalized = origins.map((value, index) => {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== ''
      || url.origin !== value || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error(`skill MCP config.allowedHttpOrigins[${index}] must be an exact HTTP(S) origin`)
    }
    return url.origin
  })
  const set = new Set(normalized)
  if (set.size !== normalized.length) throw new Error('skill MCP config.allowedHttpOrigins must not contain duplicates')
  return set
}

function httpUrl(value: unknown, path: string): string {
  const raw = nonEmptyString(value, path)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error: unknown) {
    throw new Error(`${path} must be an absolute HTTP(S) URL`, { cause: error })
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error(`${path} must be an absolute HTTP(S) URL without credentials or a fragment`)
  }
  return parsed.href
}
