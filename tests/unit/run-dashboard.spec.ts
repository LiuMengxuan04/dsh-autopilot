import { Context } from '@deepseek-ai/cordis'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRunDashboardSnapshot,
  DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
  DEFAULT_RUN_DASHBOARD_ROWS,
  DEFAULT_RUN_DASHBOARD_WIDTH,
  MAX_RUN_DASHBOARD_INTERVAL_MS,
  MAX_RUN_DASHBOARD_ROWS,
  MIN_RUN_DASHBOARD_INTERVAL_MS,
  openRunDashboardStores,
  readRunDashboards,
  renderRunDashboards,
  resolveRunDashboardConfig,
  RunDashboardWatch,
} from '../../src/run-dashboard.ts'
import type {
  OpenRunDashboardStores,
  RunDashboardInput,
  RunDashboardScheduler,
  RunDashboardStores,
} from '../../src/run-dashboard.ts'
import { DELIVERY_STATE_VERSION } from '../../src/delivery-state.ts'
import type { DeliverySnapshot } from '../../src/delivery-state.ts'
import { DurableDeliveryStore } from '../../src/delivery-store.ts'
import {
  prepareNotification,
} from '../../src/notification-state.ts'
import type { NotificationSnapshot } from '../../src/notification-state.ts'
import { DurableNotificationStore } from '../../src/notification-store.ts'
import { RALPH_STATE_VERSION } from '../../src/ralph-state.ts'
import type { RalphSnapshot } from '../../src/ralph-state.ts'
import { DurableRalphStore } from '../../src/ralph-store.ts'
import {
  createRunPlan,
  RUN_STATE_VERSION,
  VERIFICATION_POLICY_VERSION,
} from '../../src/run-state.ts'
import type {
  DynamicExtensionVersion,
  RunSnapshot,
  RunTask,
  RunTaskStatus,
  VerificationRecord,
} from '../../src/run-state.ts'
import { DurableRunStore } from '../../src/run-store.ts'
import {
  acceptTeamStart,
  prepareTeamThread,
} from '../../src/team-state.ts'
import type { TeamThreadSnapshot } from '../../src/team-state.ts'
import { DurableTeamStore } from '../../src/team-store.ts'
import { prepareManagedWorkflow } from '../../src/workflow-state.ts'
import type { ManagedWorkflowSnapshot } from '../../src/workflow-state.ts'
import { DurableManagedWorkflowStore } from '../../src/workflow-store.ts'
import AutopilotRunDashboardService, {
  resolveAutopilotRunDashboardConfig,
} from '../../src/run-dashboard-service.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const budgets = Object.freeze({
  maxVerificationAttempts: 3,
  maxDynamicPackages: 8,
  maxSubagents: 32,
  maxConcurrentSubagents: 4,
  maxTasks: 256,
  maxTaskAttempts: 2_048,
  maxEvidenceItems: 4_096,
  maxSnapshotBytes: 524_288,
  maxAuditRecords: 8_192,
  maxAuditBytes: 268_435_456,
  maxDynamicSourceChars: 262_144,
})

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    version: RUN_STATE_VERSION,
    runId: 'run-1',
    generation: 2,
    revision: 9,
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'running',
    autoResume: true,
    grantedAt: 10,
    updatedAt: 20,
    remainingActiveMs: 3_661_000,
    maxActiveMs: 90_061_000,
    selfModification: 'host-only',
    budgets,
    usage: { verificationAttempts: 1, dynamicPackages: 2, subagentsStarted: 3 },
    dynamicExtensions: [],
    flow: { revision: 1, stage: 'interview', cycle: 1, planReviewAttempts: 0, updatedAt: 20 },
    verificationHistory: [],
    completionReported: false,
    ...overrides,
  }
}

function tasks(): readonly RunTask[] {
  const base = createRunPlan(['all done'], [
    { id: 'a', title: 'Alpha', description: 'A', acceptanceCriteria: ['A'] },
    { id: 'b', title: 'Beta', description: 'B', acceptanceCriteria: ['B'], dependencies: ['a'] },
    { id: 'c', title: 'Gamma', description: 'C', acceptanceCriteria: ['C'] },
    { id: 'd', title: 'Delta', description: 'D', acceptanceCriteria: ['D'] },
    { id: 'e', title: 'Epsilon', description: 'E', acceptanceCriteria: ['E'] },
  ], 10, 'implementation').tasks
  const statuses: readonly RunTaskStatus[] = ['pending', 'in_progress', 'blocked', 'failed', 'completed']
  return base.map((task, index) => ({
    ...task,
    status: statuses[index] ?? 'pending',
    attempts: index,
    evidence: index === 0 ? [] : [{ kind: 'test', ref: `test-${index}`, summary: 'passed' }],
    attemptHistory: index === 0 ? [] : [{
      attempt: index,
      startedAt: 10,
      finishedAt: 11,
      outcome: 'completed',
      evidence: [{ kind: 'file', ref: `file-${index}`, summary: 'changed' }],
    }],
  }))
}

