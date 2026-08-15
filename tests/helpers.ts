import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import GoalService from '@deepseek-ai/dsh-goal'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, vi } from 'vitest'
import * as commandsPlugin from '../src/commands.ts'
import {
  AutopilotRecoveryReadiness,
  RECOVERY_CRITICAL_CONTRIBUTIONS,
} from '../src/recovery-coordinator.ts'
import type { RecoveryCriticalContribution } from '../src/recovery-coordinator.ts'
import AutopilotRunDashboardService from '../src/run-dashboard-service.ts'
import MissionService from '../src/mission-service.ts'
import type { PlannedTaskInput } from '../src/run-state.ts'
import AutonomyService from '../src/service.ts'
import type { AutonomyServiceConfig } from '../src/service.ts'
import * as toolsPlugin from '../src/tools.ts'
import type { Config as ToolsConfig } from '../src/tools.ts'

const openTestContexts = new Set<Context>()

const ALL_SUBAGENT_CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

/** Scripted failure at either side of the provider publication point. */
export type TestSubagentOutcome =
  | SubagentResult
  | { readonly startError: unknown }
  | { readonly resultError: unknown }

/** Configurable public-seam subagent provider shared by tool integration tests. */
export class TestSubagentProvider implements SubagentProvider {
  readonly name = 'spawn'
  readonly capabilities = ALL_SUBAGENT_CAPABILITIES
  readonly inheritsParentContext = false
  readonly requests: ResolvedSubagentStartRequest[] = []
  readonly outcomes: TestSubagentOutcome[] = []
  readonly disposed: ReturnType<typeof vi.fn>[] = []

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const index = this.requests.length
    this.requests.push(request)
    const outcome = this.outcomes.shift() ?? defaultSubagentResult(request)
    if ('startError' in outcome) throw outcome.startError
    const dispose = vi.fn(async () => {})
    this.disposed.push(dispose)
    return {
      id: SessionId(`dsh-autopilot-child-${index}`),
      localAgent: undefined,
      result: 'resultError' in outcome ? Promise.reject(outcome.resultError) : Promise.resolve(outcome),
      dispose,
    }
  }
}

/** Return a valid result for either a reviewer lane or task-worker lane. */
function defaultSubagentResult(request: ResolvedSubagentStartRequest): SubagentResult {
  if (request.label?.startsWith('autopilot-review-') === true) {
    return {
      output: [],
      stopReason: 'completed',
      structured: { verdict: 'pass', summary: 'independent review passed', findings: [] },
    }
  }
  return {
    output: [],
    stopReason: 'completed',
    structured: {
      status: 'completed',
      summary: 'delegated task completed',
      evidence: [{ kind: 'subagent', ref: request.label ?? 'autopilot-worker', summary: 'worker evidence' }],
    },
  }
}

afterEach(async () => {
  await Promise.allSettled([...openTestContexts].map(ctx => ctx.fiber.dispose()))
  openTestContexts.clear()
})

/** Mutable deterministic shell backend for verifier tests. */
export class TestShell extends ShellExecutor {
  readonly requests: ShellExecSpec[] = []
  readonly outcomes: Array<ShellRunResult | Error> = []

  constructor(ctx: Context) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/test-workspace',
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 16_384,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.requests.push(spec)
    const outcome = this.outcomes.shift() ?? shellResult()
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('background shell is not used by verifier tests')
  }
}

