import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { FoldedGoal, GoalView } from '@deepseek-ai/dsh-goal'
import { MessageId, createAssistantMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import {
  AutopilotRecovery,
  completionMessageId,
  foldCompletionDelivery,
  foldPendingLifecycleIntent,
  planRunRecovery,
  recoveryRunRef,
} from '../../src/recovery.ts'
import type {
  RecoveryReadinessAdmission,
  RecoveryRun,
  RecoveryRunController,
} from '../../src/recovery.ts'

function run(overrides: Partial<RecoveryRun> = {}): RecoveryRun {
  return {
    runId: 'run-1',
    generation: 1,
    revision: 7,
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'running',
    autoResume: true,
    completionReported: false,
    ...overrides,
  }
}

function folded(overrides: Partial<FoldedGoal> = {}): FoldedGoal {
  return {
    goal: {
      id: GoalId('goal-1'),
      revision: 2,
      objective: 'recover safely',
      phase: 'active',
      maxGoalRounds: 8,
    },
    roundsStarted: 3,
    createdAt: 100,
    updatedAt: 200,
    lastRef: { id: GoalId('goal-1'), revision: 2 },
    ...overrides,
  }
}

function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 0,
    id: SessionId('session-1'),
    createdAt: 100,
    cwd: '/workspace',
    agentPreset: 'standard',
    ...overrides,
  }
}

function rosterlessHeader(): SessionHeader {
  const value: SessionHeader = { ...header() }
  delete (value as { agentPreset?: string }).agentPreset
  return value
}

function goalEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: 'goal/change',
    seq: 0,
    time: 100,
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: 'goal-1',
        revision: 1,
        objective: 'recover safely',
        phase: 'active',
        maxGoalRounds: 8,
      },
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 100,
      ...overrides,
    },
  } as SessionEvent
}

function completedGoalEvent(): SessionEvent {
  return {
    ...goalEvent(),
    seq: 1,
    time: 200,
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'complete',
      goal: {
        id: 'goal-1',
        revision: 2,
        objective: 'recover safely',
        phase: 'complete',
        maxGoalRounds: 8,
      },
      roundsStarted: 0,
      createdAt: 100,
      updatedAt: 200,
    },
  } as SessionEvent
}

function commandRun(args: string, commandId = 'command-1', seq = 2): SessionEvent {
  return {
    type: 'command/run',
    seq,
    time: 300 + seq,
    data: {
      commandId,
      name: 'autopilot',
      args,
      source: { kind: 'user' },
    },
  } as SessionEvent
}

function commandDone(commandId = 'command-1', seq = 3): SessionEvent {
  return {
    type: 'command/done',
    seq,
    time: 300 + seq,
    data: { commandId, kind: 'success' },
  } as SessionEvent
}

function inspection(options: {
  readonly meta?: SessionHeader
  readonly events?: readonly SessionEvent[]
} = {}): SessionInspection {
  return {
    meta: options.meta ?? header(),
    events: options.events ?? [goalEvent()],
  }
}

function goalView(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: GoalId('goal-1'),
    revision: 1,
    objective: 'recover safely',
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 0,
    createdAt: 100,
    updatedAt: 100,
    activation: 'disarmed',
    ...overrides,
  }
}

function agent(id = 'session-1'): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    session: Session.create(sessionId),
    inbox: { remove: vi.fn() },
    followup: vi.fn(),
  } as unknown as Agent
}

const passingVerification = {
  attempt: 1,
  startedAt: 100,
  finishedAt: 200,
  verdict: 'pass' as const,
  summary: 'all acceptance criteria verified',
  findings: [],
  checks: [{ name: 'tests', passed: true, summary: 'passed' }],
  reviewers: [],
}

function controller(rows: readonly RecoveryRun[] = [run()]): RecoveryRunController & {
  activateRecovered: ReturnType<typeof vi.fn<RecoveryRunController['activateRecovered']>>
  finalizeRecovered: ReturnType<typeof vi.fn<RecoveryRunController['finalizeRecovered']>>
  completionNotice: ReturnType<typeof vi.fn<RecoveryRunController['completionNotice']>>
  registerCompletionDelivery: ReturnType<typeof vi.fn<RecoveryRunController['registerCompletionDelivery']>>
  settleInterruptedLifecycle: ReturnType<typeof vi.fn<RecoveryRunController['settleInterruptedLifecycle']>>
  convergeSafetyState: ReturnType<typeof vi.fn<RecoveryRunController['convergeSafetyState']>>
  convergeCompletedGoal: ReturnType<typeof vi.fn<RecoveryRunController['convergeCompletedGoal']>>
  recoverInterruptedTasks: ReturnType<typeof vi.fn<RecoveryRunController['recoverInterruptedTasks']>>
  markNeedsAttention: ReturnType<typeof vi.fn<(run: Parameters<RecoveryRunController['markNeedsAttention']>[0], reason: string) => Promise<void>>>
} {
  return {
    currentRuns: () => rows,
    activateRecovered: vi.fn(async () => ({ kind: 'recovered' as const })),
    finalizeRecovered: vi.fn(async value => ({ kind: 'finalized' as const, run: value })),
    completionNotice: vi.fn(async () => undefined),
    registerCompletionDelivery: vi.fn(async () => 'registered' as const),
    settleInterruptedLifecycle: vi.fn(async value => ({ kind: 'settled' as const, run: value })),
    convergeSafetyState: vi.fn(async value => ({ kind: 'settled' as const, run: value })),
    convergeCompletedGoal: vi.fn(async value => ({ kind: 'settled' as const, run: value })),
    recoverInterruptedTasks: vi.fn(async value => ({ kind: 'unchanged' as const, run: value })),
    markNeedsAttention: vi.fn(async () => {}),
  }
}

function host(options: {
  readonly inspected?: SessionInspection | Error
  readonly agents?: readonly (Agent | undefined)[]
  readonly resume?: (options: ResumeAgentOptions) => Promise<AgentHandle>
  readonly liveGoal?: GoalView | undefined
  readonly mount?: (agentCtx: Context, preset?: string) => Promise<unknown>
  readonly persistence?: boolean
} = {}): {
  readonly ctx: Context
  readonly inspect: ReturnType<typeof vi.fn>
  readonly getAgent: ReturnType<typeof vi.fn>
  readonly resume: ReturnType<typeof vi.fn>
  readonly mount: ReturnType<typeof vi.fn>
} {
  const inspected = options.inspected ?? inspection()
  const inspect = vi.fn(async () => {
    if (inspected instanceof Error) throw inspected
    return inspected
  })
  const values = [...(options.agents ?? [undefined, undefined])]
  const getAgent = vi.fn(() => values.shift())
  const resume = vi.fn(options.resume ?? (async () => ({ agent: agent(), dispose: vi.fn(async () => {}) })))
  const mount = vi.fn(options.mount ?? (async () => {}))
  const persistence = options.persistence === false
    ? undefined
    : { inspect, list: vi.fn(async () => [header()]) }
  const presets = options.mount === undefined && options.inspected !== undefined
    && !(options.inspected instanceof Error) && options.inspected.meta.agentPreset === undefined
    ? undefined
    : { mount }
  const ctx = {
    agents: { get: getAgent, resume },
    goals: { get: vi.fn(() => 'liveGoal' in options ? options.liveGoal : goalView()) },
    get(name: string) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'agentPresets') return presets
      return undefined
    },
  } as unknown as Context
  return { ctx, inspect, getAgent, resume, mount }
}