function extensions(): readonly DynamicExtensionVersion[] {
  return (['applying', 'active', 'superseded', 'failed', 'removing', 'removed'] as const)
    .map((status, index) => ({
      logicalId: `extension-${index}`,
      version: 1,
      name: `Extension ${index}`,
      purpose: 'test dashboard status',
      hostCode: 'return {}',
      sourceSha256: String(index).padStart(64, '0'),
      status,
      createdAt: 10,
      updatedAt: 20,
    }))
}

const verification: VerificationRecord = {
  attempt: 1,
  startedAt: 15,
  finishedAt: 20,
  verdict: 'pass',
  summary: 'independent checks passed',
  findings: [],
  checks: [{ name: 'test', passed: true, summary: 'passed' }],
  reviewers: [],
}

function team(taskId: string, started: boolean): TeamThreadSnapshot {
  const prepared = prepareTeamThread({
    parentSessionId: 'session-1',
    runId: 'run-1',
    generation: 2,
    runRevisionAtClaim: 9,
    maxAuditRecords: 100,
    maxAuditBytes: 1_000_000,
    taskId,
    provider: 'spawn',
    label: `autopilot:${taskId}`,
    role: 'implementer',
    promptSha256: 'a'.repeat(64),
  }, 10)
  if (!started) return prepared
  return {
    ...acceptTeamStart(prepared, `child-${taskId}`, `message-${taskId}`, 20),
    report: {
      status: 'completed',
      summary: 'done',
      evidence: [],
      submittedAt: 20,
      messageId: `report-${taskId}`,
      acceptedAt: 20,
    },
  }
}

function ralph(taskId: string, withRound: boolean): RalphSnapshot {
  return {
    version: RALPH_STATE_VERSION,
    parentSessionId: 'session-1',
    runId: 'run-1',
    generation: 2,
    goalId: 'goal-1',
    taskId,
    revision: 1,
    phase: 'running',
    instruction: 'work',
    policySha256: 'b'.repeat(64),
    maxRounds: 8,
    maxHandoffChars: 1_000,
    maxSummaryChars: 1_000,
    maxEvidenceItems: 100,
    reservedThroughRound: withRound ? 1 : 0,
    rounds: withRound ? [{ number: 1, status: 'continue', startedAt: 10, finishedAt: 20, evidence: [] }] : [],
    createdAt: 10,
    updatedAt: 20,
  }
}

function workflow(id: string, agentsStarted?: number): ManagedWorkflowSnapshot {
  return {
    ...prepareManagedWorkflow({
      workflowId: id,
      parentSessionId: 'session-1',
      runId: 'run-1',
      generation: 2,
      goalId: 'goal-1',
      maxAuditRecords: 100,
      maxAuditBytes: 1_000_000,
      profileId: 'fanout',
      profileSha256: 'c'.repeat(64),
      argsSha256: 'd'.repeat(64),
      taskIds: ['a', 'b'],
      maxTotalAgents: 4,
      subagentsStartedBefore: 3,
    }, 10),
    phase: 'running',
    settledTaskIds: ['a'],
    ...(agentsStarted === undefined ? {} : { engineAgentsStarted: agentsStarted }),
  }
}

function notification(failure: boolean): NotificationSnapshot {
  const initial = prepareNotification({
    sessionId: 'session-1',
    runId: 'run-1',
    generation: 2,
    runRevision: 9,
    event: 'completed',
    policySha256: 'e'.repeat(64),
    payload: {
      objectiveSha256: 'f'.repeat(64),
      phase: 'completed',
      reasonCode: 'run-completed',
      usage: { verificationAttempts: 1, dynamicPackages: 2, subagentsStarted: 3 },
    },
    maxAttempts: 3,
    maxPendingNotifications: 100,
    maxAuditRecords: 10,
    maxAuditBytes: 100_000,
  }, 100)
  return failure
    ? {
        ...initial,
        revision: 2,
        phase: 'retry-wait',
        attempts: 1,
        updatedAt: 110,
        nextAttemptAt: 120,
        lastAttemptAt: 110,
        lastFailureCode: 'timeout',
      }
    : initial
}

