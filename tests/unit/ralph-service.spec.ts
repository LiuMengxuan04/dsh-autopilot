import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedSubagentStart } from '../../src/managed-subagents.ts'
import RalphService, {
  RalphError,
  resolveRalphLimits,
} from '../../src/ralph-service.ts'
import type { RalphServiceConfig } from '../../src/ralph-service.ts'
import { RALPH_STATE_VERSION } from '../../src/ralph-state.ts'
import type { RalphOperation, RalphSnapshot } from '../../src/ralph-state.ts'
import { DurableRalphStore } from '../../src/ralph-store.ts'
import { createServiceHarness, prepareTestPlan } from '../helpers.ts'

function task(id: string, dependencies: readonly string[] = []) {
  return {
    id,
    title: `Task ${id}`,
    description: `Complete ${id}`,
    acceptanceCriteria: [`${id} has evidence`],
    dependencies,
  }
}

function result(
  status: 'continue' | 'completed' | 'blocked' | 'failed',
  summary = `${status} summary`,
  handoff = status === 'continue' ? 'continue from the failing test' : '',
  evidence: unknown[] = status === 'completed'
    ? [{ kind: 'test', ref: 'pnpm test', summary: 'tests passed' }]
    : [],
): SubagentResult {
  return {
    output: [],
    stopReason: 'completed',
    structured: { status, summary, handoff, evidence },
  }
}

function rawResult(structured: unknown): SubagentResult {
  return { output: [], stopReason: 'completed', structured }
}

function child(
  id: string,
  outcome: SubagentResult | Promise<SubagentResult>,
  dispose: () => Promise<void> = async () => {},
): SubagentRun {
  return { id: SessionId(id), localAgent: undefined, result: Promise.resolve(outcome), dispose }
}