describe('durable lifecycle and completion folds', () => {
  it('keeps only the latest unfinished human lifecycle command', () => {
    expect(foldPendingLifecycleIntent([
      commandRun('pause', 'pause-1', 1),
      commandDone('pause-1', 2),
      commandRun('resume --duration 2h', 'resume-1', 3),
    ])).toMatchObject({
      commandId: 'resume-1',
      seq: 3,
      command: { kind: 'resume', maxActiveMs: 7_200_000 },
    })
    expect(foldPendingLifecycleIntent([
      commandRun('stop'),
      commandDone(),
    ])).toBeUndefined()
    expect(foldPendingLifecycleIntent([{
      ...commandRun('pause'),
      data: { ...commandRun('pause').data, source: { kind: 'plugin' } },
    } as SessionEvent])).toBeUndefined()
    const noArgs = commandRun('pause') as Extract<SessionEvent, { type: 'command/run' }>
    expect(foldPendingLifecycleIntent([{
      ...noArgs,
      data: {
        commandId: noArgs.data.commandId,
        name: noArgs.data.name,
        source: noArgs.data.source,
      },
    }])).toBeUndefined()
  })

  it('correlates completion only to the admitted claimed turn with durable text', () => {
    const messageId = MessageId('dsh-autopilot:run-1:completion')
    const message = freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: 'deliver completion' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-autopilot',
        form: 'notice',
        summary: 'Autopilot completion report pending',
      },
    })
    const inserted = {
      type: 'agent/inbox/spliced', seq: 1, time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    } as SessionEvent
    expect(foldCompletionDelivery([inserted], messageId)).toEqual({ kind: 'pending' })
    const claimed = [
      inserted,
      { type: 'turn/start', seq: 2, time: 2, data: { turn: 4 } },
      {
        type: 'agent/inbox/spliced', seq: 3, time: 3,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      },
      { type: 'user/message', seq: 4, time: 4, data: message },
    ] as SessionEvent[]
    expect(foldCompletionDelivery(claimed, messageId)).toEqual({ kind: 'claimed', turn: 4, admitted: true })
    const answered = [
      ...claimed,
      {
        type: 'assistant/message', seq: 5, time: 5,
        data: {
          turn: 4,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'final report' }],
            source: { provider: 'test', model: 'test' },
          }),
        },
      },
      { type: 'turn/end', seq: 6, time: 6, data: { turn: 4, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    expect(foldCompletionDelivery(answered, messageId)).toEqual({ kind: 'answered', turn: 4 })
    expect(foldCompletionDelivery([
      ...claimed,
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 4, reason: { kind: 'interrupted' } } },
    ] as SessionEvent[], messageId)).toEqual({ kind: 'absent' })

    const canceled = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 9 } },
      {
        ...inserted,
        seq: 2,
        data: { ...inserted.data, target: 'next-step' },
      },
      {
        type: 'agent/inbox/spliced', seq: 3, time: 3,
        data: {
          target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
        },
      },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 8, reason: { kind: 'interrupted' } } },
      {
        type: 'user/message', seq: 5, time: 5,
        data: { ...message, id: MessageId('other') },
      },
      {
        type: 'assistant/message', seq: 6, time: 6,
        data: {
          turn: 9,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '  ' }],
            source: { provider: 'test', model: 'test' },
          }),
        },
      },
      { type: 'turn/end', seq: 7, time: 7, data: { turn: 9, reason: { kind: 'interrupted' } } },
    ] as SessionEvent[]
    expect(foldCompletionDelivery(canceled, messageId)).toEqual({ kind: 'absent' })
    expect(foldCompletionDelivery([{
      type: 'user/message', seq: 1, time: 1,
      data: { ...message, role: 'assistant' },
    } as unknown as SessionEvent], messageId)).toEqual({ kind: 'absent' })
    expect(foldCompletionDelivery([{
      type: 'user/message', seq: 1, time: 1,
      data: { ...message, source: { kind: 'plugin', plugin: 'other', form: 'notice' } },
    } as SessionEvent], messageId)).toEqual({ kind: 'absent' })
    expect(foldCompletionDelivery([{
      type: 'plugin/custom', seq: 1, time: 1, data: {}, ignorable: true,
    } as unknown as SessionEvent], messageId)).toEqual({ kind: 'absent' })
  })
})