function delivery(repository: string, overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return {
    version: DELIVERY_STATE_VERSION,
    deliveryId: '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
    parentSessionId: 'session-1',
    parentRunId: 'run-1',
    parentRunGeneration: 2,
    parentGoalId: 'goal-1',
    repository,
    generation: 1,
    revision: 1,
    maxAuditRecords: 16,
    maxAuditBytes: 1_000_000,
    phase: 'active',
    createdAt: 10,
    updatedAt: 20,
    baseBranch: 'main',
    baseHead: 'a'.repeat(40),
    worktreeRoot: '/controlled',
    worktreePath: '/controlled/worktree',
    branch: 'dsh-autopilot/1-delivery',
    head: 'a'.repeat(40),
    dirty: true,
    conflicted: false,
    verifications: [{ verdict: 'pass', summary: 'ok', checks: [], recordedAt: 20 }],
    ...overrides,
  }
}

function richInput(): RunDashboardInput {
  const planTasks = tasks()
  return {
    run: run({
      plan: {
        revision: 3,
        intent: 'implementation',
        acceptanceCriteria: ['all done'],
        tasks: planTasks,
        createdAt: 10,
        updatedAt: 20,
      },
      dynamicExtensions: extensions(),
      verificationPolicy: {
        version: VERIFICATION_POLICY_VERSION,
        frozenAt: 10,
        sha256: '1'.repeat(64),
        minimumEvidenceItems: 1,
        maxOutputChars: 1_000,
        fixedChecks: [],
        autoDiscoverChecks: false,
        projectChecks: [],
        maxProjectChecks: 1,
        projectCheckTimeoutMs: 1_000,
        reviewers: [],
      },
      verificationBaseline: {
        kind: 'reviewer-only',
        frozenAt: 10,
        manifests: [],
        checks: [],
        reason: 'project-check-discovery-disabled',
      },
      candidate: { summary: 'ready', evidence: ['test'], submittedAt: 15 },
      finalization: verification,
      verificationHistory: [verification],
    }),
    goal: {
      id: GoalId('goal-1'),
      revision: 4,
      objective: 'not rendered',
      phase: 'active',
      maxGoalRounds: 256,
      roundsStarted: 7,
      createdAt: 10,
      updatedAt: 20,
      activation: 'armed',
    },
    team: [team('a', true), team('b', false)],
    ralph: [ralph('c', true), ralph('d', false)],
    workflows: [workflow('11111111-1111-4111-8111-111111111111', 2), workflow('22222222-2222-4222-8222-222222222222')],
    notifications: [notification(true), notification(false)],
    deliveries: [delivery('/repo/a'), delivery('/repo/b', { phase: 'cleaned', dirty: false })],
  }
}

describe('run dashboard configuration', () => {
  it('materializes defaults and normalizes a selected session', () => {
    expect(resolveRunDashboardConfig()).toEqual({
      intervalMs: DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
      maxRows: DEFAULT_RUN_DASHBOARD_ROWS,
      width: DEFAULT_RUN_DASHBOARD_WIDTH,
      clearScreen: true,
    })
    expect(resolveRunDashboardConfig({
      sessionId: ' session-1 ',
      intervalMs: MIN_RUN_DASHBOARD_INTERVAL_MS,
      maxRows: MAX_RUN_DASHBOARD_ROWS,
      width: 240,
      clearScreen: false,
    })).toEqual({
      sessionId: 'session-1',
      intervalMs: MIN_RUN_DASHBOARD_INTERVAL_MS,
      maxRows: MAX_RUN_DASHBOARD_ROWS,
      width: 240,
      clearScreen: false,
    })
  })

  it.each([
    [{ sessionId: ' ' }, 'sessionId'],
    [{ sessionId: 'x'.repeat(257) }, 'sessionId'],
    [{ intervalMs: MIN_RUN_DASHBOARD_INTERVAL_MS - 1 }, 'intervalMs'],
    [{ intervalMs: 1.5 }, 'intervalMs'],
    [{ intervalMs: MAX_RUN_DASHBOARD_INTERVAL_MS + 1 }, 'intervalMs'],
    [{ maxRows: 0 }, 'maxRows'],
    [{ maxRows: MAX_RUN_DASHBOARD_ROWS + 1 }, 'maxRows'],
    [{ width: 39 }, 'width'],
    [{ width: 241 }, 'width'],
  ] as const)('rejects invalid configuration %#', (config, field) => {
    expect(() => resolveRunDashboardConfig(config)).toThrow(field)
  })
})