function scripted(outcomes: Array<SubagentRun | Error>): {
  readonly start: ManagedSubagentStart
  readonly calls: Array<{ provider: string; request: SubagentStartRequest }>
} {
  const calls: Array<{ provider: string; request: SubagentStartRequest }> = []
  const start: ManagedSubagentStart = async (provider, request) => {
    calls.push({ provider, request })
    const outcome = outcomes.shift()
    if (outcome === undefined) throw new Error('no scripted child')
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return { start, calls }
}

interface RalphServiceProbe {
  store: DurableRalphStore | undefined
  active: Map<string, unknown>
  append(
    current: RalphSnapshot,
    operation: RalphOperation,
    changes: Partial<RalphSnapshot>,
  ): Promise<RalphSnapshot>
  assertPolicy(snapshot: RalphSnapshot): void
  resolveRequestedRounds(value: number | undefined, ceiling: number): number
  interrupt(snapshot: RalphSnapshot, reason: string): Promise<RalphSnapshot>
  markAttention(snapshot: RalphSnapshot, changes: Partial<RalphSnapshot>): Promise<RalphSnapshot>
  settleResult(
    parent: Agent,
    snapshot: RalphSnapshot,
    result: { status: 'failed'; summary: string; evidence: [] },
  ): Promise<RalphSnapshot>
  roundPrompt(parent: Agent, snapshot: RalphSnapshot, round: number): unknown
  workerToolFilter(): { readonly allow: readonly string[] }
  abortReason(signal: AbortSignal): string
  interruptForLifecycle(parent: Agent, runId: string, generation: number, reason: string): Promise<void>
  exclusive(
    identity: Pick<RalphSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId'>,
    parent: Agent,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<RalphSnapshot>,
  ): Promise<RalphSnapshot>
}

function probe(service: RalphService): RalphServiceProbe {
  return service as unknown as RalphServiceProbe
}

async function resumeAttention(ctx: Context, agent: Agent): Promise<void> {
  const goal = ctx.goals.get(agent)
  if (goal === undefined) throw new Error('fixture Goal is missing')
  await ctx.autonomy.resume(agent, goal.id)
  const current = ctx.goals.get(agent)
  if (current === undefined) throw new Error('fixture Goal disappeared')
  ctx.goals.resume(agent, { id: current.id, revision: current.revision })
}

async function harness(options: {
  readonly autonomy?: { readonly maxSubagents?: number }
  readonly ralph?: RalphServiceConfig
  readonly taskIds?: readonly string[]
} = {}) {
  const base = await createServiceHarness({
    autonomy: {
      maxSubagents: options.autonomy?.maxSubagents ?? 8,
      maxConcurrentSubagents: 1,
    },
  })
  await base.ctx.plugin(SystemPrompt)
  await base.ctx.plugin(ToolRuntime)
  const ralphFiber = await base.ctx.plugin(RalphService, options.ralph ?? { defaultMaxRounds: 4, maxRounds: 8 })
  const goal = base.ctx.goals.create(base.agent, { objective: 'exercise Ralph leaf loops' })
  await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
  await prepareTestPlan(
    base.ctx,
    base.agent,
    ['all leaves complete'],
    (options.taskIds ?? ['leaf']).map(id => task(id)),
  )
  return { ...base, ralphFiber, goal }
}

describe('Ralph fresh-agent service', () => {
  it('uses a fresh managed child per round, charges the run budget, and completes only the leaf', async () => {
    const { ctx, agent, goal } = await harness()
    const workers = scripted([
      child('fresh-1', result('continue', 'first pass', 'fix the remaining assertion', [
        { kind: 'note', ref: 'round-1', summary: 'isolated the failure' },
      ])),
      child('fresh-2', result('completed', 'leaf is done')),
    ])
    const snapshot = await ctx.autopilotRalph.start(agent, {
      taskId: 'leaf',
      instruction: 'implement and test the leaf',
      maxRounds: 3,
      startSubagent: workers.start,
      signal: new AbortController().signal,
    })

    expect(snapshot).toMatchObject({ phase: 'completed', reservedThroughRound: 2 })
    expect(snapshot.rounds.map(round => [round.status, round.childSessionId])).toEqual([
      ['continue', 'fresh-1'],
      ['completed', 'fresh-2'],
    ])
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 2, phase: 'running' })
    expect(ctx.autonomy.get(agent)?.plan?.tasks[0]).toMatchObject({ status: 'completed' })
    expect(ctx.autonomy.get(agent)?.plan?.tasks[0]?.evidence).toHaveLength(2)
    expect(ctx.goals.get(agent)).toMatchObject({ id: goal.id, phase: 'active' })
    expect(workers.calls).toHaveLength(2)
    expect(workers.calls[0]?.provider).toBe('spawn')
    expect(workers.calls[0]?.request).toMatchObject({ maxDepth: 1, label: expect.stringContaining(':leaf:1') })
    expect(workers.calls[1]?.request.prompt[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('fix the remaining assertion'),
    })
    expect(ctx.autopilotRalph.status(agent, 'leaf')).toEqual(snapshot)
    expect(ctx.autopilotRalph.list(agent)).toEqual([snapshot])
    await ctx.fiber.dispose()
  })

  it('settles provider infrastructure failure and semantic blocking without retrying', async () => {
    const infrastructure = await harness()
    const failed = await infrastructure.ctx.autopilotRalph.start(infrastructure.agent, {
      taskId: 'leaf', instruction: 'try once', startSubagent: scripted([new Error('provider offline')]).start,
      signal: new AbortController().signal,
    })
    expect(failed).toMatchObject({ phase: 'failed', reason: expect.stringContaining('provider offline') })
    expect(infrastructure.ctx.autonomy.get(infrastructure.agent)?.plan?.tasks[0]?.status).toBe('failed')
    await infrastructure.ctx.fiber.dispose()

    const semantic = await harness()
    const blockedWorkers = scripted([child('blocked-child', result('blocked', 'needs product owner'))])
    const blocked = await semantic.ctx.autopilotRalph.start(semantic.agent, {
      taskId: 'leaf', instruction: 'respect ambiguity', startSubagent: blockedWorkers.start,
      signal: new AbortController().signal,
    })
    expect(blocked).toMatchObject({ phase: 'blocked', reason: 'needs product owner' })
    expect(blockedWorkers.calls).toHaveLength(1)
    expect(semantic.ctx.autonomy.get(semantic.agent)?.plan?.tasks[0]?.status).toBe('blocked')
    await semantic.ctx.fiber.dispose()
  })

  it('blocks on run-wide subagent exhaustion and on the per-loop round ceiling', async () => {
    const budget = await harness({ autonomy: { maxSubagents: 1 } })
    const exhausted = await budget.ctx.autopilotRalph.start(budget.agent, {
      taskId: 'leaf', instruction: 'needs another pass',
      startSubagent: scripted([child('only-child', result('continue'))]).start,
      signal: new AbortController().signal,
    })
    expect(exhausted).toMatchObject({
      phase: 'blocked', reason: expect.stringContaining('subagent budget exhausted'),
    })
    expect(budget.ctx.autonomy.get(budget.agent)?.subagentsStarted).toBe(1)
    await budget.ctx.fiber.dispose()

    const rounds = await harness({ ralph: { defaultMaxRounds: 1, maxRounds: 2 } })
    const roundLimited = await rounds.ctx.autopilotRalph.start(rounds.agent, {
      taskId: 'leaf', instruction: 'bounded attempt', maxRounds: 1,
      startSubagent: scripted([child('round-child', result('continue'))]).start,
      signal: new AbortController().signal,
    })
    expect(roundLimited).toMatchObject({ phase: 'blocked', reason: 'Ralph round ceiling 1 is exhausted' })
    await rounds.ctx.fiber.dispose()
  })

  it('persists pause interruption and resumes durable handoff with a new fresh child', async () => {
    const { ctx, agent, goal } = await harness()
    const pending = Promise.withResolvers<SubagentResult>()
    const disposeSecond = vi.fn(async () => {})
    const firstWorkers = scripted([
      child('before-pause', result('continue', 'checkpoint', 'resume from durable checkpoint')),
      child('interrupted-child', pending.promise, disposeSecond),
    ])
    const running = ctx.autopilotRalph.start(agent, {
      taskId: 'leaf', instruction: 'survive a pause', startSubagent: firstWorkers.start,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(firstWorkers.calls).toHaveLength(2) })
    await ctx.autonomy.pause(agent, 'human pause')
    const interrupted = await running
    expect(interrupted).toMatchObject({ phase: 'interrupted', handoff: 'resume from durable checkpoint' })
    expect(interrupted.rounds.map(round => round.status)).toEqual(['continue', 'interrupted'])
    expect(disposeSecond).toHaveBeenCalledOnce()
    expect(ctx.autonomy.get(agent)?.plan?.tasks[0]?.status).toBe('pending')

    await ctx.autonomy.resume(agent, goal.id)
    const afterResume = scripted([child('after-resume', result('completed', 'resumed leaf done'))])
    const completed = await ctx.autopilotRalph.resume(agent, {
      taskId: 'leaf', maxRounds: 3, startSubagent: afterResume.start,
      signal: new AbortController().signal,
    })
    expect(completed.rounds.map(round => round.childSessionId)).toEqual([
      'before-pause', 'interrupted-child', 'after-resume',
    ])
    expect(afterResume.calls[0]?.request.prompt[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('resume from durable checkpoint'),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 3 })
    await ctx.fiber.dispose()
  })

  it('cancels an in-flight child and terminally fails only the attributed task', async () => {
    const { ctx, agent } = await harness()
    const pending = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(async () => {})
    const workers = scripted([child('cancel-child', pending.promise, dispose)])
    const running = ctx.autopilotRalph.start(agent, {
      taskId: 'leaf', instruction: 'cancel safely', startSubagent: workers.start,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(workers.calls).toHaveLength(1) })
    const cancelled = await ctx.autopilotRalph.cancel(agent, 'leaf', 'human cancelled leaf')
    expect(await running).toMatchObject({ phase: 'interrupted' })
    expect(cancelled).toMatchObject({ phase: 'cancelled', reason: 'human cancelled leaf' })
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.autonomy.get(agent)?.plan?.tasks[0]?.status).toBe('failed')
    expect(await ctx.autopilotRalph.cancel(agent, 'leaf', 'again')).toEqual(cancelled)
    await ctx.fiber.dispose()

    const failedSettlement = await harness()
    const pendingSettlement = Promise.withResolvers<SubagentResult>()
    const settlementWorkers = scripted([child('cancel-attention-child', pendingSettlement.promise)])
    const settlementRunning = failedSettlement.ctx.autopilotRalph.start(failedSettlement.agent, {
      taskId: 'leaf', instruction: 'cancel with store failure', startSubagent: settlementWorkers.start,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(settlementWorkers.calls).toHaveLength(1) })
    vi.spyOn(failedSettlement.ctx.autonomy, 'updateTask').mockRejectedValueOnce(new Error('task write failed'))
    expect(await failedSettlement.ctx.autopilotRalph.cancel(
      failedSettlement.agent, 'leaf', 'cancel despite failure',
    )).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('task write failed') })
    await settlementRunning
    await failedSettlement.ctx.fiber.dispose()
  })

  it('fails closed on provider result, cleanup, settlement, and uncertain reservation failures', async () => {
    const resultFailure = await harness({ taskIds: ['reject', 'cleanup', 'settle', 'reserve'] })
    const rejectedResult = Promise.withResolvers<SubagentResult>()
    void rejectedResult.promise.catch(() => undefined)
    const rejectedWorkers = scripted([child('reject-child', rejectedResult.promise)])
    const rejecting = resultFailure.ctx.autopilotRalph.start(resultFailure.agent, {
      taskId: 'reject', instruction: 'handle rejection',
      startSubagent: rejectedWorkers.start,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(rejectedWorkers.calls).toHaveLength(1) })
    rejectedResult.reject(new Error('stream failed'))
    const rejected = await rejecting
    expect(rejected).toMatchObject({ phase: 'failed', reason: expect.stringContaining('stream failed') })

    const cleanup = await resultFailure.ctx.autopilotRalph.start(resultFailure.agent, {
      taskId: 'cleanup', instruction: 'handle cleanup',
      startSubagent: scripted([child('cleanup-child', result('completed'), async () => {
        throw new Error('dispose failed')
      })]).start,
      signal: new AbortController().signal,
    })
    expect(cleanup).toMatchObject({ phase: 'failed', reason: expect.stringContaining('cleanup failed') })

    const update = vi.spyOn(resultFailure.ctx.autonomy, 'updateTask')
    update.mockRejectedValueOnce(new Error('task store unavailable'))
    const attention = await resultFailure.ctx.autopilotRalph.start(resultFailure.agent, {
      taskId: 'settle', instruction: 'settle carefully',
      startSubagent: scripted([child('settle-child', result('completed'))]).start,
      signal: new AbortController().signal,
    })
    expect(attention).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('incomplete') })
    expect(resultFailure.ctx.autonomy.get(resultFailure.agent)).toMatchObject({
      phase: 'needs-attention', activation: 'disarmed',
    })
    update.mockRestore()
    await resumeAttention(resultFailure.ctx, resultFailure.agent)

    const record = vi.spyOn(resultFailure.ctx.autonomy, 'recordSubagentStarts')
      .mockRejectedValueOnce(new Error('uncertain durable write'))
    const uncertain = await resultFailure.ctx.autopilotRalph.start(resultFailure.agent, {
      taskId: 'reserve', instruction: 'continue then fail closed',
      startSubagent: scripted([child('reserve-child', result('continue'))]).start,
      signal: new AbortController().signal,
    })
    expect(uncertain).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('uncertain') })
    expect(resultFailure.ctx.autonomy.get(resultFailure.agent)).toMatchObject({ phase: 'needs-attention' })
    record.mockRestore()
    await resultFailure.ctx.fiber.dispose()
  })

  it('surfaces Ralph and parent attention persistence failures independently and together', async () => {
    const appendOnly = await harness()
    const appendOnlySignal = new AbortController()
    appendOnlySignal.abort('prepare an interrupted row')
    const interrupted = await appendOnly.ctx.autopilotRalph.start(appendOnly.agent, {
      taskId: 'leaf', instruction: 'exercise attention persistence', startSubagent: scripted([]).start,
      signal: appendOnlySignal.signal,
    })
    const appendOnlyProbe = probe(appendOnly.ctx.autopilotRalph)
    await expect(appendOnlyProbe.markAttention(interrupted, {})).rejects.toThrow(/requires a reason/u)
    const appendFailure = new Error('Ralph attention ledger unavailable')
    vi.spyOn(appendOnlyProbe, 'append').mockRejectedValueOnce(appendFailure)
    await expect(appendOnlyProbe.markAttention({
      ...interrupted,
      parentSessionId: 'detached-parent',
      runId: 'detached-run',
    }, { reason: 'detached persistence failure' })).rejects.toBe(appendFailure)
    await appendOnly.ctx.fiber.dispose()

    const parentOnly = await harness()
    const parentOnlySignal = new AbortController()
    parentOnlySignal.abort('prepare another interrupted row')
    const parentOnlyRow = await parentOnly.ctx.autopilotRalph.start(parentOnly.agent, {
      taskId: 'leaf', instruction: 'exercise parent attention persistence', startSubagent: scripted([]).start,
      signal: parentOnlySignal.signal,
    })
    const parentFailure = new Error('parent attention ledger unavailable')
    vi.spyOn(parentOnly.ctx.autonomy, 'markNeedsAttention').mockRejectedValueOnce(parentFailure)
    await expect(probe(parentOnly.ctx.autopilotRalph).markAttention(
      parentOnlyRow,
      { reason: 'parent persistence failure' },
    )).rejects.toBe(parentFailure)
    expect(parentOnly.ctx.autopilotRalph.status(parentOnly.agent, 'leaf')?.phase).toBe('needs-attention')
    await parentOnly.ctx.fiber.dispose()

    const both = await harness()
    const bothSignal = new AbortController()
    bothSignal.abort('prepare a third interrupted row')
    const bothRow = await both.ctx.autopilotRalph.start(both.agent, {
      taskId: 'leaf', instruction: 'exercise aggregate attention failure', startSubagent: scripted([]).start,
      signal: bothSignal.signal,
    })
    const bothProbe = probe(both.ctx.autopilotRalph)
    vi.spyOn(bothProbe, 'append').mockRejectedValueOnce(new Error('Ralph ledger failed'))
    vi.spyOn(both.ctx.autonomy, 'markNeedsAttention').mockRejectedValueOnce(new Error('parent ledger failed'))
    await expect(bothProbe.markAttention(bothRow, { reason: 'both writes failed' }))
      .rejects.toBeInstanceOf(AggregateError)
    await both.ctx.fiber.dispose()
  })

  it('requires exact armed run/task/provenance and validates non-expanding deployment policy', async () => {
    expect(() => resolveRalphLimits({ defaultMaxRounds: 3, maxRounds: 2 })).toThrow(RalphError)
    for (const config of [
      { maxRounds: 0 },
      { maxInstructionChars: 0 },
      { maxHandoffChars: 0 },
      { maxSummaryChars: 0 },
      { maxEvidenceItems: 0 },
      { subagentProvider: '' },
      { provider: '' },
      { model: '' },
      { persona: '' },
      { toolAllowlist: ['bash', 'bash'] },
    ] satisfies RalphServiceConfig[]) expect(() => resolveRalphLimits(config)).toThrow(RalphError)
    const limits = resolveRalphLimits({ provider: 'deepseek', model: 'fixed', toolAllowlist: ['bash'] })
    expect(limits).toMatchObject({ provider: 'deepseek', model: 'fixed', toolAllowlist: ['bash'] })

    const { ctx, agent } = await harness({ taskIds: ['ready', 'dependent'] })
    expect(() => ctx.autopilotRalph.start(agent, {
      taskId: 'missing', instruction: 'no', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/dependency-ready/)
    expect(() => ctx.autopilotRalph.start(agent, {
      taskId: 'ready', instruction: 'x', startSubagent: undefined as never,
      signal: new AbortController().signal,
    })).toThrow(/Host-owned/)
    await ctx.autonomy.pause(agent)
    expect(() => ctx.autopilotRalph.start(agent, {
      taskId: 'ready', instruction: 'x', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/exact active armed Goal/)
    expect(ctx.autopilotRalph.status({} as Agent, 'ready')).toBeUndefined()
    expect(ctx.autopilotRalph.list({} as Agent)).toEqual([])
    await expect(ctx.autopilotRalph.cancel({} as Agent, 'ready', 'x')).rejects.toMatchObject({
      code: 'AUTOPILOT_RALPH_RUN_MISMATCH',
    })
    await ctx.fiber.dispose()

    const drifted = await harness()
    const driftedGoal = drifted.ctx.goals.get(drifted.agent)
    if (driftedGoal === undefined) throw new Error('fixture Goal is missing')
    drifted.ctx.goals.disarm(drifted.agent)
    const workers = scripted([child('must-not-start', result('completed'))])
    expect(() => drifted.ctx.autopilotRalph.start(drifted.agent, {
      taskId: 'leaf', instruction: 'must remain inert', startSubagent: workers.start,
      signal: new AbortController().signal,
    })).toThrow(/exact active armed Goal/)
    expect(workers.calls).toHaveLength(0)
    expect(drifted.ctx.autonomy.get(drifted.agent)?.subagentsStarted).toBe(0)
    expect(drifted.ctx.autopilotRalph.list(drifted.agent)).toEqual([])
    await drifted.ctx.fiber.dispose()

    const bareContext = new Context()
    Object.defineProperty(bareContext, 'autonomy', {
      configurable: true,
      value: { get: () => ({ id: 'run', generation: 1 }) },
    })
    const bare = new RalphService(bareContext)
    expect(() => bare.status({} as Agent, 'x')).toThrow(/store is not initialized/)
  })

  it('recovers safe between-round rows as interrupted and uncertain crash rows as attention', async () => {
    const base = await createServiceHarness()
    const goal = base.ctx.goals.create(base.agent, { objective: 'recover Ralph' })
    const lease = await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
    await prepareTestPlan(base.ctx, base.agent, ['recover'], [task('safe'), task('uncertain')])
    const limits = resolveRalphLimits({ defaultMaxRounds: 2, maxRounds: 4 })
    const store = await DurableRalphStore.open(base.ctx)
    const prepared = (taskId: string): RalphSnapshot => ({
      version: RALPH_STATE_VERSION,
      parentSessionId: String(base.agent.id),
      runId: lease.id,
      generation: lease.generation,
      goalId: String(lease.goalId),
      taskId,
      revision: 1,
      phase: 'claiming',
      instruction: 'recover',
      policySha256: limits.policySha256,
      maxRounds: 2,
      maxHandoffChars: limits.maxHandoffChars,
      maxSummaryChars: limits.maxSummaryChars,
      maxEvidenceItems: limits.maxEvidenceItems,
      reservedThroughRound: 0,
      rounds: [],
      createdAt: 1,
      updatedAt: 1,
    })
    const safe = prepared('safe')
    await store.append('prepare', safe)
    await store.append('claim', {
      ...safe, revision: 2, updatedAt: 2, phase: 'ready', claimedRunRevision: lease.revision, reservedThroughRound: 1,
    })
    await store.append('prepare', prepared('uncertain'))
    await store.append('prepare', {
      ...prepared('detached'),
      parentSessionId: 'detached-parent',
      runId: 'detached-run',
      goalId: 'detached-goal',
    })
    await store.close()

    await base.ctx.plugin(SystemPrompt)
    await base.ctx.plugin(ToolRuntime)
    await base.ctx.plugin(RalphService, { defaultMaxRounds: 2, maxRounds: 4 })
    expect(base.ctx.autopilotRalph.status(base.agent, 'safe')?.phase).toBe('interrupted')
    expect(base.ctx.autopilotRalph.status(base.agent, 'uncertain')).toMatchObject({
      phase: 'needs-attention', reason: expect.stringContaining('uncertain'),
    })
    expect(base.ctx.autonomy.get(base.agent)?.phase).toBe('needs-attention')
    await base.ctx.fiber.dispose()
  })

  it('persists HMR disposal as interruption and resumes with a fresh child after reinstall', async () => {
    const { ctx, agent, ralphFiber } = await harness()
    const pending = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(async () => {})
    const beforeReload = scripted([child('hmr-old-child', pending.promise, dispose)])
    const running = ctx.autopilotRalph.start(agent, {
      taskId: 'leaf', instruction: 'survive plugin reload', startSubagent: beforeReload.start,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(beforeReload.calls).toHaveLength(1) })
    await ralphFiber.dispose()
    expect(await running).toMatchObject({ phase: 'interrupted' })
    expect(dispose).toHaveBeenCalledOnce()

    await ctx.plugin(RalphService, { defaultMaxRounds: 4, maxRounds: 8 })
    const afterReload = scripted([child('hmr-new-child', result('completed'))])
    const completed = await ctx.autopilotRalph.resume(agent, {
      taskId: 'leaf', startSubagent: afterReload.start, signal: new AbortController().signal,
    })
    expect(completed.rounds.map(round => round.childSessionId)).toEqual(['hmr-old-child', 'hmr-new-child'])
    expect(completed.phase).toBe('completed')
    await ctx.fiber.dispose()
  })

  it('bounds and rejects every malformed structured-result field without another round', async () => {
    const invalidValues: readonly unknown[] = [
      null,
      { status: 'unknown', summary: 'x', handoff: '', evidence: [] },
      { status: 'failed', summary: 1, handoff: '', evidence: [] },
      { status: 'failed', summary: '', handoff: '', evidence: [] },
      { status: 'failed', summary: 'x'.repeat(101), handoff: '', evidence: [] },
      { status: 'failed', summary: 'x', handoff: 1, evidence: [] },
      { status: 'failed', summary: 'x', handoff: 'x'.repeat(101), evidence: [] },
      { status: 'failed', summary: 'x', handoff: '', evidence: {} },
      { status: 'failed', summary: 'x', handoff: '', evidence: [null] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'bad', ref: 'x', summary: 'x' }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'note', ref: 1, summary: 'x' }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'note', ref: '', summary: 'x' }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'note', ref: 'x'.repeat(4097), summary: 'x' }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'note', ref: 'x', summary: 1 }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'note', ref: 'x', summary: '' }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [{ kind: 'note', ref: 'x', summary: 'x'.repeat(4097) }] },
      { status: 'failed', summary: 'x', handoff: '', evidence: [
        { kind: 'note', ref: '1', summary: '1' },
        { kind: 'note', ref: '2', summary: '2' },
        { kind: 'note', ref: '3', summary: '3' },
      ] },
      { status: 'continue', summary: 'x', handoff: '', evidence: [] },
      { status: 'completed', summary: 'x', handoff: '', evidence: [] },
    ]
    const ids = invalidValues.map((_value, index) => `invalid-${index}`)
    const { ctx, agent } = await harness({
      autonomy: { maxSubagents: 32 },
      ralph: {
        defaultMaxRounds: 2,
        maxRounds: 2,
        maxSummaryChars: 100,
        maxHandoffChars: 100,
        maxEvidenceItems: 2,
      },
      taskIds: ids,
    })
    for (const [index, structured] of invalidValues.entries()) {
      const taskId = ids[index]!
      const settled = await ctx.autopilotRalph.start(agent, {
        taskId,
        instruction: 'validate output',
        startSubagent: scripted([child(`invalid-child-${index}`, rawResult(structured))]).start,
        signal: new AbortController().signal,
      })
      expect(settled).toMatchObject({
        phase: 'failed', reason: expect.stringContaining('invalid structured output'),
      })
    }
    await ctx.fiber.dispose()
  }, 20_000)

  it('handles stop reasons, non-Error throws, initial claim denial, and already-aborted calls', async () => {
    const { ctx, agent } = await harness({ autonomy: { maxSubagents: 8 }, taskIds: [
      'refusal', 'stop-error', 'non-error', 'unrenderable', 'pre-abort', 'claim-budget',
    ] })
    const refusal = await ctx.autopilotRalph.start(agent, {
      taskId: 'refusal', instruction: 'refuse',
      startSubagent: scripted([child('refusal-child', { output: [], stopReason: 'refusal' })]).start,
      signal: new AbortController().signal,
    })
    expect(refusal.phase).toBe('blocked')
    const stopError = await ctx.autopilotRalph.start(agent, {
      taskId: 'stop-error', instruction: 'error',
      startSubagent: scripted([child('error-child', { output: [], stopReason: 'error' })]).start,
      signal: new AbortController().signal,
    })
    expect(stopError.phase).toBe('failed')
    const nonErrorStart: ManagedSubagentStart = async () => { throw 42 }
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'non-error', instruction: 'non error', startSubagent: nonErrorStart,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'failed', reason: expect.stringContaining('42') })
    const thrown = { toString(): string { throw new Error('coercion failed') } }
    const unrenderableStart: ManagedSubagentStart = async () => { throw thrown }
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'unrenderable', instruction: 'unrenderable', startSubagent: unrenderableStart,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'failed', reason: expect.stringContaining('<unrenderable') })

    const aborted = new AbortController()
    aborted.abort()
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'pre-abort', instruction: 'abort early', startSubagent: scripted([]).start,
      signal: aborted.signal,
    })).toMatchObject({ phase: 'interrupted' })

    await ctx.autonomy.recordSubagentStarts(agent, 4)
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'claim-budget', instruction: 'budget denied', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'blocked', reason: expect.stringContaining('budget exhausted') })
    await ctx.fiber.dispose()

    const settlement = await harness({ autonomy: { maxSubagents: 1 } })
    await settlement.ctx.autonomy.recordSubagentStarts(settlement.agent, 1)
    vi.spyOn(settlement.ctx.autonomy, 'updateTask').mockRejectedValueOnce(new Error('cannot persist initial block'))
    expect(await settlement.ctx.autopilotRalph.start(settlement.agent, {
      taskId: 'leaf', instruction: 'initial budget settlement', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('cannot persist initial block') })
    await settlement.ctx.fiber.dispose()
  })

  it('rejects duplicate/missing transitions and exercises fail-closed defensive seams', async () => {
    const { ctx, agent } = await harness({ autonomy: { maxSubagents: 16 }, taskIds: [
      'done', 'generic-claim', 'early', 'cas',
    ] })
    const done = await ctx.autopilotRalph.start(agent, {
      taskId: 'done', instruction: 'complete once',
      startSubagent: scripted([child('done-child', result('completed', 'done', 'final handoff'))]).start,
      signal: new AbortController().signal,
    })
    expect(() => ctx.autopilotRalph.start(agent, {
      taskId: 'done', instruction: 'duplicate', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/already has/)
    expect(() => ctx.autopilotRalph.resume(agent, {
      taskId: 'generic-claim', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/no Ralph loop/)
    expect(() => ctx.autopilotRalph.resume(agent, {
      taskId: 'done', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/not interrupted/)
    await expect(ctx.autopilotRalph.cancel(agent, 'generic-claim', 'missing')).rejects.toMatchObject({
      code: 'AUTOPILOT_RALPH_MISSING',
    })

    const originalClaim = ctx.autonomy.claimTasks.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'claimTasks').mockRejectedValueOnce(new Error('claim store failed'))
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'generic-claim', instruction: 'fail closed', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('claim store failed') })
    vi.mocked(ctx.autonomy.claimTasks).mockImplementation(originalClaim)
    await resumeAttention(ctx, agent)

    const earlyAbort = new AbortController()
    const earlyRunning = ctx.autopilotRalph.start(agent, {
      taskId: 'early', instruction: 'interrupt after claim',
      startSubagent: scripted([child('unused', result('completed'))]).start,
      signal: earlyAbort.signal,
    })
    earlyAbort.abort()
    const early = await earlyRunning
    expect(early.phase).toBe('interrupted')

    const subject = probe(ctx.autopilotRalph)
    const store = subject.store!
    const wrongGoal = { ...early, goalId: 'changed-goal' }
    const resumeGoalMismatch = vi.spyOn(store, 'get').mockReturnValueOnce(wrongGoal)
    expect(() => ctx.autopilotRalph.resume(agent, {
      taskId: early.taskId, startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/exact active Goal/)
    resumeGoalMismatch.mockRestore()
    const cancelGoalMismatch = vi.spyOn(store, 'get').mockReturnValueOnce(wrongGoal)
    await expect(ctx.autopilotRalph.cancel(agent, early.taskId, 'wrong Goal')).rejects.toThrow(/exact active Goal/)
    cancelGoalMismatch.mockRestore()
    expect(await subject.interrupt(early, 'already interrupted')).toEqual(early)
    expect(await subject.interrupt(done, 'already terminal')).toEqual(done)
    expect(() => subject.assertPolicy({ ...early, policySha256: 'b'.repeat(64) })).toThrow(/policy changed/)
    expect(() => subject.resolveRequestedRounds(early.maxRounds + 1, early.maxRounds)).toThrow(/ceiling/)
    expect(subject.abortReason({ reason: undefined } as AbortSignal)).toContain('aborted')
    await expect(subject.settleResult(agent, { ...early, phase: 'running', rounds: [] }, {
      status: 'failed', summary: 'invalid internal state', evidence: [],
    })).rejects.toThrow(/no starting round/)
    expect(() => subject.roundPrompt(agent, { ...early, taskId: 'missing' }, 1)).toThrow(/disappeared/)

    ctx.tools.register(defineContentToolFixture({
      name: 'bash', description: 'bash', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'custom_unsafe', description: 'unsafe', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    expect(subject.workerToolFilter()).toEqual({ allow: ['bash'] })

    const append = vi.spyOn(store, 'appendIfCurrent').mockResolvedValueOnce(undefined)
    await expect(subject.append(early, 'interrupt', { phase: 'interrupted' })).rejects.toMatchObject({
      code: 'AUTOPILOT_RALPH_CONFLICT',
    })
    append.mockRestore()
    await subject.interruptForLifecycle(agent, done.runId, done.generation, 'terminal no-op')
    await ctx.fiber.dispose()
  })

  it('freezes provider/model routing in Host policy without exposing either to tool requests', async () => {
    for (const config of [
      { provider: 'deepseek' },
      { model: 'fixed-model' },
      { provider: 'deepseek', model: 'fixed-model' },
    ] satisfies RalphServiceConfig[]) {
      const { ctx, agent } = await harness({ ralph: config })
      const workers = scripted([child('routed-child', result('completed'))])
      await ctx.autopilotRalph.start(agent, {
        taskId: 'leaf', instruction: 'use frozen route', startSubagent: workers.start,
        signal: new AbortController().signal,
      })
      expect(workers.calls[0]?.request.agentOptions).toEqual({
        ...(config.provider === undefined ? {} : { provider: config.provider }),
        ...(config.model === undefined ? {} : { model: config.model }),
      })
      await ctx.fiber.dispose()
    }

    for (const maxSummaryChars of [1, 2]) {
      const { ctx, agent } = await harness({
        ralph: { maxSummaryChars },
      })
      const bounded = await ctx.autopilotRalph.start(agent, {
        taskId: 'leaf', instruction: 'bound internal diagnostics',
        startSubagent: scripted([child('bounded-child', rawResult(null))]).start,
        signal: new AbortController().signal,
      })
      expect(bounded.rounds[0]?.summary).toHaveLength(maxSummaryChars)
      await ctx.fiber.dispose()
    }
  })

  it('persists every interruption timing and fail-closed resume or reservation race', async () => {
    const taskIds = [
      'exhausted-resume', 'resume-missing', 'resume-failure', 'resume-status', 'resume-abort',
      'drive-abort', 'reserve-abort', 'start-abort', 'result-abort', 'block-failure',
      'reserve-settle-failure', 'concurrent',
    ]
    const { ctx, agent, goal, ralphFiber } = await harness({
      autonomy: { maxSubagents: 32 }, taskIds,
    })
    const interrupted = async (taskId: string, maxRounds = 4): Promise<RalphSnapshot> => {
      const controller = new AbortController()
      const pending = Promise.withResolvers<SubagentResult>()
      const workers = scripted([child(`${taskId}-child`, pending.promise)])
      const running = ctx.autopilotRalph.start(agent, {
        taskId, instruction: 'interrupt in flight', maxRounds, startSubagent: workers.start,
        signal: controller.signal,
      })
      await vi.waitFor(() => { expect(workers.calls).toHaveLength(1) })
      controller.abort(new Error('test interruption'))
      return running
    }

    const exhausted = await interrupted('exhausted-resume', 1)
    expect(await ctx.autopilotRalph.resume(agent, {
      taskId: exhausted.taskId, maxRounds: 1, startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'blocked', reason: expect.stringContaining('ceiling 1') })

    const missing = await interrupted('resume-missing')
    const subject = probe(ctx.autopilotRalph)
    const lease = ctx.autonomy.get(agent)!
    const { plan: _plan, ...leaseWithoutPlan } = lease
    const get = vi.spyOn(ctx.autonomy, 'get').mockReturnValueOnce(leaseWithoutPlan)
    await expect((subject as unknown as {
      resumeInternal(
        parent: Agent,
        current: RalphSnapshot,
        maxRounds: number,
        start: ManagedSubagentStart,
        signal: AbortSignal,
      ): Promise<RalphSnapshot>
    }).resumeInternal(agent, missing, missing.maxRounds, scripted([]).start, new AbortController().signal))
      .rejects.toThrow(/absent from/)
    get.mockRestore()

    const pausedController = new AbortController()
    const pausedPending = Promise.withResolvers<SubagentResult>()
    const pausedWorkers = scripted([child('resume-failure-child', pausedPending.promise)])
    const pausing = ctx.autopilotRalph.start(agent, {
      taskId: 'resume-failure', instruction: 'pause then fail claim', startSubagent: pausedWorkers.start,
      signal: pausedController.signal,
    })
    await vi.waitFor(() => { expect(pausedWorkers.calls).toHaveLength(1) })
    await ctx.autonomy.pause(agent, 'pause for resume failure')
    expect((await pausing).phase).toBe('interrupted')
    await ctx.autonomy.resume(agent, goal.id)
    const claim = vi.spyOn(ctx.autonomy, 'claimTasks').mockRejectedValueOnce(new Error('resume claim unavailable'))
    expect(await ctx.autopilotRalph.resume(agent, {
      taskId: 'resume-failure', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('resume claim unavailable') })
    claim.mockRestore()
    await resumeAttention(ctx, agent)

    const wrongStatus = await interrupted('resume-status')
    await ctx.autonomy.updateTask(agent, 'resume-status', 'fail', { reason: 'terminal leaf failure' })
    await expect(ctx.autopilotRalph.resume(agent, {
      taskId: wrongStatus.taskId, startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires pending or in_progress/)

    const resumeAbortController = new AbortController()
    const resumeAbortPending = Promise.withResolvers<SubagentResult>()
    const resumeAbortWorkers = scripted([child('resume-abort-old', resumeAbortPending.promise)])
    const resumeAbortRunning = ctx.autopilotRalph.start(agent, {
      taskId: 'resume-abort', instruction: 'pause', startSubagent: resumeAbortWorkers.start,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(resumeAbortWorkers.calls).toHaveLength(1) })
    await ctx.autonomy.pause(agent)
    await resumeAbortRunning
    await ctx.autonomy.resume(agent, goal.id)
    resumeAbortController.abort(new Error('abort resumed call'))
    expect(await ctx.autopilotRalph.resume(agent, {
      taskId: 'resume-abort', startSubagent: scripted([]).start, signal: resumeAbortController.signal,
    })).toMatchObject({ phase: 'interrupted' })

    const driveController = new AbortController()
    const originalClaim = ctx.autonomy.claimTasks.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'claimTasks').mockImplementationOnce(async (...args) => {
      const view = await originalClaim(...args)
      driveController.abort(new Error('after claim'))
      return view
    })
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'drive-abort', instruction: 'abort after claim', startSubagent: scripted([]).start,
      signal: driveController.signal,
    })).toMatchObject({ phase: 'interrupted' })
    vi.mocked(ctx.autonomy.claimTasks).mockImplementation(originalClaim)

    const reserveController = new AbortController()
    const originalRecord = ctx.autonomy.recordSubagentStarts.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'recordSubagentStarts').mockImplementationOnce(async (...args) => {
      const view = await originalRecord(...args)
      reserveController.abort(new Error('after reservation'))
      return view
    })
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'reserve-abort', instruction: 'continue once',
      startSubagent: scripted([child('reserve-abort-child', result('continue'))]).start,
      signal: reserveController.signal,
    })).toMatchObject({ phase: 'interrupted' })
    vi.mocked(ctx.autonomy.recordSubagentStarts).mockImplementation(originalRecord)

    const startAbortController = new AbortController()
    const abortingStart: ManagedSubagentStart = async () => {
      startAbortController.abort(new Error('start callback aborted'))
      throw new Error('start failed after abort')
    }
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'start-abort', instruction: 'abort in start', startSubagent: abortingStart,
      signal: startAbortController.signal,
    })).toMatchObject({ phase: 'interrupted' })

    const resultAbortController = new AbortController()
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'result-abort', instruction: 'abort after result',
      startSubagent: scripted([child('result-abort-child', result('completed'), async () => {
        resultAbortController.abort(new Error('dispose aborted'))
      })]).start,
      signal: resultAbortController.signal,
    })).toMatchObject({ phase: 'interrupted' })

    const update = vi.spyOn(ctx.autonomy, 'updateTask')
    const blockWorkers: ManagedSubagentStart = async () => {
      update.mockRejectedValueOnce(new Error('cannot persist round block'))
      return child('block-failure-child', result('continue'))
    }
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'block-failure', instruction: 'hit ceiling', maxRounds: 1,
      startSubagent: blockWorkers, signal: new AbortController().signal,
    })).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('round exhaustion') })
    update.mockRestore()
    await resumeAttention(ctx, agent)

    const budgetError = Object.assign(new Error('budget denied'), {
      code: 'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
    })
    vi.spyOn(ctx.autonomy, 'recordSubagentStarts').mockRejectedValueOnce(budgetError)
    vi.spyOn(ctx.autonomy, 'updateTask').mockRejectedValueOnce(new Error('cannot persist budget block'))
    expect(await ctx.autopilotRalph.start(agent, {
      taskId: 'reserve-settle-failure', instruction: 'budget failure',
      startSubagent: scripted([child('reserve-settle-child', result('continue'))]).start,
      signal: new AbortController().signal,
    })).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('task settlement failed') })
    vi.restoreAllMocks()
    await resumeAttention(ctx, agent)

    const concurrentPending = Promise.withResolvers<SubagentResult>()
    const concurrentWorkers = scripted([child('concurrent-child', concurrentPending.promise)])
    const concurrent = ctx.autopilotRalph.start(agent, {
      taskId: 'concurrent', instruction: 'one active loop', startSubagent: concurrentWorkers.start,
      signal: new AbortController().signal,
    })
    expect(() => ctx.autopilotRalph.start(agent, {
      taskId: 'concurrent', instruction: 'second call', startSubagent: scripted([]).start,
      signal: new AbortController().signal,
    })).toThrow(/in-flight operation/)
    await vi.waitFor(() => { expect(concurrentWorkers.calls).toHaveLength(1) })
    await ctx.autopilotRalph.cancel(agent, 'concurrent', 'finish concurrency test')
    await concurrent

    const ready = await subject.append(missing, 'resume', { phase: 'ready', reason: undefined })
    await subject.interruptForLifecycle(agent, ready.runId, ready.generation, 'inactive lifecycle')
    const inactiveInterrupted = ctx.autopilotRalph.status(agent, ready.taskId)!
    expect(inactiveInterrupted.phase).toBe('interrupted')
    const inactiveReady = await subject.append(inactiveInterrupted, 'resume', {
      phase: 'ready', reason: undefined,
    })
    const inactiveReserving = await subject.append(inactiveReady, 'reservation-prepare', {
      phase: 'reserving', pendingReservationRound: inactiveReady.rounds.length + 1,
    })
    const inactiveReserved = await subject.append(inactiveReserving, 'reservation-complete', {
      phase: 'ready',
      pendingReservationRound: undefined,
      reservedThroughRound: inactiveReady.rounds.length + 1,
      claimedRunRevision: (inactiveReady.claimedRunRevision ?? 0) + 1,
    })
    const inactiveRunning = await subject.append(inactiveReserved, 'round-start', {
      phase: 'running',
      rounds: [...inactiveReserved.rounds, {
        number: inactiveReserved.rounds.length + 1,
        status: 'starting',
        startedAt: Date.now(),
        evidence: [],
      }],
    })
    await subject.interruptForLifecycle(
      agent, inactiveRunning.runId, inactiveRunning.generation, 'orphan lifecycle',
    )
    expect(ctx.autopilotRalph.status(agent, inactiveRunning.taskId)?.phase).toBe('needs-attention')

    const lifecycle = vi.spyOn(subject, 'interruptForLifecycle').mockRejectedValueOnce(new Error('listener failed'))
    const logged = vi.spyOn(ctx.logger, 'error')
    const currentLease = ctx.autonomy.get(agent)!
    await ctx.parallel('autonomy/changed', {
      agent,
      operation: 'pause',
      view: { ...currentLease, phase: 'paused' },
    })
    await vi.waitFor(() => { expect(logged).toHaveBeenCalledWith(expect.stringContaining('listener failed')) })
    lifecycle.mockRestore()
    logged.mockRestore()

    const separate = Promise.withResolvers<RalphSnapshot>()
    const identity = {
      parentSessionId: String(agent.id), runId: 'probe-run', generation: 1, taskId: 'probe',
    }
    const ownership = subject.exclusive(
      identity, agent, new AbortController().signal, () => separate.promise,
    )
    subject.active.clear()
    separate.resolve(exhausted)
    await ownership

    subject.store = undefined
    await ralphFiber.dispose()
    await ctx.fiber.dispose()
  })
})
