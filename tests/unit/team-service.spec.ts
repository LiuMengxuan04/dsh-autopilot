import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import ContinuableTeamService, {
  DEFAULT_TEAM_TOOL_ALLOWLIST,
} from '../../src/team-service.ts'
import type {
  ContinuableTeamConfig,
  ManagedContinuableStart,
} from '../../src/team-service.ts'
import type { AutonomyLeaseView } from '../../src/service.ts'
import type { PlannedTaskInput } from '../../src/run-state.ts'
import {
  prepareTeamThread,
  settleTeamThread,
  teamChildLabel,
} from '../../src/team-state.ts'
import type { TeamThreadSnapshot } from '../../src/team-state.ts'
import { DurableTeamStore } from '../../src/team-store.ts'
import { createServiceHarness, createTestAgent, prepareTestPlan } from '../helpers.ts'

function task(id: string, dependencies: readonly string[] = []): PlannedTaskInput {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    acceptanceCriteria: [`${id} accepted`],
    dependencies,
  }
}

function createChild(parent: Agent, rawId: string): Agent {
  const id = SessionId(rawId)
  const base = Session.create(id)
  const session = Session.create(id, [], {
    ...base.header,
    parentSession: parent.id,
    origin: 'subagent',
    delegationDepth: 1,
  })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  return {
    id,
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
    runMaintenance: work => work(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function setup(options: {
  readonly config?: ContinuableTeamConfig
  readonly tasks?: readonly PlannedTaskInput[]
} = {}) {
  const harness = await createServiceHarness({
    autonomy: { maxSubagents: 16, maxConcurrentSubagents: 4 },
  })
  await harness.ctx.plugin(SystemPrompt)
  await harness.ctx.plugin(ToolRuntime)
  await harness.ctx.plugin(SubagentRuntime)
  const descendants = vi.spyOn(harness.ctx.subagents, 'listDescendants').mockResolvedValue([])
  const followup = vi.spyOn(harness.ctx.subagents, 'followup').mockResolvedValue(MessageId('followup-message'))
  const reportFrom = vi.spyOn(harness.ctx.subagents, 'reportFrom').mockResolvedValue(MessageId('report-message'))
  const interrupt = vi.spyOn(harness.ctx.subagents, 'interrupt')
  const teamFiber = await harness.ctx.plugin(ContinuableTeamService, options.config ?? {})
  await vi.waitFor(() => {
    expect(harness.ctx.tools).toBeDefined()
    expect(harness.ctx.autopilotTeam).toBeDefined()
  })
  const goal = harness.ctx.goals.create(harness.agent, { objective: 'exercise continuable team' })
  await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
  await prepareTestPlan(
    harness.ctx,
    harness.agent,
    ['team tasks settle'],
    options.tasks ?? [task('build')],
  )
  return { ...harness, goal, descendants, followup, reportFrom, interrupt, teamFiber }
}

function managedStart(
  childId = 'team-child',
  messageId = 'initial-message',
): ReturnType<typeof vi.fn<ManagedContinuableStart>> {
  return vi.fn<ManagedContinuableStart>(async () => ({
    childId: SessionId(childId),
    messageId: MessageId(messageId),
  }))
}

function registerChild(ctx: Context, parent: Agent, childId = 'team-child'): Agent {
  const child = createChild(parent, childId)
  ctx.effect(() => ctx.sessions.enter(child.session), 'dsh-autopilot.teamTestChildSession')
  ctx.agents.register(child)
  return child
}

async function registerRunningRoot(ctx: Context, rawId: string): Promise<{
  readonly agent: Agent
  readonly dispose: () => void
}> {
  const agent = createTestAgent(rawId)
  ctx.effect(() => ctx.sessions.enter(agent.session), `dsh-autopilot.teamTestRoot.${rawId}`)
  const dispose = ctx.agents.register(agent)
  const goal = ctx.goals.create(agent, { objective: `exercise ${rawId}` })
  await ctx.autonomy.start(agent, { goalId: goal.id })
  await prepareTestPlan(ctx, agent, [`${rawId} settles`], [task('build')])
  return { agent, dispose }
}

function storeOf(service: ContinuableTeamService): DurableTeamStore {
  const store = (service as unknown as { store?: DurableTeamStore }).store
  if (store === undefined) throw new Error('team store unavailable in test')
  return store
}

async function prepareOnly(
  harness: Awaited<ReturnType<typeof setup>>,
  taskId = 'build',
): Promise<TeamThreadSnapshot> {
  const claimed = await harness.ctx.autonomy.claimTasks(harness.agent, [taskId])
  const snapshot = prepareTeamThread({
    parentSessionId: String(harness.agent.id),
    runId: claimed.id,
    generation: claimed.generation,
    runRevisionAtClaim: claimed.revision,
    maxAuditRecords: claimed.maxAuditRecords,
    maxAuditBytes: claimed.maxAuditBytes,
    taskId,
    provider: 'spawn',
    label: teamChildLabel(claimed.id, claimed.generation, taskId),
    role: 'worker',
    promptSha256: 'a'.repeat(64),
  }, Date.now())
  await storeOf(harness.ctx.autopilotTeam).append('prepare', snapshot)
  return snapshot
}

interface TeamServiceInternals {
  settleAcceptedReport(parent: Agent, thread: TeamThreadSnapshot): Promise<TeamThreadSnapshot>
  exactThread(thread: TeamThreadSnapshot): TeamThreadSnapshot
  assertThreadRun(thread: TeamThreadSnapshot, lease: AutonomyLeaseView): void
  markAutonomyAttention(parent: Agent, lease: AutonomyLeaseView, reason: string): Promise<void>
  failClosedThread(parent: Agent, thread: TeamThreadSnapshot, reason: string): Promise<void>
}

function internals(service: ContinuableTeamService): TeamServiceInternals {
  return service as unknown as TeamServiceInternals
}

const completedEvidence = [{ kind: 'test' as const, ref: 'pnpm test', summary: 'focused tests passed' }]

describe('continuable team service', () => {
  it('claims before Host-managed start, records every mailbox id, and settles the exact DAG task', async () => {
    const harness = await setup({
      config: {
        provider: 'fork',
        agentProvider: 'deepseek',
        agentModel: 'worker-model',
        persona: 'Exact team worker.',
        toolAllowlist: ['allowed', 'missing'],
        reportDelivery: 'quiet',
      },
    })
    harness.ctx.tools.register(defineTool({
      name: 'allowed',
      description: 'test tool',
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [] },
      async execute() { return null },
    }))
    const start = managedStart()
    const thread = await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: ' implementer ', prompt: ' implement and test ',
      signal: new AbortController().signal, startContinuable: start,
    })
    expect(start).toHaveBeenCalledOnce()
    const spec = start.mock.calls[0]?.[0]
    expect(spec).toBeDefined()
    expect(spec).toMatchObject({
      provider: 'fork',
      label: expect.stringMatching(/^dsh-autopilot-team:/u),
      request: {
        maxDepth: 1,
        toolFilter: { allow: ['allowed'] },
        persona: 'Exact team worker.',
        agentOptions: { provider: 'deepseek', model: 'worker-model' },
      },
    })
    expect(spec?.request.parent).toBe(harness.agent)
    expect(spec?.request.prompt[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('Task: build'),
    })
    expect(thread).toMatchObject({
      runId: expect.any(String), generation: 1, taskId: 'build', phase: 'active',
      childSessionId: 'team-child',
      messages: [{ kind: 'initial', messageId: 'initial-message' }],
    })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      subagentsStarted: 1,
      plan: { tasks: [{ id: 'build', status: 'in_progress' }] },
    })

    const followed = await harness.ctx.autopilotTeam.followup(harness.agent, {
      taskId: 'build', message: ' continue with tests ', signal: new AbortController().signal,
    })
    expect(harness.followup).toHaveBeenCalledWith(
      harness.agent,
      SessionId('team-child'),
      [{ type: 'text', text: 'continue with tests' }],
      expect.objectContaining({ source: { kind: 'plugin', plugin: 'dsh-autopilot-team' } }),
    )
    expect(followed.messages.at(-1)).toMatchObject({ kind: 'followup', messageId: 'followup-message' })

    const interrupted = await harness.ctx.autopilotTeam.interrupt(harness.agent, 'build', ' inspect first ')
    expect(interrupted).toMatchObject({ phase: 'interrupted', childSessionId: 'team-child' })
    expect(harness.interrupt).toHaveBeenCalledWith(SessionId('team-child'), {
      kind: 'user', parentSessionId: harness.agent.id,
    })
    await expect(harness.ctx.autopilotTeam.interrupt(harness.agent, 'build', 'again')).resolves.toEqual(interrupted)

    harness.followup.mockResolvedValueOnce(MessageId('resume-message'))
    await harness.ctx.autopilotTeam.followup(harness.agent, {
      taskId: 'build', message: 'resume', signal: new AbortController().signal,
    })
    const child = registerChild(harness.ctx, harness.agent)
    const settled = await harness.ctx.autopilotTeam.report(child, {
      status: 'completed', summary: ' implemented and verified ', evidence: completedEvidence,
    }, new AbortController().signal)
    expect(harness.reportFrom).toHaveBeenCalledWith(
      child,
      [expect.objectContaining({ type: 'text', text: expect.stringContaining('"taskId":"build"') })],
      expect.objectContaining({ delivery: 'quiet' }),
    )
    expect(settled).toMatchObject({
      phase: 'settled',
      report: { status: 'completed', summary: 'implemented and verified', messageId: 'report-message' },
    })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({
      status: 'completed', evidence: completedEvidence,
    })
    expect(harness.ctx.autopilotTeam.list(harness.agent)).toEqual([settled])
    expect(harness.ctx.autopilotTeam.orphans(harness.agent)).toEqual([])
    await expect(harness.ctx.autopilotTeam.report(child, {
      status: 'failed', summary: 'duplicate', evidence: [],
    }, new AbortController().signal)).rejects.toBeInstanceOf(Error)
    await harness.ctx.fiber.dispose()
  })

  it('records rejected starts and messages, and settles blocked and failed reports', async () => {
    const harness = await setup({ tasks: [task('start-fails'), task('blocked'), task('failed')] })
    const startError = new Error('transport unavailable')
    const rejected = vi.fn<ManagedContinuableStart>(async () => { throw startError })
    await expect(harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'start-fails', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: rejected,
    })).rejects.toBe(startError)
    expect(harness.ctx.autopilotTeam.list(harness.agent)[0]).toMatchObject({
      taskId: 'start-fails', phase: 'failed', reason: 'transport unavailable',
    })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({ status: 'failed' })

    const startBlocked = managedStart('blocked-child', 'blocked-initial')
    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'blocked', role: 'worker', prompt: 'blocked work',
      signal: new AbortController().signal, startContinuable: startBlocked,
    })
    harness.followup.mockRejectedValueOnce(new Error('not admitted'))
    await expect(harness.ctx.autopilotTeam.followup(harness.agent, {
      taskId: 'blocked', message: 'next', signal: new AbortController().signal,
    })).rejects.toThrow('not admitted')
    expect(harness.ctx.autopilotTeam.list(harness.agent).find(item => item.taskId === 'blocked'))
      .toMatchObject({ phase: 'active', lastError: 'not admitted' })
    const blockedChild = registerChild(harness.ctx, harness.agent, 'blocked-child')
    await expect(harness.ctx.autopilotTeam.report(blockedChild, {
      status: 'blocked', summary: 'dependency unavailable', evidence: [],
    }, new AbortController().signal)).resolves.toMatchObject({ phase: 'settled' })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[1]).toMatchObject({ status: 'blocked' })

    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'failed', role: 'worker', prompt: 'failing work',
      signal: new AbortController().signal, startContinuable: managedStart('failed-child', 'failed-initial'),
    })
    const failedChild = registerChild(harness.ctx, harness.agent, 'failed-child')
    await harness.ctx.autopilotTeam.report(failedChild, {
      status: 'failed', summary: 'implementation failed', evidence: [],
    }, new AbortController().signal)
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[2]).toMatchObject({ status: 'failed' })

    await expect(harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'blocked', role: 'worker', prompt: 'duplicate',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_CONFLICT' })
    await harness.ctx.fiber.dispose()
  })

  it('interrupts active turns on pause and stop, then cold-resumes without a second child', async () => {
    const harness = await setup()
    const start = managedStart()
    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: start,
    })
    await harness.ctx.autonomy.pause(harness.agent, 'operator pause')
    expect(harness.ctx.autopilotTeam.list(harness.agent)[0]).toMatchObject({
      phase: 'interrupted', childSessionId: 'team-child',
    })
    expect(harness.interrupt).toHaveBeenCalled()

    await harness.ctx.autonomy.resume(harness.agent, harness.goal.id)
    await harness.ctx.autopilotTeam.followup(harness.agent, {
      taskId: 'build', message: 'resume after pause', signal: new AbortController().signal,
    })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({ status: 'in_progress' })
    expect(start).toHaveBeenCalledOnce()

    const label = harness.ctx.autopilotTeam.list(harness.agent)[0]!.label
    await harness.teamFiber.dispose()
    harness.descendants.mockResolvedValue([{
      kind: 'child', id: SessionId('team-child'), activity: 'inactive', hasChildren: false,
      mode: 'continuable', label,
      parentId: harness.agent.id, depth: 1,
    }])
    await harness.ctx.plugin(ContinuableTeamService)
    await vi.waitFor(() => expect(harness.ctx.autopilotTeam).toBeDefined())
    await expect(harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'must not duplicate',
      signal: new AbortController().signal, startContinuable: start,
    })).rejects.toBeInstanceOf(Error)
    expect(start).toHaveBeenCalledOnce()
    await harness.ctx.autonomy.revoke(harness.agent, 'operator stop')
    expect(harness.interrupt).toHaveBeenCalledWith(SessionId('team-child'), expect.objectContaining({ kind: 'user' }))
    expect(harness.ctx.autopilotTeam.list(harness.agent)[0]?.childSessionId).toBe('team-child')
    await harness.ctx.fiber.dispose()
  })

  it('resumes an accepted report settlement after an Autonomy mutation failure', async () => {
    const harness = await setup()
    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const label = harness.ctx.autopilotTeam.list(harness.agent)[0]!.label
    harness.descendants.mockResolvedValue([{
      kind: 'child', id: SessionId('team-child'), activity: 'inactive', hasChildren: false,
      mode: 'continuable', label, parentId: harness.agent.id, depth: 1,
    }])
    const child = registerChild(harness.ctx, harness.agent)
    const update = vi.spyOn(harness.ctx.autonomy, 'updateTask')
    update.mockRejectedValueOnce(new Error('sidecar temporarily unavailable'))
    await expect(harness.ctx.autopilotTeam.report(child, {
      status: 'completed', summary: 'done', evidence: completedEvidence,
    }, new AbortController().signal)).rejects.toThrow('sidecar temporarily unavailable')
    expect(harness.ctx.autopilotTeam.list(harness.agent)[0]).toMatchObject({ phase: 'reporting' })
    await expect(harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal))
      .resolves.toMatchObject({ resumedSettlements: 1, issues: [] })
    expect(harness.ctx.autopilotTeam.list(harness.agent)[0]).toMatchObject({ phase: 'settled' })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({ status: 'completed' })
    await harness.ctx.fiber.dispose()
  })

  it('fails closed on accepted-but-unpersisted starts and mailbox messages', async () => {
    const startHarness = await setup()
    const startStore = storeOf(startHarness.ctx.autopilotTeam)
    const originalStartAppend = startStore.append.bind(startStore)
    const startAppend = vi.spyOn(startStore, 'append')
    startAppend.mockImplementation((operation, snapshot) => operation === 'start'
      ? Promise.reject(new Error('start ledger write failed'))
      : originalStartAppend(operation, snapshot))
    await expect(startHarness.ctx.autopilotTeam.start(startHarness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })).rejects.toThrow('start ledger write failed')
    expect(startHarness.ctx.autopilotTeam.orphans(startHarness.agent)[0]).toMatchObject({
      childSessionId: 'team-child', initialMessageId: 'initial-message',
    })
    expect(startHarness.ctx.autonomy.get(startHarness.agent)).toMatchObject({ phase: 'needs-attention' })
    await startHarness.ctx.fiber.dispose()

    const followupHarness = await setup()
    await followupHarness.ctx.autopilotTeam.start(followupHarness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const followupStore = storeOf(followupHarness.ctx.autopilotTeam)
    const originalFollowupAppend = followupStore.append.bind(followupStore)
    vi.spyOn(followupStore, 'append').mockImplementation((operation, snapshot) =>
      operation === 'followup-accepted'
        ? Promise.reject(new Error('followup ledger write failed'))
        : originalFollowupAppend(operation, snapshot))
    await expect(followupHarness.ctx.autopilotTeam.followup(followupHarness.agent, {
      taskId: 'build', message: 'accepted then crash', signal: new AbortController().signal,
    })).rejects.toThrow('followup ledger write failed')
    expect(followupHarness.ctx.autopilotTeam.list(followupHarness.agent)[0]).toMatchObject({
      phase: 'needs-attention', pendingMessage: { kind: 'followup' },
    })
    expect(followupHarness.ctx.autonomy.get(followupHarness.agent)).toMatchObject({ phase: 'needs-attention' })
    await expect(followupHarness.ctx.autopilotTeam.reconcile(
      followupHarness.agent,
      new AbortController().signal,
    )).resolves.toMatchObject({ issues: [expect.stringContaining('unknown acceptance')] })
    await followupHarness.ctx.fiber.dispose()
  })

  it('records rejected reports and fails closed when an accepted report receipt cannot persist', async () => {
    const rejected = await setup()
    await rejected.ctx.autopilotTeam.start(rejected.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const rejectedChild = registerChild(rejected.ctx, rejected.agent)
    rejected.reportFrom.mockRejectedValueOnce(new Error('parent inbox rejected'))
    await expect(rejected.ctx.autopilotTeam.report(rejectedChild, {
      status: 'failed', summary: 'could not finish', evidence: [],
    }, new AbortController().signal)).rejects.toThrow('parent inbox rejected')
    expect(rejected.ctx.autopilotTeam.list(rejected.agent)[0]).toMatchObject({
      phase: 'active', lastError: 'parent inbox rejected',
    })
    await rejected.ctx.fiber.dispose()

    const uncertain = await setup()
    await uncertain.ctx.autopilotTeam.start(uncertain.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const uncertainChild = registerChild(uncertain.ctx, uncertain.agent)
    const store = storeOf(uncertain.ctx.autopilotTeam)
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation((operation, snapshot) =>
      operation === 'report-accepted'
        ? Promise.reject(new Error('report receipt disk failure'))
        : append(operation, snapshot))
    await expect(uncertain.ctx.autopilotTeam.report(uncertainChild, {
      status: 'failed', summary: 'failed', evidence: [],
    }, new AbortController().signal)).rejects.toThrow('report receipt disk failure')
    expect(uncertain.ctx.autopilotTeam.list(uncertain.agent)[0]).toMatchObject({
      phase: 'needs-attention', pendingMessage: { kind: 'report' },
    })
    expect(uncertain.ctx.autonomy.get(uncertain.agent)).toMatchObject({ phase: 'needs-attention' })
    await uncertain.ctx.fiber.dispose()
  })

  it('rejects starts after a preflight issue and preserves non-Error transport failures', async () => {
    const preflight = await setup()
    let postAuditGet: ReturnType<typeof vi.spyOn> | undefined
    preflight.descendants.mockImplementationOnce(async () => {
      postAuditGet = vi.spyOn(preflight.ctx.autonomy, 'get').mockReturnValue(undefined)
      return [{
        kind: 'child' as const, id: SessionId('unknown'), activity: 'inactive' as const, hasChildren: false,
        mode: 'continuable' as const, label: 'foreign', parentId: preflight.agent.id, depth: 1,
      }]
    })
    const blockedStart = managedStart()
    await expect(preflight.ctx.autopilotTeam.start(preflight.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: blockedStart,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_UNCERTAIN' })
    expect(blockedStart).not.toHaveBeenCalled()
    postAuditGet?.mockRestore()
    await preflight.ctx.fiber.dispose()

    const transport = await setup()
    const failure = vi.fn<ManagedContinuableStart>(async () => { throw 'transport string' })
    await expect(transport.ctx.autopilotTeam.start(transport.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: failure,
    })).rejects.toBe('transport string')
    expect(transport.ctx.autopilotTeam.list(transport.agent)[0]).toMatchObject({
      phase: 'failed', reason: 'transport string',
    })
    await transport.ctx.fiber.dispose()

    const paused = await setup()
    const pauseThenReject = vi.fn<ManagedContinuableStart>(async () => {
      await paused.ctx.autonomy.pause(paused.agent, 'transport paused')
      throw new Error('rejected after pause')
    })
    await expect(paused.ctx.autopilotTeam.start(paused.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: pauseThenReject,
    })).rejects.toThrow('rejected after pause')
    expect(paused.ctx.autonomy.get(paused.agent)?.plan?.tasks[0]).toMatchObject({ status: 'pending' })
    await paused.ctx.fiber.dispose()
  })

  it('detects missing child bindings, invalid DAG status, absent parents, and stale run ownership', async () => {
    const starting = await setup()
    const prepared = await prepareOnly(starting)
    await expect(starting.ctx.autopilotTeam.followup(starting.agent, {
      taskId: 'build', message: 'cannot deliver yet', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_MISSING' })
    await expect(starting.ctx.autopilotTeam.interrupt(starting.agent, 'build', 'not accepted'))
      .rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_CONFLICT' })
    await expect(starting.ctx.autopilotTeam.reconcile(starting.agent, new AbortController().signal))
      .resolves.toMatchObject({ issues: [expect.stringContaining('unfinished child-start intent')] })
    await expect(starting.ctx.autopilotTeam.start(starting.agent, {
      taskId: 'build', role: 'worker', prompt: 'duplicate',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })).rejects.toBeInstanceOf(Error)
    await starting.ctx.fiber.dispose()

    const status = await setup()
    await status.ctx.autopilotTeam.start(status.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const statusLease = status.ctx.autonomy.get(status.agent)!
    const getStatus = vi.spyOn(status.ctx.autonomy, 'get').mockReturnValue({
      ...statusLease,
      plan: { ...statusLease.plan!, tasks: [] },
    })
    await expect(status.ctx.autopilotTeam.followup(status.agent, {
      taskId: 'build', message: 'missing task', signal: new AbortController().signal,
    })).rejects.toThrow('DAG status is missing')
    getStatus.mockRestore()
    await status.ctx.autonomy.updateTask(status.agent, 'build', 'block', { reason: 'operator block' })
    await expect(status.ctx.autopilotTeam.followup(status.agent, {
      taskId: 'build', message: 'not allowed', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_CONFLICT' })
    await expect(status.ctx.autopilotTeam.interrupt(status.agent, 'build', 'not active DAG'))
      .resolves.toMatchObject({ phase: 'interrupted' })
    await expect(status.ctx.autopilotTeam.interrupt(status.agent, 'build', 'already interrupted'))
      .resolves.toMatchObject({ phase: 'interrupted' })
    await status.ctx.fiber.dispose()

    const ownership = await setup()
    await ownership.ctx.autopilotTeam.start(ownership.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const child = registerChild(ownership.ctx, ownership.agent)
    const active = ownership.ctx.autopilotTeam.list(ownership.agent)[0]!
    await expect(internals(ownership.ctx.autopilotTeam).settleAcceptedReport(ownership.agent, active))
      .rejects.toThrow('not durably accepted')
    const getAgent = ownership.ctx.agents.get.bind(ownership.ctx.agents)
    const getSpy = vi.spyOn(ownership.ctx.agents, 'get').mockImplementation(id =>
      id === ownership.agent.id ? undefined : getAgent(id))
    await expect(ownership.ctx.autopilotTeam.report(child, {
      status: 'failed', summary: 'parent gone', evidence: [],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_MISSING' })
    getSpy.mockRestore()
    const lease = ownership.ctx.autonomy.get(ownership.agent)!
    expect(() => internals(ownership.ctx.autopilotTeam).assertThreadRun(
      ownership.ctx.autopilotTeam.list(ownership.agent)[0]!,
      { ...lease, id: 'different-run' },
    )).toThrow(/different run generation/u)
    expect(() => internals(ownership.ctx.autopilotTeam).exactThread(prepared)).toThrow(/changed/u)
    await expect(internals(ownership.ctx.autopilotTeam).failClosedThread(
      createTestAgent('missing-run'),
      prepared,
      'already removed',
    )).resolves.toBeUndefined()
    await expect(ownership.ctx.autopilotTeam.reconcile(
      createTestAgent('no-autonomy-run'),
      new AbortController().signal,
    )).resolves.toEqual({ inspected: 0, resumedSettlements: 0, orphaned: 0, issues: [] })
    await ownership.ctx.fiber.dispose()
  })

  it('restarts accepted report settlement idempotently across every durable crash window', async () => {
    const harness = await setup({ tasks: [task('build'), task('later')] })
    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const child = registerChild(harness.ctx, harness.agent)
    const store = storeOf(harness.ctx.autopilotTeam)
    const append = store.append.bind(store)
    let rejectSettlement = true
    vi.spyOn(store, 'append').mockImplementation((operation, snapshot) => {
      if (operation === 'settle' && rejectSettlement) {
        rejectSettlement = false
        return Promise.reject(new Error('settlement ledger unavailable'))
      }
      return append(operation, snapshot)
    })
    await expect(harness.ctx.autopilotTeam.report(child, {
      status: 'completed', summary: 'done', evidence: completedEvidence,
    }, new AbortController().signal)).rejects.toThrow('settlement ledger unavailable')
    const reporting = harness.ctx.autopilotTeam.list(harness.agent)[0]!
    expect(reporting.phase).toBe('reporting')
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]?.status).toBe('completed')

    const realLease = harness.ctx.autonomy.get(harness.agent)!
    const get = vi.spyOn(harness.ctx.autonomy, 'get')
    get.mockReturnValue({
      ...realLease,
      plan: { ...realLease.plan!, tasks: [] },
    })
    await expect(internals(harness.ctx.autopilotTeam).settleAcceptedReport(harness.agent, reporting))
      .rejects.toThrow('disappeared')
    get.mockReturnValue({
      ...realLease,
      plan: {
        ...realLease.plan!,
        tasks: realLease.plan!.tasks.map(candidate => candidate.id === 'build'
          ? { ...candidate, status: 'pending' as const }
          : candidate),
      },
    })
    await expect(internals(harness.ctx.autopilotTeam).settleAcceptedReport(harness.agent, reporting))
      .rejects.toThrow('conflicts with DAG status')
    get.mockReturnValue({ ...realLease, phase: 'verifying', activation: 'armed' })
    await expect(harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal))
      .resolves.toMatchObject({ resumedSettlements: 1 })
    get.mockRestore()

    const settled = harness.ctx.autopilotTeam.list(harness.agent)[0]!
    await expect(internals(harness.ctx.autopilotTeam).settleAcceptedReport(harness.agent, settled))
      .resolves.toEqual(settled)
    await expect(internals(harness.ctx.autopilotTeam).settleAcceptedReport(
      harness.agent,
      { ...settled, revision: settled.revision - 1, phase: 'active', report: undefined },
    )).resolves.toEqual(settled)

    await prepareOnly(harness, 'later')
    await harness.ctx.autonomy.pause(harness.agent, 'lifecycle coverage')
    expect(harness.interrupt).not.toHaveBeenCalledWith(SessionId('team-child'), expect.anything())
    await harness.ctx.fiber.dispose()
  })

  it('returns a concurrent settlement winner instead of appending a duplicate revision', async () => {
    const harness = await setup()
    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const child = registerChild(harness.ctx, harness.agent)
    const store = storeOf(harness.ctx.autopilotTeam)
    const updateTask = harness.ctx.autonomy.updateTask.bind(harness.ctx.autonomy)
    vi.spyOn(harness.ctx.autonomy, 'updateTask').mockImplementationOnce(async (...args) => {
      const view = await updateTask(...args)
      const reporting = harness.ctx.autopilotTeam.list(harness.agent)[0]!
      await store.append('settle', settleTeamThread(reporting, Date.now()))
      return view
    })
    await expect(harness.ctx.autopilotTeam.report(child, {
      status: 'completed', summary: 'done', evidence: completedEvidence,
    }, new AbortController().signal)).resolves.toMatchObject({ phase: 'settled' })
    expect(store.history()).toHaveLength(5)
    await harness.ctx.fiber.dispose()
  })

  it('reconciles unknown continuable descendants and ignores unrelated rows', async () => {
    const harness = await setup()
    harness.descendants.mockResolvedValue([
      {
        kind: 'child', id: SessionId('one-shot'), activity: 'running', hasChildren: false,
        mode: 'one-shot', label: 'reviewer', parentId: harness.agent.id, depth: 1,
      },
      {
        kind: 'diagnostic', id: SessionId('diagnostic'), reason: 'unavailable',
        parentId: harness.agent.id, depth: 1,
      },
      {
        kind: 'child', id: SessionId('unknown'), activity: 'inactive', hasChildren: false,
        mode: 'continuable', label: 'foreign', parentId: harness.agent.id, depth: 1,
      },
    ])
    const result = await harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal)
    expect(result).toMatchObject({ inspected: 3, orphaned: 1 })
    expect(result.issues[0]).toContain('unknown')
    expect(harness.ctx.autopilotTeam.orphans(harness.agent)[0]).toMatchObject({ childSessionId: 'unknown' })
    expect(harness.interrupt).toHaveBeenCalledWith(SessionId('unknown'), {
      kind: 'user', parentSessionId: harness.agent.id,
    })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ phase: 'needs-attention' })
    await harness.ctx.fiber.dispose()
  })

  it('marks descendant-audit failures and mismatched known lineage as attention', async () => {
    const failed = await setup()
    failed.descendants.mockRejectedValueOnce(new Error('catalog offline'))
    await expect(failed.ctx.autopilotTeam.reconcile(failed.agent, new AbortController().signal))
      .rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_UNCERTAIN' })
    expect(failed.ctx.autonomy.get(failed.agent)).toMatchObject({ phase: 'needs-attention' })
    await failed.ctx.fiber.dispose()

    const mismatch = await setup()
    await mismatch.ctx.autopilotTeam.start(mismatch.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })
    const label = mismatch.ctx.autopilotTeam.list(mismatch.agent)[0]!.label
    mismatch.descendants.mockResolvedValue([{
      kind: 'child', id: SessionId('team-child'), activity: 'running', hasChildren: false,
      mode: 'continuable', label: `${label}-wrong`, parentId: SessionId('other'), depth: 2,
    }])
    await expect(mismatch.ctx.autopilotTeam.reconcile(mismatch.agent, new AbortController().signal))
      .resolves.toMatchObject({ orphaned: 0, issues: [expect.stringContaining('does not match')] })
    expect(mismatch.ctx.autopilotTeam.list(mismatch.agent)[0]).toMatchObject({ phase: 'needs-attention' })
    await mismatch.ctx.fiber.dispose()
  })

  it('validates authorization, task inputs, reports, and exact Agent ownership', async () => {
    const harness = await setup()
    const start = managedStart()
    for (const input of [
      { taskId: 'Bad', role: 'worker', prompt: 'x' },
      { taskId: 'build', role: ' ', prompt: 'x' },
      { taskId: 'build', role: 'worker', prompt: ' ' },
      { taskId: 'build', role: 'worker', prompt: 'x'.repeat(32_001) },
    ]) {
      await expect(harness.ctx.autopilotTeam.start(harness.agent, {
        ...input, signal: new AbortController().signal, startContinuable: start,
      })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_INVALID' })
    }
    await expect(harness.ctx.autopilotTeam.followup(harness.agent, {
      taskId: 'missing', message: 'x', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_MISSING' })
    await expect(harness.ctx.autopilotTeam.interrupt(harness.agent, 'missing', 'x'))
      .rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_MISSING' })

    await harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: start,
    })
    const goal = harness.ctx.goals.get(harness.agent)!
    const getGoal = vi.spyOn(harness.ctx.goals, 'get')
    for (const invalidGoal of [
      undefined,
      { ...goal, id: 'different-goal' as typeof goal.id },
      { ...goal, activation: 'disarmed' as const },
      { ...goal, phase: 'complete' as const },
    ]) {
      getGoal.mockReturnValueOnce(invalidGoal)
      await expect(harness.ctx.autopilotTeam.interrupt(harness.agent, 'build', 'unauthorized'))
        .rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_INVALID' })
    }
    getGoal.mockRestore()
    const lease = harness.ctx.autonomy.get(harness.agent)!
    const getLease = vi.spyOn(harness.ctx.autonomy, 'get').mockReturnValueOnce({
      ...lease, phase: 'paused', activation: 'armed',
    })
    await expect(harness.ctx.autopilotTeam.interrupt(harness.agent, 'build', 'invalid run phase'))
      .rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_INVALID' })
    getLease.mockRestore()
    const stranger = createTestAgent('stranger')
    await expect(harness.ctx.autopilotTeam.report(stranger, {
      status: 'failed', summary: 'x', evidence: [],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_MISSING' })
    const child = createChild(harness.agent, 'team-child')
    await expect(harness.ctx.autopilotTeam.report(child, {
      status: 'failed', summary: 'x', evidence: [],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_CONFLICT' })
    const liveChild = registerChild(harness.ctx, harness.agent)
    for (const report of [
      { status: 'completed' as const, summary: 'done', evidence: [] },
      { status: 'invalid' as 'completed', summary: 'done', evidence: completedEvidence },
      { status: 'failed' as const, summary: ' ', evidence: [] },
      { status: 'failed' as const, summary: 'done', evidence: Array.from({ length: 129 }, () => completedEvidence[0]!) },
      { status: 'failed' as const, summary: 'done', evidence: [{ ...completedEvidence[0]!, ref: ' ' }] },
      { status: 'failed' as const, summary: 'done', evidence: [{ ...completedEvidence[0]!, summary: ' ' }] },
    ]) {
      await expect(harness.ctx.autopilotTeam.report(
        liveChild, report, new AbortController().signal,
      )).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_INVALID' })
    }
    await harness.ctx.autonomy.pause(harness.agent)
    await expect(harness.ctx.autopilotTeam.followup(harness.agent, {
      taskId: 'build', message: 'paused', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_TEAM_INVALID' })
    expect(harness.ctx.autopilotTeam.list(createTestAgent('no-run'))).toEqual([])
    await harness.ctx.fiber.dispose()
  })

  it('validates deployment configuration and initialization', async () => {
    expect(DEFAULT_TEAM_TOOL_ALLOWLIST).not.toContain('autopilot_team_start')
    expect(() => new ContinuableTeamService(new Context(), { provider: ' ' })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { agentProvider: ' ' })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { agentModel: ' ' })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { persona: ' ' })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { toolAllowlist: ['same', 'same'] })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { toolAllowlist: [' '] })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { reportDelivery: 'later' as 'quiet' })).toThrow(TypeError)
    expect(() => new ContinuableTeamService(new Context(), { agentProvider: 'provider-only' })).not.toThrow()
    expect(() => new ContinuableTeamService(new Context(), { agentModel: 'model-only' })).not.toThrow()
    const ctx = new Context()
    const service = new ContinuableTeamService(ctx)
    expect(() => service.orphans(createTestAgent())).toThrow(/not initialized/u)
    await ctx.fiber.dispose()
  })

  it('fails closed when the claimed start intent cannot be persisted', async () => {
    const harness = await setup()
    const store = storeOf(harness.ctx.autopilotTeam)
    let missingLease: ReturnType<typeof vi.spyOn> | undefined
    vi.spyOn(store, 'append').mockImplementationOnce(async () => {
      missingLease = vi.spyOn(harness.ctx.autonomy, 'get').mockReturnValue(undefined)
      throw new Error('intent disk failure')
    })
    await expect(harness.ctx.autopilotTeam.start(harness.agent, {
      taskId: 'build', role: 'worker', prompt: 'work',
      signal: new AbortController().signal, startContinuable: managedStart(),
    })).rejects.toThrow('intent disk failure')
    missingLease?.mockRestore()
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ phase: 'needs-attention' })
    await harness.ctx.fiber.dispose()
  })

  it('cold-reconciles a deduplicated active root whose run predates service load', async () => {
    const harness = await createServiceHarness({
      autonomy: { maxSubagents: 16, maxConcurrentSubagents: 4 },
    })
    await harness.ctx.plugin(SystemPrompt)
    await harness.ctx.plugin(ToolRuntime)
    await harness.ctx.plugin(SubagentRuntime)
    let release: (() => void) | undefined
    const descendants = vi.spyOn(harness.ctx.subagents, 'listDescendants').mockImplementationOnce(() =>
      new Promise(resolve => {
        release = () => resolve([])
      }))
    const goal = harness.ctx.goals.create(harness.agent, { objective: 'active before team service' })
    await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
    await prepareTestPlan(harness.ctx, harness.agent, ['team tasks settle'], [task('build')])
    await harness.ctx.autonomy.updateTask(harness.agent, 'build', 'start')
    await harness.ctx.autonomy.updateTask(harness.agent, 'build', 'complete', { evidence: completedEvidence })
    await harness.ctx.autonomy.beginVerification(harness.agent, {
      summary: 'candidate ready before team service',
      evidence: ['focused tests'],
    })
    const noRun = createTestAgent('cold-root-without-run')
    harness.ctx.effect(() => harness.ctx.sessions.enter(noRun.session), 'dsh-autopilot.teamColdNoRunSession')
    harness.ctx.agents.register(noRun)

    const teamFiber = await harness.ctx.plugin(ContinuableTeamService)
    await vi.waitFor(() => expect(release).toBeDefined())
    harness.ctx.emit('agent/created', { agent: harness.agent })
    release?.()
    await harness.ctx.autopilotTeam.whenObserversIdle()

    expect(descendants).toHaveBeenCalledOnce()
    expect(descendants).toHaveBeenCalledWith(harness.agent.id, expect.any(AbortSignal))
    await teamFiber.dispose()
    await harness.ctx.fiber.dispose()
  })

  it('drains and reports a failing cold reconciliation during service disposal', async () => {
    const harness = await createServiceHarness({
      autonomy: { maxSubagents: 16, maxConcurrentSubagents: 4 },
    })
    await harness.ctx.plugin(SystemPrompt)
    await harness.ctx.plugin(ToolRuntime)
    await harness.ctx.plugin(SubagentRuntime)
    let rejectAudit: ((error: Error) => void) | undefined
    vi.spyOn(harness.ctx.subagents, 'listDescendants').mockImplementationOnce(() =>
      new Promise((_resolve, reject) => {
        rejectAudit = reject
      }))
    const goal = harness.ctx.goals.create(harness.agent, { objective: 'dispose during cold audit' })
    await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
    await prepareTestPlan(harness.ctx, harness.agent, ['team tasks settle'], [task('build')])
    const logged = vi.spyOn(harness.ctx.logger, 'error')

    const teamFiber = await harness.ctx.plugin(ContinuableTeamService)
    const service = harness.ctx.autopilotTeam
    const close = vi.spyOn(storeOf(service), 'close')
    await vi.waitFor(() => expect(rejectAudit).toBeDefined())
    const disposing = teamFiber.dispose()
    expect(close).not.toHaveBeenCalled()
    rejectAudit?.(new Error('cold descendant audit failed'))
    await disposing

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('cold descendant audit failed'))
    expect(close).toHaveBeenCalledOnce()
    await service.whenObserversIdle()
    await harness.ctx.fiber.dispose()
  })

  it('skips queued roots that stop being live or active before observation', async () => {
    const harness = await setup()
    const disposed = await registerRunningRoot(harness.ctx, 'queued-disposed-root')
    const paused = await registerRunningRoot(harness.ctx, 'queued-paused-root')
    let release: (() => void) | undefined
    harness.descendants.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve([])
    }))

    harness.ctx.emit('agent/created', { agent: harness.agent })
    await vi.waitFor(() => expect(release).toBeDefined())
    harness.ctx.emit('agent/created', { agent: disposed.agent })
    harness.ctx.emit('agent/created', { agent: paused.agent })
    disposed.dispose()
    await harness.ctx.autonomy.pause(paused.agent, 'paused before queued reconciliation')
    release?.()
    await harness.ctx.autopilotTeam.whenObserversIdle()

    expect(harness.descendants).toHaveBeenCalledOnce()
    expect(harness.descendants).toHaveBeenCalledWith(harness.agent.id, expect.any(AbortSignal))
    await harness.ctx.fiber.dispose()
  })

  it('stops reconciliation before attributing or escalating a superseded run', async () => {
    const orphan = await setup()
    orphan.descendants.mockResolvedValue([{
      kind: 'child', id: SessionId('generation-race-child'), activity: 'inactive', hasChildren: false,
      mode: 'continuable', label: 'foreign', parentId: orphan.agent.id, depth: 1,
    }])
    const lease = orphan.ctx.autonomy.get(orphan.agent)!
    const replacement = { ...lease, id: `${lease.id}-replacement`, generation: lease.generation + 1 }
    const recordOrphan = storeOf(orphan.ctx.autopilotTeam).recordOrphan.bind(storeOf(orphan.ctx.autopilotTeam))
    let getReplacement: ReturnType<typeof vi.spyOn> | undefined
    vi.spyOn(storeOf(orphan.ctx.autopilotTeam), 'recordOrphan').mockImplementationOnce(async record => {
      const persisted = await recordOrphan(record)
      getReplacement = vi.spyOn(orphan.ctx.autonomy, 'get').mockReturnValue(replacement)
      return persisted
    })
    await expect(orphan.ctx.autopilotTeam.reconcile(orphan.agent, new AbortController().signal))
      .resolves.toMatchObject({ issues: [expect.stringContaining('run changed')] })
    expect(orphan.interrupt).not.toHaveBeenCalledWith(
      SessionId('generation-race-child'),
      expect.anything(),
    )
    getReplacement?.mockRestore()
    await orphan.ctx.fiber.dispose()

    for (const replacementRead of [4, 5]) {
      const attention = await setup()
      await prepareOnly(attention)
      const current = attention.ctx.autonomy.get(attention.agent)!
      const actualGet = attention.ctx.autonomy.get.bind(attention.ctx.autonomy)
      let reads = 0
      const get = vi.spyOn(attention.ctx.autonomy, 'get').mockImplementation((agent) => {
        const view = actualGet(agent)
        if (agent !== attention.agent || view === undefined) return view
        reads += 1
        return reads === replacementRead
          ? { ...view, id: `${view.id}-replacement`, generation: view.generation + 1 }
          : view
      })
      await expect(attention.ctx.autopilotTeam.reconcile(attention.agent, new AbortController().signal))
        .resolves.toMatchObject({ issues: [expect.stringContaining('run changed')] })
      expect(attention.ctx.autonomy.get(attention.agent)?.id).toBe(current.id)
      get.mockRestore()
      await attention.ctx.fiber.dispose()
    }
  })

  it('coalesces concurrent reconciliation and background creation audits', async () => {
    const harness = await setup()
    let release: (() => void) | undefined
    harness.descendants.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve([])
    }))
    const first = harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal)
    const second = harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal)
    expect(second).toBe(first)
    release?.()
    await first
    harness.ctx.emit('agent/created', { agent: harness.agent })
    await harness.ctx.autopilotTeam.whenObserversIdle()
    expect(harness.descendants).toHaveBeenCalledTimes(2)

    const lease = harness.ctx.autonomy.get(harness.agent)!
    const get = vi.spyOn(harness.ctx.autonomy, 'get').mockReturnValue({
      ...lease, phase: 'verifying', activation: 'armed',
    })
    harness.ctx.emit('agent/created', { agent: harness.agent })
    await harness.ctx.autopilotTeam.whenObserversIdle()
    get.mockRestore()

    const logged = vi.spyOn(harness.ctx.logger, 'error')
    harness.descendants.mockRejectedValueOnce(new Error('background audit failed'))
    harness.ctx.emit('agent/created', { agent: harness.agent })
    await harness.ctx.autopilotTeam.whenObserversIdle()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('background audit failed'))

    let releaseStale: (() => void) | undefined
    harness.descendants.mockImplementationOnce(() => new Promise(resolve => {
      releaseStale = () => resolve([])
    }))
    const stale = harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal)
    await vi.waitFor(() => expect(releaseStale).toBeDefined())
    const currentLease = harness.ctx.autonomy.get(harness.agent)!
    const getReplacement = vi.spyOn(harness.ctx.autonomy, 'get').mockReturnValue({
      ...currentLease,
      id: `${currentLease.id}-replacement`,
      generation: currentLease.generation + 1,
    })
    const replacement = harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal)
    expect(replacement).not.toBe(stale)
    await expect(replacement).resolves.toMatchObject({ issues: [] })
    releaseStale?.()
    await expect(stale).resolves.toMatchObject({
      issues: [expect.stringContaining('run changed')],
    })
    getReplacement.mockRestore()

    const exactLease = harness.ctx.autonomy.get(harness.agent)!
    const getStaleBeforeAudit = vi.spyOn(harness.ctx.autonomy, 'get')
      .mockReturnValueOnce(exactLease)
      .mockReturnValueOnce({
        ...exactLease,
        id: `${exactLease.id}-superseded`,
        generation: exactLease.generation + 1,
      })
    await expect(harness.ctx.autopilotTeam.reconcile(harness.agent, new AbortController().signal))
      .resolves.toMatchObject({ inspected: 0, issues: [expect.stringContaining('run changed')] })
    getStaleBeforeAudit.mockRestore()
    await harness.ctx.fiber.dispose()
  })
})