describe('dashboard snapshot and terminal rendering', () => {
  it('summarizes every durable subsystem with exact bounds and a live Goal', () => {
    const snapshot = buildRunDashboardSnapshot(richInput(), 1, 30)
    expect(snapshot).toMatchObject({
      observedAt: 30,
      sessionId: 'session-1',
      runId: 'run-1',
      phase: 'running',
      goal: { source: 'live', phase: 'active', activation: 'armed', roundsStarted: 7 },
      dag: {
        revision: 3,
        intent: 'implementation',
        counts: { pending: 1, in_progress: 1, blocked: 1, failed: 1, completed: 1 },
        omittedTasks: 4,
      },
      verification: {
        attempts: 1,
        maximum: 3,
        candidateSubmitted: true,
        baseline: 'reviewer-only',
        latest: { verdict: 'pass' },
        finalizingVerdict: 'pass',
      },
      budget: {
        dynamicPackages: [2, 8],
        subagents: [3, 32],
        tasks: [5, 256],
        taskAttempts: [4, 2_048],
        evidenceItems: [8, 4_096],
      },
      cleanup: {
        dynamic: { applying: 1, active: 1, superseded: 1, failed: 1, removing: 1, removed: 1 },
        omittedDeliveries: 1,
        completionDeliveryAttempts: 0,
        completionDeliveryExhausted: false,
        completionDeliveryExhaustionNotified: false,
      },
      omittedNotices: 1,
    })
    expect(snapshot.workers).toMatchObject({ omittedTeam: 1, omittedRalph: 1, omittedWorkflows: 1 })
    expect(snapshot.workers.team[0]).toMatchObject({ childSessionId: 'child-a', report: 'completed' })
    expect(snapshot.workers.ralph[0]).toMatchObject({ currentRoundStatus: 'continue' })
    expect(snapshot.workers.workflows[0]).toMatchObject({ agentsStarted: 2 })
    expect(snapshot.notices[0]).toMatchObject({ lastFailureCode: 'timeout' })
    expect(Object.isFrozen(snapshot)).toBe(true)

    const rendered = renderRunDashboards([snapshot], 240)
    expect(rendered).toContain('Goal goal-1 | active/armed | rounds 7/256')
    expect(rendered).toContain('pending=1 active=1 blocked=1 failed=1 done=1')
    expect(rendered).toContain('... 4 more tasks')
    expect(rendered).toContain('Team workers: 2')
    expect(rendered).toContain('Ralph loops: 2')
    expect(rendered).toContain('Workflows: 2')
    expect(rendered).toContain('latest=pass#1')
    expect(rendered).toContain('active=1h 1m 1s/1d 1h 1m')
    expect(rendered).toContain('failure=timeout')
  })

  it('renders an empty run, durable Goal reference, short durations, clipping, and no-run state', () => {
    const snapshot = buildRunDashboardSnapshot({
      run: run({
        updatedAt: Number.MAX_SAFE_INTEGER,
        remainingActiveMs: 61_000,
        maxActiveMs: 61_000,
        completionReported: true,
      }),
      team: [],
      ralph: [],
      workflows: [],
      notifications: [],
      deliveries: [],
    }, undefined, 40)
    expect(snapshot.goal).toEqual({ id: 'goal-1', source: 'durable-reference' })
    expect(snapshot.dag).not.toHaveProperty('revision')
    expect(snapshot.verification).toEqual({ attempts: 1, maximum: 3, candidateSubmitted: false })
    const rendered = renderRunDashboards([snapshot], 40)
    expect(rendered).toContain('durable reference')
    expect(rendered).toContain('completion-notice=reported')
    expect(rendered).toContain('active=1m 1s/1m 1s')
    expect(rendered).toContain('…')
    expect(renderRunDashboards([])).toBe('DSH Autopilot Dashboard\nNo durable runs found.')
    expect(() => buildRunDashboardSnapshot(richInput(), 0)).toThrow('maxRows')
    expect(() => renderRunDashboards([snapshot], 39)).toThrow('width')
  })

  it('renders multiple snapshots with no omitted rows and optional worker fields absent', () => {
    const input = richInput()
    const full = buildRunDashboardSnapshot(input, 10, 50)
    expect(full.dag.omittedTasks).toBe(0)
    expect(full.workers.team[1]).not.toHaveProperty('childSessionId')
    expect(full.workers.ralph[1]).not.toHaveProperty('currentRoundStatus')
    expect(full.workers.workflows[1]).not.toHaveProperty('agentsStarted')
    expect(full.notices[1]).not.toHaveProperty('lastFailureCode')
    const output = renderRunDashboards([full, full], 240)
    expect(output.split('DSH Autopilot Dashboard')).toHaveLength(3)
    expect(output).toContain('deps=-')
    expect(output).toContain('deps=a')
    expect(output).toContain('completion-notice=pending attempts=0')
  })

  it('surfaces exhausted final-report delivery and its Host fallback marker', () => {
    const snapshot = buildRunDashboardSnapshot({
      run: run({
        phase: 'completed',
        completionDeliveryAttempts: 3,
        completionDeliveryExhausted: true,
        completionDeliveryExhaustionNotified: true,
      }),
      team: [],
      ralph: [],
      workflows: [],
      notifications: [],
      deliveries: [],
    })
    expect(renderRunDashboards([snapshot], 240))
      .toContain('completion-notice=exhausted-notified attempts=3')

    const interrupted = buildRunDashboardSnapshot({
      run: run({
        phase: 'completed',
        completionDeliveryAttempts: 3,
        completionDeliveryExhausted: true,
        completionDeliveryExhaustionNotified: false,
      }),
      team: [],
      ralph: [],
      workflows: [],
      notifications: [],
      deliveries: [],
    })
    expect(renderRunDashboards([interrupted], 240))
      .toContain('completion-notice=exhausted-pending attempts=3')
  })
})