describe('recovery reconciliation planner', () => {
  it.each([
    [run({ autoResume: false }), folded(), 'auto-resume-disabled'],
    [run({ phase: 'paused' }), folded({ goal: { ...folded().goal!, phase: 'paused' } }), 'user-paused'],
    [run({ phase: 'revoked' }), { roundsStarted: 0 }, 'revoked'],
    [run({ phase: 'completed', completionReported: true }), folded({ goal: { ...folded().goal!, phase: 'complete' } }), 'completed'],
    [run({ phase: 'exhausted' }), folded({ goal: { ...folded().goal!, phase: 'blocked' } }), 'exhausted'],
    [run({ phase: 'needs-attention' }), folded({ goal: { ...folded().goal!, phase: 'blocked' } }), 'needs-attention'],
  ] as const)('skips a deliberately ineligible run only after Goal reconciliation %#', (value, state, code) => {
    expect(planRunRecovery(value, state)).toMatchObject({ kind: 'skip', code })
  })

  it('recovers running and verifying rows only with one matching active Goal', () => {
    expect(planRunRecovery(run(), folded())).toEqual({
      kind: 'recover',
      goal: { id: GoalId('goal-1'), revision: 2, roundsStarted: 3, maxGoalRounds: 8 },
    })
    expect(planRunRecovery(run({ phase: 'verifying' }), folded())).toMatchObject({ kind: 'recover' })
  })

  it('converges finalization and delivers only pending completion notices', () => {
    const finalizing = run({ phase: 'finalizing', autoResume: false, finalization: passingVerification })
    expect(planRunRecovery(finalizing, folded())).toEqual({
      kind: 'finalize',
      goal: { id: GoalId('goal-1'), revision: 2 },
      goalPhase: 'active',
    })
    expect(planRunRecovery(finalizing, folded({
      goal: { ...folded().goal!, phase: 'complete' },
    }))).toMatchObject({ kind: 'finalize', goalPhase: 'complete' })
    expect(planRunRecovery(run({ phase: 'finalizing' }), folded())).toMatchObject({
      kind: 'needs-attention', reason: /no passing verification/,
    })
    expect(planRunRecovery(finalizing, folded({
      goal: { ...folded().goal!, phase: 'paused' },
    }))).toMatchObject({ kind: 'needs-attention', reason: /finalizing.*paused/ })

    const completed = run({ phase: 'completed', autoResume: false, completionReported: false })
    expect(planRunRecovery(completed, folded({
      goal: { ...folded().goal!, phase: 'complete' },
    }))).toEqual({ kind: 'completion-notice' })
    expect(planRunRecovery(completed, folded())).toMatchObject({ kind: 'converge-completion' })
  })

  it.each([
    [{ roundsStarted: 0 }, /no current Goal/],
    [folded({ goal: { ...folded().goal!, id: GoalId('other') } }), /does not match/],
    [folded({ goal: { ...folded().goal!, phase: 'paused' } }), /conflicts/],
    [folded({ roundsStarted: 8 }), /budget is exhausted/],
  ] as const)('fails closed on durable disagreement %#', (state, message) => {
    expect(planRunRecovery(run(), state)).toMatchObject({ kind: 'needs-attention', reason: message })
  })

  it.each([
    [run({ phase: 'paused' }), 'active', 'converge-safety'],
    [run({ phase: 'revoked' }), 'paused', 'converge-safety'],
    [run({ phase: 'revoked' }), 'blocked', 'converge-safety'],
    [run({ phase: 'exhausted' }), 'active', 'converge-safety'],
    [run({ phase: 'needs-attention' }), 'active', 'converge-safety'],
    [run({ phase: 'paused' }), 'complete', 'needs-attention'],
    [run({ phase: 'revoked' }), 'complete', 'needs-attention'],
    [run({ phase: 'completed' }), 'paused', 'needs-attention'],
    [run({ autoResume: false }), 'paused', 'needs-attention'],
  ] as const)('reconciles stopped or conflicting Goal phase %#', (value, phase, kind) => {
    expect(planRunRecovery(value, folded({
      goal: { ...folded().goal!, phase },
    }))).toMatchObject({ kind })
  })

  it('projects an immutable recovery compare-and-set identity', () => {
    expect(recoveryRunRef(run())).toEqual({
      runId: 'run-1', generation: 1, revision: 7, sessionId: 'session-1',
    })
  })
})