/** Build a complete shell result with concise overrides. */
export function shellResult(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/** Create a registry-compatible top-level Agent. */
export function createTestAgent(rawId = `dsh-autopilot-${Math.random()}`, cwd?: string): Agent {
  const id = SessionId(rawId)
  const base = Session.create(id)
  const session = cwd === undefined
    ? base
    : Session.create(id, [], { ...base.header, cwd })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send() {},
    followup: vi.fn(),
    steer() {},
    inject(message) { inbox.append('next-step', message) },
    cancel: vi.fn(),
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Build the real JSON-backed DSH storage stack used by durable-state tests. */
export async function createStorageHarness(storageRoot?: string): Promise<{
  readonly ctx: Context
  readonly storageRoot: string
}> {
  const ownsRoot = storageRoot === undefined
  const root = storageRoot ?? await mkdtemp(join(tmpdir(), 'dsh-autopilot-test-'))
  const ctx = new Context()
  openTestContexts.add(ctx)
  if (ownsRoot) {
    ctx.effect(() => async () => {
      await rm(root, { recursive: true, force: true })
    }, 'dsh-autopilot.testStorageCleanup')
  }
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await vi.waitFor(() => { expectStorageDomain(ctx) })
  return { ctx, storageRoot: root }
}

/** Build only the services required to exercise the durable Autonomy service. */
export async function createServiceHarness(options: {
  autonomy?: AutonomyServiceConfig
  storageRoot?: string
  agentId?: string
} = {}) {
  const { ctx, storageRoot } = await createStorageHarness(options.storageRoot)
  await ctx.plugin(SessionStore)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const autonomyFiber = await ctx.plugin(AutonomyService, options.autonomy ?? {})
  const agent = options.agentId === undefined ? createTestAgent() : createTestAgent(options.agentId)
  ctx.effect(() => ctx.sessions.enter(agent.session), 'dsh-autopilot.testSession')
  ctx.agents.register(agent)
  return { ctx, agent, autonomyFiber, storageRoot }
}

/** Advance a fixture run through interview, planning, and the fixed three-role plan review. */
export async function prepareTestPlan(
  ctx: Context,
  agent: Agent,
  acceptanceCriteria: readonly string[],
  tasks: readonly PlannedTaskInput[],
): Promise<void> {
  await ctx.autonomy.recordInterview(agent, {
    summary: 'The fixture objective and repository constraints are understood.',
    decisions: ['Use the bounded fixture plan.'],
    openQuestions: [],
  })
  await ctx.autonomy.setPlan(agent, acceptanceCriteria, tasks)
  const reviewing = await ctx.autonomy.beginPlanReview(agent)
  const planRevision = reviewing.plan?.revision
  if (planRevision === undefined) throw new Error('fixture plan is missing')
  await ctx.autonomy.settlePlanReview(agent, planRevision, [
    { role: 'metis', verdict: 'advice', summary: 'requirements are explicit', findings: [], recommendations: [] },
    { role: 'momus', verdict: 'advice', summary: 'plan is executable', findings: [], recommendations: [] },
    { role: 'oracle', verdict: 'advice', summary: 'architecture is sound', findings: [], recommendations: [] },
  ])
}

/** Fail a storage harness setup if the injected form did not activate. */
function expectStorageDomain(ctx: Context): void {
  if (ctx.get('storageDomain') === undefined) throw new Error('storageDomain did not activate')
}

/** Fully assembled host services used by command and tool integration tests. */
export async function createHarness(options: {
  autonomy?: AutonomyServiceConfig
  tools?: ToolsConfig
  storageRoot?: string
  agentId?: string
  cwd?: string
  dynamicCordisRunner?: boolean
  missionService?: boolean
  missingRecoveryContribution?: RecoveryCriticalContribution
} = {}) {
  const { ctx, storageRoot } = await createStorageHarness(options.storageRoot)
  await ctx.plugin(SessionStore)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TestShell)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AutopilotRecoveryReadiness)
  const recoveryContributionDisposers = new Map<RecoveryCriticalContribution, () => void>()
  for (const contribution of RECOVERY_CRITICAL_CONTRIBUTIONS) {
    if (contribution === options.missingRecoveryContribution
      || contribution === 'commands' || contribution === 'tools') continue
    const dispose = ctx.autopilotRecoveryReadiness.register(contribution)
    recoveryContributionDisposers.set(contribution, dispose)
    ctx.effect(() => dispose, `dsh-autopilot.testRecoveryReady(${contribution})`)
  }
  vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([])
  let dynamicCordisRunnerFiber: Fiber | undefined
  if (options.dynamicCordisRunner !== false) {
    dynamicCordisRunnerFiber = await ctx.plugin(DynamicCordisRunnerService)
  }
  const subagents = new TestSubagentProvider()
  ctx.effect(() => ctx.subagents.registerProvider(subagents), 'dsh-autopilot.testSubagentProvider')
  const autonomyFiber = await ctx.plugin(AutonomyService, options.autonomy ?? { selfModification: 'host-only' })
  if (options.missionService !== false) await ctx.plugin(MissionService)
  await ctx.plugin(AutopilotRunDashboardService)
  await ctx.plugin(commandsPlugin)
  const toolsFiber = await ctx.plugin(toolsPlugin, options.tools ?? {
    checks: [{ name: 'quality', command: 'pnpm test', timeoutMs: 5000 }],
    reviewers: [{ role: 'requirements', description: 'Audit every acceptance criterion.' }],
  })
  const agent = createTestAgent(options.agentId, options.cwd)
  ctx.effect(() => ctx.sessions.enter(agent.session), 'dsh-autopilot.testSession')
  await ctx.plugin(Object.assign((inner: Context) => {
    const scope = createScope(inner, agent)
    Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  }, { inject: ['tools', 'systemPrompt'] }))
  ctx.agents.register(agent)
  return {
    ctx,
    agent,
    shell: ctx.shell as TestShell,
    subagents,
    dynamicCordisRunner: ctx.get('dynamicCordisRunner') as Context['dynamicCordisRunner'],
    dynamicCordisRunnerFiber,
    autonomyFiber,
    toolsFiber,
    recoveryContributionDisposers,
    storageRoot,
  }
}