function fakeStores(currentRuns: readonly RunSnapshot[]): {
  readonly stores: RunDashboardStores
  readonly close: ReturnType<typeof vi.fn>
} {
  const close = vi.fn(async () => {})
  const deliveries = [
    { snapshot: delivery('/repo/old', { revision: 1 }) },
    { snapshot: delivery('/repo/old', { revision: 2, phase: 'cleaned', dirty: false }) },
    { snapshot: delivery('/repo/other', { parentRunId: 'other' }) },
  ]
  return {
    stores: {
      runs: {
        get: vi.fn(sessionId => currentRuns.find(value => value.sessionId === sessionId)),
        currentRuns: vi.fn(() => currentRuns),
      },
      team: { list: vi.fn(() => [team('a', true)]) },
      ralph: { list: vi.fn(() => [ralph('b', true)]) },
      workflows: { list: vi.fn(() => [workflow('33333333-3333-4333-8333-333333333333')]) },
      notifications: { list: vi.fn(() => [notification(false)]) },
      deliveries: { history: vi.fn(() => deliveries as never) },
      close,
    },
    close,
  }
}

describe('fresh durable dashboard reads', () => {
  it('reads every current run, exact worker generations, latest deliveries, and a matching live Goal', async () => {
    const first = run()
    const second = run({ sessionId: 'session-2', runId: 'run-2', goalId: 'goal-2' })
    const { stores, close } = fakeStores([first, second])
    const liveGoal = richInput().goal
    const ctx = {
      agents: { get: vi.fn(id => String(id) === 'session-1' ? { id } : undefined) },
      goals: { get: vi.fn(() => liveGoal) },
    } as unknown as Context
    const open: OpenRunDashboardStores = vi.fn(async () => stores)
    const snapshots = await readRunDashboards(ctx, { maxRows: 2, observedAt: 77 }, open)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]?.goal.source).toBe('live')
    expect(snapshots[1]?.goal.source).toBe('durable-reference')
    expect(snapshots[0]?.cleanup.deliveries).toEqual([
      expect.objectContaining({ repository: '/repo/old', phase: 'cleaned' }),
    ])
    expect(stores.team.list).toHaveBeenCalledWith({
      parentSessionId: 'session-1', runId: 'run-1', generation: 2,
    })
    expect(stores.workflows.list).toHaveBeenCalledWith(expect.objectContaining({ includeTerminal: true }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('supports one selected or missing session and always closes stores', async () => {
    const { stores, close } = fakeStores([run()])
    const ctx = {
      agents: { get: vi.fn(() => undefined) },
      goals: { get: vi.fn() },
    } as unknown as Context
    const open: OpenRunDashboardStores = async () => stores
    expect(await readRunDashboards(ctx, { sessionId: ' session-1 ' }, open)).toHaveLength(1)
    expect(await readRunDashboards(ctx, { sessionId: 'missing' }, open)).toEqual([])
    expect(close).toHaveBeenCalledTimes(2)
    await expect(readRunDashboards(ctx, { sessionId: ' ' }, open)).rejects.toThrow('sessionId')
    await expect(readRunDashboards(ctx, { maxRows: 0 }, open)).rejects.toThrow('maxRows')
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('closes stores when a read fails', async () => {
    const { stores, close } = fakeStores([run()])
    vi.mocked(stores.team.list).mockImplementation(() => { throw new Error('broken team store') })
    const ctx = {
      agents: { get: vi.fn(() => undefined) },
      goals: { get: vi.fn() },
    } as unknown as Context
    await expect(readRunDashboards(ctx, {}, async () => stores)).rejects.toThrow('broken team store')
    expect(close).toHaveBeenCalledOnce()
  })
})

function openedStore(name: string, failClose = false) {
  return {
    name,
    close: vi.fn(async () => {
      if (failClose) throw new Error(`${name} close failed`)
    }),
  }
}

describe('default durable store opener', () => {
  it('opens all owned domains and closes them once in reverse-safe aggregate cleanup', async () => {
    const values = [
      openedStore('run'), openedStore('team'), openedStore('ralph'),
      openedStore('workflow'), openedStore('notification'), openedStore('delivery'),
    ]
    vi.spyOn(DurableRunStore, 'open').mockResolvedValue(values[0] as never)
    vi.spyOn(DurableTeamStore, 'open').mockResolvedValue(values[1] as never)
    vi.spyOn(DurableRalphStore, 'open').mockResolvedValue(values[2] as never)
    vi.spyOn(DurableManagedWorkflowStore, 'open').mockResolvedValue(values[3] as never)
    vi.spyOn(DurableNotificationStore, 'open').mockResolvedValue(values[4] as never)
    vi.spyOn(DurableDeliveryStore, 'open').mockResolvedValue(values[5] as never)
    const stores = await openRunDashboardStores(new Context())
    expect(stores.runs).toBe(values[0])
    await stores.close()
    await stores.close()
    for (const value of values) expect(value.close).toHaveBeenCalledOnce()
  })

  it('reports close failure after attempting every close', async () => {
    const values = [
      openedStore('run'), openedStore('team'), openedStore('ralph'),
      openedStore('workflow'), openedStore('notification'), openedStore('delivery', true),
    ]
    vi.spyOn(DurableRunStore, 'open').mockResolvedValue(values[0] as never)
    vi.spyOn(DurableTeamStore, 'open').mockResolvedValue(values[1] as never)
    vi.spyOn(DurableRalphStore, 'open').mockResolvedValue(values[2] as never)
    vi.spyOn(DurableManagedWorkflowStore, 'open').mockResolvedValue(values[3] as never)
    vi.spyOn(DurableNotificationStore, 'open').mockResolvedValue(values[4] as never)
    vi.spyOn(DurableDeliveryStore, 'open').mockResolvedValue(values[5] as never)
    const stores = await openRunDashboardStores(new Context())
    await expect(stores.close()).rejects.toThrow('delivery close failed')
    for (const value of values) expect(value.close).toHaveBeenCalledOnce()
  })

  it('closes already-open stores and preserves an open failure', async () => {
    const first = openedStore('run', true)
    vi.spyOn(DurableRunStore, 'open').mockResolvedValue(first as never)
    vi.spyOn(DurableTeamStore, 'open').mockRejectedValue(new Error('team open failed'))
    await expect(openRunDashboardStores(new Context())).rejects.toThrow('team open failed')
    expect(first.close).toHaveBeenCalledOnce()
  })
})

function scheduler(): {
  readonly value: RunDashboardScheduler
  readonly callbacks: Array<() => void>
  readonly stop: ReturnType<typeof vi.fn>
} {
  const callbacks: Array<() => void> = []
  const stop = vi.fn()
  return {
    callbacks,
    stop,
    value: {
      every: vi.fn((_interval, callback) => {
        callbacks.push(callback)
        return stop
      }),
    },
  }
}

describe('terminal watch', () => {
  it('serializes reads, emits forced and changed frames, and stops idempotently', async () => {
    const frames = [buildRunDashboardSnapshot(richInput(), 1, 30)]
    let resolveRead: ((value: readonly ReturnType<typeof buildRunDashboardSnapshot>[]) => void) | undefined
    const pending = new Promise<readonly ReturnType<typeof buildRunDashboardSnapshot>[]>((resolve) => {
      resolveRead = resolve
    })
    const read = vi.fn(() => pending)
    const write = vi.fn()
    const timer = scheduler()
    const watch = new RunDashboardWatch({
      read,
      write,
      scheduler: timer.value,
      intervalMs: 500,
      width: 240,
      clearScreen: true,
    })
    const first = watch.refresh()
    const shared = watch.refresh(false)
    expect(shared).toBe(first)
    resolveRead?.(frames)
    await first
    expect(String(vi.mocked(write).mock.calls[0]?.[0])
      .startsWith('\u001B[2J\u001B[HDSH Autopilot')).toBe(true)

    const stop = watch.start()
    expect(() => watch.start()).toThrow('already started')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    timer.callbacks[0]?.()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    expect(write).toHaveBeenCalledTimes(1)
    stop()
    stop()
    watch.stop()
    expect(timer.stop).toHaveBeenCalledOnce()
  })

  it('reports automatic errors and supports the default Node scheduler without screen clearing', async () => {
    vi.useFakeTimers()
    const error = new Error('read failed')
    const onError = vi.fn()
    const write = vi.fn()
    const read = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue([buildRunDashboardSnapshot(richInput(), 1, 30)])
    const watch = new RunDashboardWatch({
      read,
      write,
      onError,
      intervalMs: MIN_RUN_DASHBOARD_INTERVAL_MS,
      clearScreen: false,
    })
    const stop = watch.start()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error))
    await vi.advanceTimersByTimeAsync(MIN_RUN_DASHBOARD_INTERVAL_MS)
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^DSH Autopilot Dashboard/u))
    stop()
    await vi.advanceTimersByTimeAsync(MIN_RUN_DASHBOARD_INTERVAL_MS)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('propagates manual read failures and uses the default no-op error observer', async () => {
    const automatic = new RunDashboardWatch({
      read: async () => { throw new Error('manual failure') },
      write: vi.fn(),
      scheduler: scheduler().value,
    })
    const stop = automatic.start()
    await Promise.resolve()
    await Promise.resolve()
    stop()
    const watch = new RunDashboardWatch({
      read: async () => { throw new Error('manual failure') },
      write: vi.fn(),
      scheduler: scheduler().value,
    })
    await expect(watch.refresh()).rejects.toThrow('manual failure')
    watch.stop()
  })
})

describe('Cordis Host dashboard service', () => {
  function hostContext(goal = richInput().goal): Context {
    const ctx = new Context()
    Object.defineProperties(ctx, {
      agents: {
        value: { get: vi.fn(id => String(id) === 'session-1' ? { id } : undefined) },
        configurable: true,
      },
      goals: {
        value: { get: vi.fn(() => goal) },
        configurable: true,
      },
    })
    return ctx
  }

  it('validates Host stream configuration without starting a watch', async () => {
    expect(resolveAutopilotRunDashboardConfig()).toEqual({
      intervalMs: DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
      maxRows: DEFAULT_RUN_DASHBOARD_ROWS,
      width: DEFAULT_RUN_DASHBOARD_WIDTH,
      clearScreen: true,
      output: 'stderr',
    })
    expect(resolveAutopilotRunDashboardConfig({ output: 'stdout' }).output).toBe('stdout')
    expect(() => resolveAutopilotRunDashboardConfig({ output: 'invalid' as never })).toThrow('output')

    const ctx = hostContext()
    const opened = fakeStores([run()])
    const openStores = vi.fn(async () => opened.stores)
    const service = new AutopilotRunDashboardService(ctx, {
      sessionId: 'session-1',
      width: 240,
      maxRows: 2,
    }, { openStores, write: vi.fn(), scheduler: scheduler().value })
    expect(openStores).not.toHaveBeenCalled()
    expect(service.config.sessionId).toBe('session-1')
    const snapshots = await service.read({ observedAt: 55 })
    expect(snapshots[0]).toMatchObject({ observedAt: 55, goal: { source: 'live' } })
    expect(await service.render()).toContain('DSH Autopilot Dashboard | session-1')
    expect(await service.render({ sessionId: 'missing', width: 80 })).toBe(
      'DSH Autopilot Dashboard\nNo durable runs found.',
    )
    expect(openStores).toHaveBeenCalledTimes(3)
    await ctx.fiber.dispose()

    const defaultContext = hostContext()
    new AutopilotRunDashboardService(defaultContext)
    await defaultContext.fiber.dispose()
  })

  it('reads through each live service owner without reopening an occupied durable domain', async () => {
    const ctx = hostContext()
    const input = richInput()
    const currentSnapshots = vi.fn(() => [input.run])
    const teamList = vi.fn(() => input.team)
    const ralphList = vi.fn(() => input.ralph)
    const workflowList = vi.fn(() => input.workflows)
    const notificationList = vi.fn(() => input.notifications)
    const deliveryList = vi.fn(() => input.deliveries)
    ctx.provide('autonomy', { currentSnapshots } as never)
    ctx.provide('autopilotTeam', { listRun: teamList } as never)
    ctx.provide('autopilotRalph', { listRun: ralphList } as never)
    ctx.provide('autopilotWorkflows', { listRun: workflowList } as never)
    ctx.provide('autopilotNotifications', { list: notificationList } as never)
    ctx.provide('autopilotDelivery', { list: deliveryList } as never)
    const service = new AutopilotRunDashboardService(ctx)

    const snapshots = await service.read({ sessionId: 'session-1', maxRows: 1, observedAt: 77 })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      observedAt: 77,
      workers: { team: [expect.anything()], ralph: [expect.anything()], workflows: [expect.anything()] },
      cleanup: { deliveries: [expect.anything()] },
      notices: [expect.anything()],
    })
    expect(currentSnapshots).toHaveBeenCalledOnce()
    expect(teamList).toHaveBeenCalledWith('session-1', 'run-1', 2)
    expect(ralphList).toHaveBeenCalledWith('session-1', 'run-1', 2)
    expect(workflowList).toHaveBeenCalledWith('session-1', 'run-1', 2)
    expect(notificationList).toHaveBeenCalledOnce()
    expect(deliveryList).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('falls back to durable run facts when optional live owners and the Agent are absent', async () => {
    const ctx = hostContext()
    Object.defineProperty(ctx, 'agents', {
      value: { get: vi.fn(() => undefined) },
      configurable: true,
    })
    const goalsGet = vi.fn()
    Object.defineProperty(ctx, 'goals', {
      value: { get: goalsGet },
      configurable: true,
    })
    ctx.provide('autonomy', { currentSnapshots: vi.fn(() => [run()]) } as never)
    const now = vi.spyOn(Date, 'now').mockReturnValue(88)
    const service = new AutopilotRunDashboardService(ctx)

    const snapshots = await service.read()

    expect(snapshots).toEqual([
      expect.objectContaining({
        observedAt: 88,
        goal: { id: 'goal-1', source: 'durable-reference' },
        workers: expect.objectContaining({ team: [], ralph: [], workflows: [] }),
        notices: [],
        cleanup: expect.objectContaining({ deliveries: [] }),
      }),
    ])
    expect(goalsGet).not.toHaveBeenCalled()
    now.mockRestore()
    await ctx.fiber.dispose()
  })

  it('starts only an explicit watch, supports overrides, and stops it idempotently', async () => {
    const ctx = hostContext()
    const opened = fakeStores([run()])
    const openStores = vi.fn(async () => opened.stores)
    const defaultWrite = vi.fn()
    const defaultTimer = scheduler()
    const overrideWrite = vi.fn()
    const overrideTimer = scheduler()
    const service = new AutopilotRunDashboardService(ctx, {}, {
      openStores,
      write: defaultWrite,
      scheduler: defaultTimer.value,
    })
    const handle = service.watch({
      sessionId: 'session-1',
      intervalMs: 500,
      maxRows: 1,
      width: 100,
      clearScreen: false,
      write: overrideWrite,
      scheduler: overrideTimer.value,
      onError: vi.fn(),
    })
    await vi.waitFor(() => expect(openStores).toHaveBeenCalledOnce())
    await handle.refresh()
    expect(overrideWrite).toHaveBeenCalledWith(expect.stringMatching(/^DSH Autopilot Dashboard/u))
    expect(defaultWrite).not.toHaveBeenCalled()
    expect(overrideTimer.value.every).toHaveBeenCalledWith(500, expect.any(Function))
    handle.stop()
    handle.stop()
    expect(overrideTimer.stop).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('uses either configured process stream and stops live watches with its Cordis fiber', async () => {
    vi.useFakeTimers()
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const firstContext = hostContext()
    const firstStores = fakeStores([run()])
    const stdoutService = new AutopilotRunDashboardService(firstContext, {
      output: 'stdout', clearScreen: false, intervalMs: MIN_RUN_DASHBOARD_INTERVAL_MS,
    }, { openStores: async () => firstStores.stores })
    const stdoutWatch = stdoutService.watch()
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled())
    stdoutWatch.stop()
    expect(stderr).not.toHaveBeenCalled()
    await firstContext.fiber.dispose()

    const secondContext = hostContext()
    const secondStores = fakeStores([run()])
    const timer = scheduler()
    const stderrService = new AutopilotRunDashboardService(secondContext, {}, {
      openStores: async () => secondStores.stores,
      scheduler: timer.value,
    })
    stderrService.watch()
    await vi.waitFor(() => expect(stderr).toHaveBeenCalled())
    await secondContext.fiber.dispose()
    expect(timer.stop).toHaveBeenCalledOnce()
  })
})