describe('AutopilotRecovery', () => {
  it('serializes same-session recovery and safely ignores sessions without recoverable work', async () => {
    const live = agent()
    const testHost = host({ agents: [live] })
    let releaseInspect: ((value: SessionInspection) => void) | undefined
    testHost.inspect.mockImplementation(() => new Promise<SessionInspection>((resolve) => {
      releaseInspect = resolve
    }))
    const recovery = new AutopilotRecovery(testHost.ctx, controller())
    const first = recovery.recoverSession('session-1')
    const second = recovery.recoverSession('session-1')
    releaseInspect?.(inspection())
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { outcome: 'recovered' }, { outcome: 'recovered' },
    ])
    expect(testHost.inspect).toHaveBeenCalledOnce()
    await recovery.dispose()

    const orphanHost = host({
      inspected: inspection({ events: [commandRun('start recover orphan')] }),
    })
    let releaseOrphan: ((value: SessionInspection) => void) | undefined
    orphanHost.inspect.mockImplementation(() => new Promise<SessionInspection>((resolve) => {
      releaseOrphan = resolve
    }))
    const orphanRecovery = new AutopilotRecovery(orphanHost.ctx, controller([]))
    const orphanFirst = orphanRecovery.recoverSession('session-1')
    const orphanSecond = orphanRecovery.recoverSession('session-1')
    releaseOrphan?.(inspection({ events: [commandRun('start recover orphan')] }))
    await expect(Promise.all([orphanFirst, orphanSecond])).resolves.toMatchObject([
      { outcome: 'needs-attention' }, { outcome: 'needs-attention' },
    ])
    expect(orphanHost.inspect).toHaveBeenCalledOnce()
    await orphanRecovery.dispose()

    const empty = new AutopilotRecovery(host({
      inspected: inspection({ events: [goalEvent()] }),
    }).ctx, controller([]))
    await expect(empty.recoverSession('session-1')).resolves.toBeUndefined()
    await expect(empty.recover()).resolves.toEqual([])
    await empty.dispose()

    const unavailable = new AutopilotRecovery(host({ persistence: false }).ctx, controller([]))
    await expect(unavailable.recoverSession('session-1')).resolves.toBeUndefined()
    await unavailable.dispose()
  })

  it('skips orphan scanning for sidecar-owned and subagent sessions', async () => {
    const testHost = host({ agents: [agent()] })
    const persistence = testHost.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('fixture persistence is missing')
    vi.mocked(persistence.list).mockResolvedValue([
      header(),
      header({ id: SessionId('subagent-session'), origin: 'subagent' }),
    ])
    const recovery = new AutopilotRecovery(testHost.ctx, controller())
    await expect(recovery.recover()).resolves.toHaveLength(1)
    expect(testHost.inspect).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it('accepts a concurrent needs-attention winner after its exact marker is stale', async () => {
    const testHost = host({ persistence: false })
    const control = controller()
    let scans = 0
    control.currentRuns = vi.fn(() => scans++ === 0
      ? [run()]
      : [run({ revision: 8, phase: 'needs-attention' })])
    control.markNeedsAttention.mockRejectedValue(new Error('stale recovery run'))
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{
      run: { revision: 8 },
      outcome: 'needs-attention',
      reason: expect.stringContaining('sessionPersistence is unavailable'),
    }])
    await recovery.dispose()
  })

  it('surfaces an interrupted start with no sidecar without guessing deployment policy', async () => {
    const testHost = host({
      inspected: inspection({ events: [commandRun('start --duration 2h finish the release')] }),
    })
    const recovery = new AutopilotRecovery(testHost.ctx, controller([]))

    await expect(recovery.recover()).resolves.toEqual([{
      sessionId: 'session-1',
      commandId: 'command-1',
      outcome: 'needs-attention',
      reason: expect.stringMatching(/no sidecar.*will not guess/),
    }])
    expect(testHost.resume).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('settles an unfinished human pause before considering automatic activation', async () => {
    const live = agent()
    const testHost = host({
      inspected: inspection({ events: [goalEvent(), commandRun('pause')] }),
      agents: [live],
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toEqual([{
      run: recoveryRunRef(run()), outcome: 'skipped', reason: 'interrupted pause intent settled',
    }])
    expect(control.settleInterruptedLifecycle).toHaveBeenCalledWith(
      recoveryRunRef(run()),
      live,
      expect.objectContaining({ command: { kind: 'pause' } }),
    )
    expect(control.activateRecovered).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('contains every interrupted lifecycle controller outcome and cleanup result', async () => {
    const interrupted = inspection({ events: [goalEvent(), commandRun('resume')] })

    const supersededLive = host({ inspected: interrupted, agents: [agent()] })
    const supersededControl = controller()
    supersededControl.settleInterruptedLifecycle.mockResolvedValue({
      kind: 'superseded', reason: 'newer human command won',
    })
    const superseded = new AutopilotRecovery(supersededLive.ctx, supersededControl)
    await expect(superseded.recover()).resolves.toMatchObject([{
      outcome: 'skipped', reason: 'newer human command won',
    }])
    await superseded.dispose()

    const supersededCleanup = host({
      inspected: interrupted,
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('superseded lifecycle cleanup stuck') }),
      }),
    })
    const supersededCleanupControl = controller()
    supersededCleanupControl.settleInterruptedLifecycle.mockResolvedValue({
      kind: 'superseded', reason: 'newer human command won',
    })
    const failedSuperseded = new AutopilotRecovery(supersededCleanup.ctx, supersededCleanupControl)
    await expect(failedSuperseded.recover()).resolves.toMatchObject([{
      outcome: 'needs-attention', reason: /newer human command won.*cleanup stuck/,
    }])
    await failedSuperseded.dispose()

    const attentionLive = host({ inspected: interrupted, agents: [agent()] })
    const attentionControl = controller()
    attentionControl.settleInterruptedLifecycle.mockResolvedValue({
      kind: 'needs-attention', reason: 'lifecycle sources disagree',
    })
    const attention = new AutopilotRecovery(attentionLive.ctx, attentionControl)
    await expect(attention.recover()).resolves.toMatchObject([{
      outcome: 'needs-attention', reason: 'lifecycle sources disagree',
    }])
    await attention.dispose()

    const attentionCleanup = host({
      inspected: interrupted,
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('attention lifecycle cleanup stuck') }),
      }),
    })
    const attentionCleanupControl = controller()
    attentionCleanupControl.settleInterruptedLifecycle.mockResolvedValue({
      kind: 'needs-attention', reason: 'lifecycle sources disagree',
    })
    const failedAttention = new AutopilotRecovery(attentionCleanup.ctx, attentionCleanupControl)
    await expect(failedAttention.recover()).resolves.toMatchObject([{
      outcome: 'failed', reason: /lifecycle sources disagree.*cleanup stuck/,
    }])
    await failedAttention.dispose()

    const retainedDispose = vi.fn(async () => {})
    const recoveredHost = host({
      inspected: interrupted,
      resume: async () => ({ agent: agent(), dispose: retainedDispose }),
    })
    const recoveredControl = controller()
    recoveredControl.settleInterruptedLifecycle.mockResolvedValue({
      kind: 'recovered', run: { ...recoveryRunRef(run()), revision: 8 },
    })
    const recovered = new AutopilotRecovery(recoveredHost.ctx, recoveredControl)
    await expect(recovered.recover()).resolves.toMatchObject([{
      outcome: 'recovered', agent: 'cold-resumed', run: { revision: 8 },
    }])
    expect(retainedDispose).not.toHaveBeenCalled()
    await recovered.dispose()
    expect(retainedDispose).toHaveBeenCalledOnce()

    const borrowedRecoveredHost = host({ inspected: interrupted, agents: [agent()] })
    const borrowedRecoveredControl = controller()
    borrowedRecoveredControl.settleInterruptedLifecycle.mockResolvedValue({
      kind: 'recovered', run: recoveryRunRef(run()),
    })
    const borrowedRecovered = new AutopilotRecovery(borrowedRecoveredHost.ctx, borrowedRecoveredControl)
    await expect(borrowedRecovered.recover()).resolves.toMatchObject([{
      outcome: 'recovered', agent: 'already-live',
    }])
    await borrowedRecovered.dispose()

    const settledCleanup = host({
      inspected: interrupted,
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('settled lifecycle cleanup stuck') }),
      }),
    })
    const failedSettled = new AutopilotRecovery(settledCleanup.ctx, controller())
    await expect(failedSettled.recover()).resolves.toMatchObject([{
      outcome: 'failed', reason: /lifecycle cleanup failed: settled lifecycle cleanup stuck/,
    }])
    await failedSettled.dispose()
  })

  it('converges the Goal side of a durable safety phase before skipping it', async () => {
    const row = run({ phase: 'needs-attention' })
    const live = agent()
    const testHost = host({ agents: [live] })
    const control = controller([row])
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{
      outcome: 'skipped', reason: 'durable needs-attention state converged',
    }])
    expect(control.convergeSafetyState).toHaveBeenCalledWith(
      recoveryRunRef(row), live, { id: GoalId('goal-1'), revision: 1 },
    )
    await recovery.dispose()
  })

  it('contains safety and completion convergence races, attention, notices, and cleanup failure', async () => {
    const safetyRow = run({ phase: 'paused' })
    const supersededControl = controller([safetyRow])
    supersededControl.convergeSafetyState.mockResolvedValue({
      kind: 'superseded', reason: 'Goal changed during convergence',
    })
    const superseded = new AutopilotRecovery(host({ agents: [agent()] }).ctx, supersededControl)
    await expect(superseded.recover()).resolves.toMatchObject([{
      outcome: 'skipped', reason: 'Goal changed during convergence',
    }])
    await superseded.dispose()

    const supersededCleanupControl = controller([safetyRow])
    supersededCleanupControl.convergeSafetyState.mockResolvedValue({
      kind: 'superseded', reason: 'Goal changed during convergence',
    })
    const supersededCleanup = new AutopilotRecovery(host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('convergence race cleanup stuck') }),
      }),
    }).ctx, supersededCleanupControl)
    await expect(supersededCleanup.recover()).resolves.toMatchObject([{
      outcome: 'needs-attention', reason: /Goal changed.*cleanup stuck/,
    }])
    await supersededCleanup.dispose()

    const attentionControl = controller([safetyRow])
    attentionControl.convergeSafetyState.mockResolvedValue({
      kind: 'needs-attention', reason: 'Goal cannot be paused safely',
    })
    const attention = new AutopilotRecovery(host({ agents: [agent()] }).ctx, attentionControl)
    await expect(attention.recover()).resolves.toMatchObject([{
      outcome: 'needs-attention', reason: 'Goal cannot be paused safely',
    }])
    await attention.dispose()

    const attentionCleanupControl = controller([safetyRow])
    attentionCleanupControl.convergeSafetyState.mockResolvedValue({
      kind: 'needs-attention', reason: 'Goal cannot be paused safely',
    })
    const attentionCleanup = new AutopilotRecovery(host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('convergence attention cleanup stuck') }),
      }),
    }).ctx, attentionCleanupControl)
    await expect(attentionCleanup.recover()).resolves.toMatchObject([{
      outcome: 'failed', reason: /Goal cannot be paused.*cleanup stuck/,
    }])
    await attentionCleanup.dispose()

    const completedRow = run({ phase: 'completed', completionReported: false })
    const completionControl = controller([completedRow])
    const completion = new AutopilotRecovery(host({ agents: [agent()] }).ctx, completionControl)
    await expect(completion.recover()).resolves.toMatchObject([{
      outcome: 'skipped', reason: 'durable completed state converged',
    }])
    expect(completionControl.convergeCompletedGoal).toHaveBeenCalledOnce()
    await completion.dispose()

    const notice = {
      id: 'run-1:completion', runId: 'run-1', goalId: 'goal-1', summary: 'verified',
    }
    const noticeControl = controller([completedRow])
    noticeControl.completionNotice.mockResolvedValue(notice)
    const noticeAgent = agent()
    const completionNotice = new AutopilotRecovery(host({ agents: [noticeAgent] }).ctx, noticeControl)
    await expect(completionNotice.recover()).resolves.toMatchObject([{
      outcome: 'completion-notice', notice,
    }])
    expect(noticeAgent.followup).toHaveBeenCalledOnce()
    await completionNotice.dispose()

    const reportedRow = run({ phase: 'completed', completionReported: true })
    const cleanupFailure = new AutopilotRecovery(host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('converged cleanup stuck') }),
      }),
    }).ctx, controller([reportedRow]))
    await expect(cleanupFailure.recover()).resolves.toMatchObject([{
      outcome: 'failed', reason: /convergence cleanup failed: converged cleanup stuck/,
    }])
    await cleanupFailure.dispose()
  })

  it('inspects durable user and terminal states before declaring them converged', async () => {
    const rows = [
      run({ runId: 'disabled', autoResume: false }),
      run({ runId: 'paused', phase: 'paused' }),
      run({ runId: 'revoked', phase: 'revoked' }),
      run({ runId: 'completed', phase: 'completed', completionReported: true }),
      run({ runId: 'exhausted', phase: 'exhausted' }),
      run({ runId: 'attention', phase: 'needs-attention' }),
    ]
    const testHost = host()
    const recovery = new AutopilotRecovery(testHost.ctx, controller(rows))

    expect((await recovery.recover()).map(report => report.outcome)).toEqual(rows.map(() => 'skipped'))
    expect(testHost.inspect).toHaveBeenCalledTimes(rows.length)
    await recovery.dispose()
  })

  it('preserves the recorded preset, cold-resumes, activates, and owns the returned handle', async () => {
    const dispose = vi.fn(async () => {})
    const testAgent = agent()
    const testHost = host({
      resume: async (options) => {
        await options.setup?.({} as Context)
        return { agent: testAgent, dispose }
      },
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toEqual([{
      run: recoveryRunRef(run()), outcome: 'recovered', agent: 'cold-resumed',
    }])
    expect(testHost.mount).toHaveBeenCalledWith(expect.anything(), 'standard')
    expect(testHost.resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: SessionId('session-1'), setup: expect.any(Function) as AgentSetup,
    }))
    expect(control.activateRecovered).toHaveBeenCalledWith(
      recoveryRunRef(run()), testAgent, { id: GoalId('goal-1'), revision: 1 },
    )
    expect(dispose).not.toHaveBeenCalled()
    await recovery.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the admitted recovery ref when the latest row is no longer observable', async () => {
    const live = agent()
    const control = controller()
    vi.spyOn(control, 'currentRuns')
      .mockReturnValueOnce([run()])
      .mockReturnValueOnce([])
    const recovery = new AutopilotRecovery(host({ agents: [live] }).ctx, control)

    await expect(recovery.recover()).resolves.toEqual([{
      run: recoveryRunRef(run()), outcome: 'recovered', agent: 'already-live',
    }])
    await recovery.dispose()
  })

  it('settles interrupted attempts before activation and uses the advanced sidecar revision', async () => {
    const testHost = host({ agents: [agent()] })
    const control = controller()
    const advanced = { ...recoveryRunRef(run()), revision: 8 }
    control.recoverInterruptedTasks.mockResolvedValue({
      kind: 'recovered', run: advanced, taskIds: ['build'],
    })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{ outcome: 'recovered' }])
    expect(control.recoverInterruptedTasks).toHaveBeenCalledWith(
      recoveryRunRef(run()),
      expect.anything(),
      expect.stringMatching(/process restarted/),
    )
    expect(control.activateRecovered).toHaveBeenCalledWith(
      advanced,
      expect.anything(),
      { id: GoalId('goal-1'), revision: 1 },
    )
    await recovery.dispose()
  })

  it('fails closed when readiness changes while a cold Agent is being acquired', async () => {
    let epoch = 0
    const readiness: RecoveryReadinessAdmission = {
      checkpoint() {
        const captured = epoch
        return {
          assertCurrent() {
            if (epoch !== captured) throw new Error('bundle generation changed')
          },
        }
      },
    }
    const dispose = vi.fn(async () => {})
    const testHost = host({
      resume: async () => {
        epoch += 1
        return { agent: agent(), dispose }
      },
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control, readiness)

    await expect(recovery.recover()).resolves.toMatchObject([{
      outcome: 'needs-attention',
      reason: expect.stringContaining('bundle generation changed'),
    }])
    expect(control.activateRecovered).not.toHaveBeenCalled()
    expect(control.markNeedsAttention).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it('captures a fresh readiness generation for same-host recovery after successful HMR', async () => {
    let epoch = 0
    const checkpoint = vi.fn(() => {
      const captured = epoch
      return {
        assertCurrent() {
          if (epoch !== captured) throw new Error('stale readiness generation')
        },
      }
    })
    const live = agent()
    const testHost = host({ agents: [live, live] })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control, { checkpoint })

    await expect(recovery.recover()).resolves.toMatchObject([{ outcome: 'recovered' }])
    epoch += 1
    await expect(recovery.recoverSession('session-1')).resolves.toMatchObject({ outcome: 'recovered' })
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(control.activateRecovered).toHaveBeenCalledTimes(2)
    expect(control.activateRecovered.mock.calls[1]?.[3]).toEqual(expect.objectContaining({
      assertCurrent: expect.any(Function),
    }))
    await recovery.dispose()
  })

  it('converges a reserved finalization and releases its temporary Agent', async () => {
    const row = run({ phase: 'finalizing', finalization: passingVerification })
    const dispose = vi.fn(async () => {})
    const testAgent = agent()
    const testHost = host({ resume: async () => ({ agent: testAgent, dispose }) })
    const control = controller([row])
    const notice = {
      id: 'run-1:completion', runId: 'run-1', goalId: 'goal-1', summary: 'verified',
    }
    const finalizedRef = { ...recoveryRunRef(row), revision: row.revision + 1 }
    control.finalizeRecovered.mockResolvedValue({ kind: 'finalized', run: finalizedRef, notice })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toEqual([{
      run: finalizedRef, outcome: 'finalized', notice,
    }])
    expect(control.finalizeRecovered).toHaveBeenCalledWith(
      recoveryRunRef(row), testAgent, { id: GoalId('goal-1'), revision: 1 },
    )
    expect(control.registerCompletionDelivery).toHaveBeenCalledWith(
      finalizedRef,
      testAgent,
      completionMessageId(notice),
    )
    expect(testAgent.followup).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    await recovery.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('injects a pending completion notice and retains the cold Agent until disposal', async () => {
    const row = run({ phase: 'completed', autoResume: false, completionReported: false })
    const value = inspection({ events: [goalEvent(), completedGoalEvent()] })
    const dispose = vi.fn(async () => {})
    const testAgent = agent()
    const testHost = host({
      inspected: value,
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
      resume: async () => ({ agent: testAgent, dispose }),
    })
    const control = controller([row])
    const notice = {
      id: 'run-1:completion', runId: 'run-1', goalId: 'goal-1', summary: 'verified',
    }
    control.completionNotice.mockResolvedValue(notice)
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toEqual([{
      run: recoveryRunRef(row), outcome: 'completion-notice', notice,
    }])
    expect(testAgent.followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: expect.stringMatching(/completion notice.*verified/) })],
      source: expect.objectContaining({ plugin: 'dsh-autopilot', form: 'notice' }),
    }))
    expect(control.registerCompletionDelivery).toHaveBeenCalledWith(
      recoveryRunRef(row),
      testAgent,
      completionMessageId(notice),
    )
    expect(dispose).not.toHaveBeenCalled()
    await recovery.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('requeues an already-pending deterministic notice to wake a resumed Agent', async () => {
    const row = run({ phase: 'completed', autoResume: false, completionReported: false })
    const notice = {
      id: 'run-1:completion', runId: 'run-1', goalId: 'goal-1', summary: 'verified',
    }
    const messageId = completionMessageId(notice)
    const pendingMessage = freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: 'pending completion' }],
      source: {
        kind: 'plugin', plugin: 'dsh-autopilot', form: 'notice', summary: 'pending completion',
      },
    })
    const live = agent()
    live.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [pendingMessage as never],
    })
    vi.mocked(live.inbox.remove).mockReturnValue(true)
    const testHost = host({
      inspected: inspection({ events: [goalEvent(), completedGoalEvent()] }),
      agents: [live],
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
    })
    const control = controller([row])
    control.completionNotice.mockResolvedValue(notice)
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{ outcome: 'completion-notice' }])
    expect(live.inbox.remove).toHaveBeenCalledWith(messageId)
    expect(live.followup).toHaveBeenCalledWith(expect.objectContaining({ id: messageId }))
    await recovery.dispose()
  })

  it('does not duplicate a notice that is claimed, cannot be removed, or was already reported', async () => {
    const row = run({ phase: 'completed', autoResume: false, completionReported: false })
    const notice = {
      id: 'run-1:completion', runId: 'run-1', goalId: 'goal-1', summary: 'verified',
    }
    const messageId = completionMessageId(notice)
    const pendingMessage = freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: 'pending completion' }],
      source: {
        kind: 'plugin', plugin: 'dsh-autopilot', form: 'notice', summary: 'pending completion',
      },
    })
    const completedInspection = inspection({ events: [goalEvent(), completedGoalEvent()] })

    const immovable = agent()
    immovable.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [pendingMessage],
    })
    vi.mocked(immovable.inbox.remove).mockReturnValue(false)
    const immovableControl = controller([row])
    immovableControl.completionNotice.mockResolvedValue(notice)
    const pendingRecovery = new AutopilotRecovery(host({
      inspected: completedInspection,
      agents: [immovable],
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
    }).ctx, immovableControl)
    await pendingRecovery.recover()
    expect(immovable.followup).not.toHaveBeenCalled()
    await pendingRecovery.dispose()

    const claimed = agent()
    claimed.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [pendingMessage],
    })
    claimed.session.append('turn/start', { turn: 2 })
    claimed.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [],
    })
    claimed.session.append('user/message', pendingMessage, { surfaceOp: 'append' })
    const claimedControl = controller([row])
    claimedControl.completionNotice.mockResolvedValue(notice)
    const claimedRecovery = new AutopilotRecovery(host({
      inspected: completedInspection,
      agents: [claimed],
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
    }).ctx, claimedControl)
    await claimedRecovery.recover()
    expect(claimed.followup).not.toHaveBeenCalled()
    await claimedRecovery.dispose()

    const reported = agent()
    const reportedControl = controller([row])
    reportedControl.completionNotice.mockResolvedValue(notice)
    reportedControl.registerCompletionDelivery.mockResolvedValue('reported')
    const reportedRecovery = new AutopilotRecovery(host({
      inspected: completedInspection,
      agents: [reported],
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
    }).ctx, reportedControl)
    await reportedRecovery.recover()
    expect(reported.followup).not.toHaveBeenCalled()
    await reportedRecovery.dispose()
  })

  it('releases a cold Agent when a completion notice was concurrently acknowledged', async () => {
    const row = run({ phase: 'completed', completionReported: false })
    const value = inspection({ events: [goalEvent(), completedGoalEvent()] })
    const dispose = vi.fn(async () => {})
    const testHost = host({
      inspected: value,
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
      resume: async () => ({ agent: agent(), dispose }),
    })
    const recovery = new AutopilotRecovery(testHost.ctx, controller([row]))

    await expect(recovery.recover()).resolves.toEqual([{
      run: recoveryRunRef(row), outcome: 'skipped', reason: 'completion notice was already reported',
    }])
    expect(dispose).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it('reports cleanup failure when an acknowledged completion has a stuck cold Agent', async () => {
    const row = run({ phase: 'completed', completionReported: false })
    const testHost = host({
      inspected: inspection({ events: [goalEvent(), completedGoalEvent()] }),
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => { throw new Error('notice Agent stuck') }),
      }),
    })
    const recovery = new AutopilotRecovery(testHost.ctx, controller([row]))

    await expect(recovery.recover()).resolves.toMatchObject([{
      outcome: 'failed', reason: /completion notice cleanup failed: notice Agent stuck/,
    }])
    await recovery.dispose()
  })

  it('delivers a pending notice through a borrowed live Agent without owning it', async () => {
    const row = run({ phase: 'completed', completionReported: false })
    const live = agent()
    const testHost = host({
      inspected: inspection({ events: [goalEvent(), completedGoalEvent()] }),
      agents: [live],
      liveGoal: goalView({ phase: 'complete', revision: 2 }),
    })
    const control = controller([row])
    control.completionNotice.mockResolvedValue({
      id: 'run-1:completion', runId: 'run-1', goalId: 'goal-1', summary: 'verified',
    })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{ outcome: 'completion-notice' }])
    expect(live.followup).toHaveBeenCalledOnce()
    expect(testHost.resume).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it.each([
    ['clean cleanup', false],
    ['failed cleanup', true],
  ] as const)('fails finalization closed on live Goal mismatch with %s', async (_label, cleanupFails) => {
    const row = run({ phase: 'finalizing', finalization: passingVerification })
    const dispose = vi.fn(async () => {
      if (cleanupFails) throw new Error('mismatch cleanup stuck')
    })
    const testHost = host({
      liveGoal: undefined,
      resume: async () => ({ agent: agent(), dispose }),
    })
    const control = controller([row])
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{
      outcome: 'needs-attention',
      reason: cleanupFails ? /Goal changed.*cleanup stuck/ : /Goal changed/,
    }])
    expect(control.finalizeRecovered).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it.each([
    ['superseded', false],
    ['superseded-cleanup-failed', true],
  ] as const)('contains a superseded finalization outcome: %s', async (_label, cleanupFails) => {
    const row = run({ phase: 'finalizing', finalization: passingVerification })
    const testHost = host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => {
          if (cleanupFails) throw new Error('superseded cleanup stuck')
        }),
      }),
    })
    const control = controller([row])
    control.finalizeRecovered.mockResolvedValue({ kind: 'superseded', reason: 'operator won CAS' })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([cleanupFails
      ? { outcome: 'needs-attention', reason: /operator won CAS.*cleanup stuck/ }
      : { outcome: 'skipped', reason: 'operator won CAS' }])
    await recovery.dispose()
  })

  it.each([
    ['clean cleanup', false],
    ['failed cleanup', true],
  ] as const)('contains controller-owned finalization attention with %s', async (_label, cleanupFails) => {
    const row = run({ phase: 'finalizing', finalization: passingVerification })
    const testHost = host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => {
          if (cleanupFails) throw new Error('attention cleanup stuck')
        }),
      }),
    })
    const control = controller([row])
    control.finalizeRecovered.mockResolvedValue({ kind: 'needs-attention', reason: 'sources disagree' })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([{
      outcome: cleanupFails ? 'failed' : 'needs-attention',
      reason: cleanupFails ? /sources disagree.*cleanup stuck/ : 'sources disagree',
    }])
    await recovery.dispose()
  })

  it.each([
    ['clean cleanup', false],
    ['failed cleanup', true],
  ] as const)('releases a finalized run with no pending notice after %s', async (_label, cleanupFails) => {
    const row = run({ phase: 'finalizing', finalization: passingVerification })
    const testHost = host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => {
          if (cleanupFails) throw new Error('finalized cleanup stuck')
        }),
      }),
    })
    const control = controller([row])
    control.finalizeRecovered.mockResolvedValue({
      kind: 'finalized', run: { ...recoveryRunRef(row), revision: row.revision + 1 },
    })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([cleanupFails
      ? { outcome: 'failed', reason: /finalized run cleanup failed/ }
      : { outcome: 'finalized' }])
    await recovery.dispose()
  })

  it.each([
    ['clean cleanup', false],
    ['failed cleanup', true],
  ] as const)('contains interrupted-task recovery supersession with %s', async (_label, cleanupFails) => {
    const testHost = host({
      resume: async () => ({
        agent: agent(),
        dispose: vi.fn(async () => {
          if (cleanupFails) throw new Error('task cleanup stuck')
        }),
      }),
    })
    const control = controller()
    control.recoverInterruptedTasks.mockResolvedValue({ kind: 'superseded', reason: 'user paused' })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    await expect(recovery.recover()).resolves.toMatchObject([cleanupFails
      ? { outcome: 'needs-attention', reason: /user paused.*task cleanup stuck/ }
      : { outcome: 'skipped', reason: 'user paused' }])
    await recovery.dispose()
  })

  it('borrows an already-live Agent and never disposes it', async () => {
    const live = agent()
    const testHost = host({ agents: [live] })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{ outcome: 'recovered', agent: 'already-live' }])
    expect(testHost.resume).not.toHaveBeenCalled()
    expect(testHost.mount).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('borrows a race winner after a competing resume publishes first', async () => {
    const winner = agent()
    const testHost = host({
      agents: [undefined, undefined, winner],
      resume: async () => { throw new Error('already registered') },
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{ outcome: 'recovered', agent: 'race-winner' }])
    expect(control.activateRecovered).toHaveBeenCalledWith(recoveryRunRef(run()), winner, expect.anything())
    await recovery.dispose()
  })

  it('uses a race winner found immediately before resume', async () => {
    const winner = agent()
    const testHost = host({ agents: [undefined, winner] })
    const recovery = new AutopilotRecovery(testHost.ctx, controller())

    expect(await recovery.recover()).toMatchObject([{ outcome: 'recovered', agent: 'race-winner' }])
    expect(testHost.resume).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('marks a resume failure needs-attention when no publication-race winner exists', async () => {
    const testHost = host({
      agents: [undefined, undefined, undefined],
      resume: async () => { throw new Error('persistence prepare failed') },
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'needs-attention', reason: /persistence prepare failed/,
    }])
    expect(control.markNeedsAttention).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it.each([
    ['missing persistence', host({ persistence: false }), /sessionPersistence is unavailable/],
    ['inspection error', host({ inspected: new Error('log unavailable') }), /log unavailable/],
    ['subagent session', host({ inspected: inspection({ meta: header({ origin: 'subagent' }) }) }), /subagent routing/],
    ['malformed Goal log', host({ inspected: inspection({ events: [goalEvent({ version: 99 })] }) }), /unsupported goal change/],
  ] as const)('marks pre-publication failure needs-attention: %s', async (_label, testHost, message) => {
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{ outcome: 'needs-attention', reason: message }])
    expect(control.markNeedsAttention).toHaveBeenCalledWith(recoveryRunRef(run()), expect.stringMatching(message))
    await recovery.dispose()
  })

  it('marks a missing preset provider without publishing an Agent', async () => {
    const value = inspection({ meta: header({ agentPreset: 'missing-provider' }) })
    const inspect = vi.fn(async () => value)
    const resume = vi.fn()
    const ctx = {
      agents: { get: vi.fn(() => undefined), resume },
      goals: { get: vi.fn(() => goalView()) },
      get(name: string) {
        if (name === 'sessionPersistence') return { inspect, list: vi.fn(async () => [value.meta]) }
        return undefined
      },
    } as unknown as Context
    const control = controller()
    const recovery = new AutopilotRecovery(ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'needs-attention', reason: /agentPresets is unavailable/,
    }])
    expect(resume).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('marks a sidecar/session Goal disagreement before publishing an Agent', async () => {
    const differentGoal = {
      id: 'goal-2',
      revision: 1,
      objective: 'different work',
      phase: 'active',
      maxGoalRounds: 8,
    }
    const testHost = host({
      inspected: inspection({ events: [goalEvent({ goal: differentGoal })] }),
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'needs-attention', reason: /does not match/,
    }])
    expect(testHost.resume).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it.each([
    [undefined, /no current Goal/],
    [goalView({ id: GoalId('other') }), /expected/],
    [goalView({ revision: 2 }), /changed while recovery/],
    [goalView({ roundsStarted: 1 }), /changed while recovery/],
    [goalView({ phase: 'paused' }), /durably paused/],
  ] as const)('disposes a new Agent when its live Goal does not match %#', async (liveGoal, message) => {
    const dispose = vi.fn(async () => {})
    const testHost = host({
      liveGoal,
      resume: async () => ({ agent: agent(), dispose }),
    })
    const control = controller()
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{ outcome: 'needs-attention', reason: message }])
    expect(dispose).toHaveBeenCalledOnce()
    expect(control.activateRecovered).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('disposes a new Agent when activation was concurrently superseded', async () => {
    const dispose = vi.fn(async () => {})
    const testHost = host({ resume: async () => ({ agent: agent(), dispose }) })
    const control = controller()
    control.activateRecovered.mockResolvedValue({ kind: 'superseded', reason: 'user paused during recovery' })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toEqual([{
      run: recoveryRunRef(run()), outcome: 'skipped', reason: 'user paused during recovery',
    }])
    expect(dispose).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it('does not dispose a borrowed live Agent when activation was superseded', async () => {
    const live = agent()
    const testHost = host({ agents: [live] })
    const control = controller()
    control.activateRecovered.mockResolvedValue({ kind: 'superseded', reason: 'authorization revoked' })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toEqual([{
      run: recoveryRunRef(run()), outcome: 'skipped', reason: 'authorization revoked',
    }])
    await recovery.dispose()
  })

  it('releases a cold Agent when activation itself persisted needs-attention', async () => {
    const dispose = vi.fn(async () => {})
    const testHost = host({ resume: async () => ({ agent: agent(), dispose }) })
    const control = controller()
    control.activateRecovered.mockResolvedValue({
      kind: 'needs-attention',
      reason: 'Goal revision changed during activation',
    })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toEqual([{
      run: recoveryRunRef(run()),
      outcome: 'needs-attention',
      reason: 'Goal revision changed during activation',
    }])
    expect(dispose).toHaveBeenCalledOnce()
    expect(control.markNeedsAttention).not.toHaveBeenCalled()
    await recovery.dispose()
  })

  it('reports cleanup failure after activation persisted needs-attention', async () => {
    const dispose = vi.fn(async () => { throw new Error('temporary Agent stuck') })
    const testHost = host({ resume: async () => ({ agent: agent(), dispose }) })
    const control = controller()
    control.activateRecovered.mockResolvedValue({
      kind: 'needs-attention',
      reason: 'Goal revision changed during activation',
    })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'failed',
      reason: /Goal revision changed.*temporary Agent stuck/,
    }])
    await recovery.dispose()
  })

  it('fails closed when a superseded cold Agent cannot be released', async () => {
    const dispose = vi.fn(async () => { throw new Error('teardown stuck') })
    const testHost = host({ resume: async () => ({ agent: agent(), dispose }) })
    const control = controller()
    control.activateRecovered.mockResolvedValue({ kind: 'superseded', reason: 'user paused' })
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'needs-attention', reason: /superseded.*cleanup failed: teardown stuck/,
    }])
    expect(control.markNeedsAttention).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it('retains the live-Goal mismatch when temporary Agent cleanup also fails', async () => {
    const dispose = vi.fn(async () => { throw new Error('cleanup rejected') })
    const testHost = host({
      liveGoal: undefined,
      resume: async () => ({ agent: agent(), dispose }),
    })
    const recovery = new AutopilotRecovery(testHost.ctx, controller())

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'needs-attention',
      reason: /no current Goal; recovered Agent cleanup failed: cleanup rejected/,
    }])
    await recovery.dispose()
  })

  it('marks activation failure needs-attention and contains a marker failure', async () => {
    const dispose = vi.fn(async () => {})
    const testHost = host({ resume: async () => ({ agent: agent(), dispose }) })
    const control = controller()
    control.activateRecovered.mockRejectedValue('activation broke')
    control.markNeedsAttention.mockRejectedValue(new Error('sidecar unavailable'))
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'failed',
      reason: /activation broke; could not persist needs-attention: sidecar unavailable/,
    }])
    expect(dispose).toHaveBeenCalledOnce()
    await recovery.dispose()
  })

  it('records both activation and cleanup failures', async () => {
    const dispose = vi.fn(async () => { throw new Error('cleanup also failed') })
    const testHost = host({ resume: async () => ({ agent: agent(), dispose }) })
    const control = controller()
    control.activateRecovered.mockRejectedValue(new Error('activation failed'))
    const recovery = new AutopilotRecovery(testHost.ctx, control)

    expect(await recovery.recover()).toMatchObject([{
      outcome: 'needs-attention',
      reason: /activation failed; recovered Agent cleanup failed: cleanup also failed/,
    }])
    await recovery.dispose()
  })

  it('omits preset setup for a rosterless session', async () => {
    const value = inspection({ meta: rosterlessHeader() })
    const testHost = host({ inspected: value })
    const recovery = new AutopilotRecovery(testHost.ctx, controller())

    expect(await recovery.recover()).toMatchObject([{ outcome: 'recovered' }])
    expect(testHost.resume).toHaveBeenCalledWith({ resumeSessionId: SessionId('session-1') })
    await recovery.dispose()
  })

  it('attempts every owned disposer and reports aggregate cleanup failure', async () => {
    const firstDispose = vi.fn(async () => { throw new Error('first cleanup failed') })
    const secondDispose = vi.fn(async () => {})
    const rows = [run(), run({ runId: 'run-2', sessionId: 'session-2', goalId: 'goal-1' })]
    let calls = 0
    const testHost = host({
      agents: [undefined, undefined, undefined, undefined],
      resume: async () => ({
        agent: agent(calls === 0 ? 'session-1' : 'session-2'),
        dispose: calls++ === 0 ? firstDispose : secondDispose,
      }),
    })
    const recovery = new AutopilotRecovery(testHost.ctx, controller(rows))
    await recovery.recover()

    await expect(recovery.dispose()).rejects.toThrow(AggregateError)
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })
})
