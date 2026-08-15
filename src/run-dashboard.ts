/** Read-only Host dashboard over durable Autopilot run and worker state. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GoalActivation, GoalPhase, GoalView } from '@deepseek-ai/dsh-goal'
import type { DeliverySnapshot } from './delivery-state.ts'
import { DurableDeliveryStore } from './delivery-store.ts'
import type { NotificationSnapshot } from './notification-state.ts'
import { DurableNotificationStore } from './notification-store.ts'
import type { RalphSnapshot } from './ralph-state.ts'
import { DurableRalphStore } from './ralph-store.ts'
import type {
  RunPhase,
  RunIntent,
  RunSnapshot,
  RunTaskStatus,
  VerificationRecord,
} from './run-state.ts'
import { DurableRunStore } from './run-store.ts'
import type { TeamThreadSnapshot } from './team-state.ts'
import type { TeamTaskReport } from './team-state.ts'
import { DurableTeamStore } from './team-store.ts'
import type { ManagedWorkflowSnapshot } from './workflow-state.ts'
import { DurableManagedWorkflowStore } from './workflow-store.ts'

/** Default refresh interval for a terminal watch. */
export const DEFAULT_RUN_DASHBOARD_INTERVAL_MS = 2_000

/** Lowest useful refresh interval; lower values produce avoidable storage reads. */
export const MIN_RUN_DASHBOARD_INTERVAL_MS = 250

/** Maximum refresh interval accepted by the watch helper. */
export const MAX_RUN_DASHBOARD_INTERVAL_MS = 60_000

/** Default row ceiling for every potentially large dashboard section. */
export const DEFAULT_RUN_DASHBOARD_ROWS = 64

/** Hard row ceiling for one rendered section. */
export const MAX_RUN_DASHBOARD_ROWS = 512

/** Default terminal line width. */
export const DEFAULT_RUN_DASHBOARD_WIDTH = 120

/** Deployment settings for a read-only terminal dashboard. */
export interface RunDashboardConfig {
  /** Optional exact Agent session; omission renders every durable current run. */
  readonly sessionId?: string
  /** Poll interval for {@link RunDashboardWatch}. */
  readonly intervalMs?: number
  /** Maximum rows retained in each variable-length section. */
  readonly maxRows?: number
  /** Maximum width of each rendered line. */
  readonly width?: number
  /** Prefix changed frames with the ANSI clear-screen sequence. */
  readonly clearScreen?: boolean
}

/** Fully validated terminal dashboard settings. */
export interface ResolvedRunDashboardConfig {
  readonly sessionId?: string
  readonly intervalMs: number
  readonly maxRows: number
  readonly width: number
  readonly clearScreen: boolean
}

/** Live Goal fields, or the durable run's exact Goal reference when no Agent is live. */
export interface RunDashboardGoal {
  readonly id: string
  readonly source: 'live' | 'durable-reference'
  readonly revision?: number
  readonly phase?: GoalPhase
  readonly activation?: GoalActivation
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
}

/** Bounded task row in the dependency-graph section. */
export interface RunDashboardTask {
  readonly id: string
  readonly title: string
  readonly status: RunTaskStatus
  readonly dependencies: readonly string[]
  readonly attempts: number
  readonly evidenceItems: number
}

/** Current continuable-team worker row. */
export interface RunDashboardTeamWorker {
  readonly taskId: string
  readonly phase: TeamThreadSnapshot['phase']
  readonly provider: string
  readonly role: string
  readonly messages: number
  readonly childSessionId?: string
  readonly report?: TeamTaskReport['status']
}

/** Current fresh-agent Ralph loop row. */
export interface RunDashboardRalphWorker {
  readonly taskId: string
  readonly phase: RalphSnapshot['phase']
  readonly rounds: number
  readonly maxRounds: number
  readonly currentRoundStatus?: RalphSnapshot['rounds'][number]['status']
}

/** Current managed Workflow row. */
export interface RunDashboardWorkflow {
  readonly workflowId: string
  readonly profileId: string
  readonly phase: ManagedWorkflowSnapshot['phase']
  readonly tasks: number
  readonly settledTasks: number
  readonly agentsStarted?: number
}

/** Current isolated-delivery cleanup row. */
export interface RunDashboardDelivery {
  readonly repository: string
  readonly phase: DeliverySnapshot['phase']
  readonly dirty: boolean
  readonly conflicted: boolean
  readonly verifications: number
}

/** Current completion-notification outbox row. */
export interface RunDashboardNotice {
  readonly notificationId: string
  readonly event: NotificationSnapshot['event']
  readonly phase: NotificationSnapshot['phase']
  readonly attempts: number
  readonly maxAttempts: number
  readonly lastFailureCode?: NotificationSnapshot['lastFailureCode']
}

/** Counts for all durable DAG statuses, including zeroes. */
export type RunDashboardTaskCounts = Readonly<Record<RunTaskStatus, number>>

/** Counts for retained dynamic-package cleanup states. */
export interface RunDashboardDynamicCleanup {
  readonly applying: number
  readonly active: number
  readonly superseded: number
  readonly failed: number
  readonly removing: number
  readonly removed: number
}

/** One immutable read cut of an exact durable Autopilot generation. */
export interface RunDashboardSnapshot {
  readonly observedAt: number
  readonly sessionId: string
  readonly runId: string
  readonly generation: number
  readonly revision: number
  readonly phase: RunPhase
  readonly updatedAt: number
  readonly goal: RunDashboardGoal
  readonly dag: {
    readonly revision?: number
    readonly intent?: RunIntent
    readonly counts: RunDashboardTaskCounts
    readonly tasks: readonly RunDashboardTask[]
    readonly omittedTasks: number
  }
  readonly workers: {
    readonly team: readonly RunDashboardTeamWorker[]
    readonly omittedTeam: number
    readonly ralph: readonly RunDashboardRalphWorker[]
    readonly omittedRalph: number
    readonly workflows: readonly RunDashboardWorkflow[]
    readonly omittedWorkflows: number
  }
  readonly verification: {
    readonly attempts: number
    readonly maximum: number
    readonly candidateSubmitted: boolean
    readonly baseline?: NonNullable<RunSnapshot['verificationBaseline']>['kind']
    readonly latest?: Pick<VerificationRecord, 'attempt' | 'verdict' | 'summary' | 'finishedAt'>
    readonly finalizingVerdict?: VerificationRecord['verdict']
  }
  readonly budget: {
    readonly remainingActiveMs: number
    readonly maxActiveMs: number
    readonly dynamicPackages: readonly [used: number, maximum: number]
    readonly subagents: readonly [used: number, maximum: number]
    readonly maxConcurrentSubagents: number
    readonly tasks: readonly [used: number, maximum: number]
    readonly taskAttempts: readonly [used: number, maximum: number]
    readonly evidenceItems: readonly [used: number, maximum: number]
  }
  readonly cleanup: {
    readonly dynamic: RunDashboardDynamicCleanup
    readonly deliveries: readonly RunDashboardDelivery[]
    readonly omittedDeliveries: number
    readonly completionReported: boolean
    readonly completionDeliveryAttempts: number
    readonly completionDeliveryExhausted: boolean
    readonly completionDeliveryExhaustionNotified: boolean
  }
  readonly notices: readonly RunDashboardNotice[]
  readonly omittedNotices: number
}

/** Exact state sets used to construct one dashboard snapshot. */
export interface RunDashboardInput {
  readonly run: RunSnapshot
  readonly goal?: GoalView
  readonly team: readonly TeamThreadSnapshot[]
  readonly ralph: readonly RalphSnapshot[]
  readonly workflows: readonly ManagedWorkflowSnapshot[]
  readonly notifications: readonly NotificationSnapshot[]
  readonly deliveries: readonly DeliverySnapshot[]
}

/** Read-only store faces needed by the dashboard collector. */
export interface RunDashboardStores {
  readonly runs: Pick<DurableRunStore, 'get' | 'currentRuns'>
  readonly team: Pick<DurableTeamStore, 'list'>
  readonly ralph: Pick<DurableRalphStore, 'list'>
  readonly workflows: Pick<DurableManagedWorkflowStore, 'list'>
  readonly notifications: Pick<DurableNotificationStore, 'list'>
  readonly deliveries: Pick<DurableDeliveryStore, 'history'>
  close(): Promise<void>
}

/** Factory used to take a fresh durable read on every refresh. */
export type OpenRunDashboardStores = (ctx: Context) => Promise<RunDashboardStores>

/** Read request independent from terminal presentation. */
export interface ReadRunDashboardRequest {
  readonly sessionId?: string
  readonly maxRows?: number
  readonly observedAt?: number
}

/** Timer seam used by the terminal watcher. */
export interface RunDashboardScheduler {
  every(intervalMs: number, callback: () => void): () => void
}

/** Dependencies for a terminal watch without granting any mutation surface. */
export interface RunDashboardWatchOptions {
  readonly read: () => Promise<readonly RunDashboardSnapshot[]>
  readonly write: (frame: string) => void
  readonly intervalMs?: number
  readonly width?: number
  readonly clearScreen?: boolean
  readonly scheduler?: RunDashboardScheduler
  readonly onError?: (error: unknown) => void
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be a safe integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

/** Validate and materialize a read-only terminal dashboard configuration. */
export function resolveRunDashboardConfig(config: RunDashboardConfig = {}): ResolvedRunDashboardConfig {
  const sessionId = config.sessionId?.trim()
  if (sessionId !== undefined && (sessionId.length === 0 || sessionId.length > 256)) {
    throw new Error('sessionId must contain 1-256 characters')
  }
  return Object.freeze({
    ...(sessionId === undefined ? {} : { sessionId }),
    intervalMs: configuredInteger(
      config.intervalMs,
      DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
      'intervalMs',
      MIN_RUN_DASHBOARD_INTERVAL_MS,
      MAX_RUN_DASHBOARD_INTERVAL_MS,
    ),
    maxRows: configuredInteger(
      config.maxRows,
      DEFAULT_RUN_DASHBOARD_ROWS,
      'maxRows',
      1,
      MAX_RUN_DASHBOARD_ROWS,
    ),
    width: configuredInteger(config.width, DEFAULT_RUN_DASHBOARD_WIDTH, 'width', 40, 240),
    clearScreen: config.clearScreen ?? true,
  })
}

async function closeStores(
  stores: readonly { close(): Promise<void> }[],
  reportFailure: boolean,
): Promise<void> {
  const results = await Promise.allSettled([...stores].reverse().map(store => store.close()))
  if (!reportFailure) return
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/**
 * Open each Autopilot-owned durable domain for one fresh read.
 *
 * The returned aggregate deliberately exposes no mutation method. Opening on
 * every refresh avoids a second long-lived cache that could lag the services
 * writing the same domains.
 */
export async function openRunDashboardStores(ctx: Context): Promise<RunDashboardStores> {
  const opened: Array<{ close(): Promise<void> }> = []
  try {
    const runs = await DurableRunStore.open(ctx)
    opened.push(runs)
    const team = await DurableTeamStore.open(ctx)
    opened.push(team)
    const ralph = await DurableRalphStore.open(ctx)
    opened.push(ralph)
    const workflows = await DurableManagedWorkflowStore.open(ctx)
    opened.push(workflows)
    const notifications = await DurableNotificationStore.open(ctx)
    opened.push(notifications)
    const deliveries = await DurableDeliveryStore.open(ctx)
    opened.push(deliveries)
    let closed = false
    return Object.freeze({
      runs,
      team,
      ralph,
      workflows,
      notifications,
      deliveries,
      async close() {
        if (closed) return
        closed = true
        await closeStores(opened, true)
      },
    })
  } catch (error: unknown) {
    await closeStores(opened, false)
    throw error
  }
}

function statusCounts(tasks: readonly RunDashboardTask[]): RunDashboardTaskCounts {
  const counts: Record<RunTaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
  }
  for (const task of tasks) counts[task.status] += 1
  return Object.freeze(counts)
}

function dynamicCounts(run: RunSnapshot): RunDashboardDynamicCleanup {
  const counts = { applying: 0, active: 0, superseded: 0, failed: 0, removing: 0, removed: 0 }
  for (const extension of run.dynamicExtensions) counts[extension.status] += 1
  return Object.freeze(counts)
}

function bounded<T>(values: readonly T[], maximum: number): {
  readonly values: readonly T[]
  readonly omitted: number
} {
  return Object.freeze({
    values: Object.freeze(values.slice(0, maximum)),
    omitted: Math.max(0, values.length - maximum),
  })
}

function goalView(run: RunSnapshot, goal: GoalView | undefined): RunDashboardGoal {
  if (goal === undefined || String(goal.id) !== run.goalId) {
    return Object.freeze({ id: run.goalId, source: 'durable-reference' })
  }
  return Object.freeze({
    id: String(goal.id),
    source: 'live',
    revision: goal.revision,
    phase: goal.phase,
    activation: goal.activation,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
  })
}

function taskRows(run: RunSnapshot): readonly RunDashboardTask[] {
  return Object.freeze((run.plan?.tasks ?? []).map(task => Object.freeze({
    id: task.id,
    title: task.title,
    status: task.status,
    dependencies: Object.freeze([...task.dependencies]),
    attempts: task.attempts,
    evidenceItems: task.evidence.length,
  })))
}

function teamRows(values: readonly TeamThreadSnapshot[]): readonly RunDashboardTeamWorker[] {
  return Object.freeze(values.map(value => Object.freeze({
    taskId: value.taskId,
    phase: value.phase,
    provider: value.provider,
    role: value.role,
    messages: value.messages.length,
    ...(value.childSessionId === undefined ? {} : { childSessionId: value.childSessionId }),
    ...(value.report === undefined ? {} : { report: value.report.status }),
  })))
}

function ralphRows(values: readonly RalphSnapshot[]): readonly RunDashboardRalphWorker[] {
  return Object.freeze(values.map(value => {
    const current = value.rounds.at(-1)
    return Object.freeze({
      taskId: value.taskId,
      phase: value.phase,
      rounds: value.rounds.length,
      maxRounds: value.maxRounds,
      ...(current === undefined ? {} : { currentRoundStatus: current.status }),
    })
  }))
}

function workflowRows(values: readonly ManagedWorkflowSnapshot[]): readonly RunDashboardWorkflow[] {
  return Object.freeze(values.map(value => Object.freeze({
    workflowId: value.workflowId,
    profileId: value.profileId,
    phase: value.phase,
    tasks: value.taskIds.length,
    settledTasks: value.settledTaskIds.length,
    ...(value.engineAgentsStarted === undefined ? {} : { agentsStarted: value.engineAgentsStarted }),
  })))
}

function deliveryRows(values: readonly DeliverySnapshot[]): readonly RunDashboardDelivery[] {
  return Object.freeze(values.map(value => Object.freeze({
    repository: value.repository,
    phase: value.phase,
    dirty: value.dirty,
    conflicted: value.conflicted,
    verifications: value.verifications.length,
  })))
}

function noticeRows(values: readonly NotificationSnapshot[]): readonly RunDashboardNotice[] {
  return Object.freeze(values.map(value => Object.freeze({
    notificationId: value.notificationId,
    event: value.event,
    phase: value.phase,
    attempts: value.attempts,
    maxAttempts: value.maxAttempts,
    ...(value.lastFailureCode === undefined ? {} : { lastFailureCode: value.lastFailureCode }),
  })))
}

/** Build a bounded, secret-free dashboard value from exact durable snapshots. */
export function buildRunDashboardSnapshot(
  input: RunDashboardInput,
  maxRows = DEFAULT_RUN_DASHBOARD_ROWS,
  observedAt = Date.now(),
): RunDashboardSnapshot {
  const rowLimit = configuredInteger(maxRows, DEFAULT_RUN_DASHBOARD_ROWS, 'maxRows', 1, MAX_RUN_DASHBOARD_ROWS)
  const tasks = taskRows(input.run)
  const shownTasks = bounded(tasks, rowLimit)
  const shownTeam = bounded(teamRows(input.team), rowLimit)
  const shownRalph = bounded(ralphRows(input.ralph), rowLimit)
  const shownWorkflows = bounded(workflowRows(input.workflows), rowLimit)
  const shownDeliveries = bounded(deliveryRows(input.deliveries), rowLimit)
  const shownNotices = bounded(noticeRows(input.notifications), rowLimit)
  const taskAttempts = input.run.plan?.tasks.reduce(
    (total, task) => total + task.attemptHistory.length,
    0,
  ) ?? 0
  const evidenceItems = input.run.plan?.tasks.reduce(
    (total, task) => total + task.evidence.length
      + task.attemptHistory.reduce((attemptTotal, attempt) => attemptTotal + attempt.evidence.length, 0),
    0,
  ) ?? 0
  const latest = input.run.verificationHistory.at(-1)
  return Object.freeze({
    observedAt,
    sessionId: input.run.sessionId,
    runId: input.run.runId,
    generation: input.run.generation,
    revision: input.run.revision,
    phase: input.run.phase,
    updatedAt: input.run.updatedAt,
    goal: goalView(input.run, input.goal),
    dag: Object.freeze({
      ...(input.run.plan === undefined ? {} : {
        revision: input.run.plan.revision,
        intent: input.run.plan.intent,
      }),
      counts: statusCounts(tasks),
      tasks: shownTasks.values,
      omittedTasks: shownTasks.omitted,
    }),
    workers: Object.freeze({
      team: shownTeam.values,
      omittedTeam: shownTeam.omitted,
      ralph: shownRalph.values,
      omittedRalph: shownRalph.omitted,
      workflows: shownWorkflows.values,
      omittedWorkflows: shownWorkflows.omitted,
    }),
    verification: Object.freeze({
      attempts: input.run.usage.verificationAttempts,
      maximum: input.run.budgets.maxVerificationAttempts,
      candidateSubmitted: input.run.candidate !== undefined,
      ...(input.run.verificationBaseline === undefined
        ? {}
        : { baseline: input.run.verificationBaseline.kind }),
      ...(latest === undefined ? {} : {
        latest: Object.freeze({
          attempt: latest.attempt,
          verdict: latest.verdict,
          summary: latest.summary,
          finishedAt: latest.finishedAt,
        }),
      }),
      ...(input.run.finalization === undefined
        ? {}
        : { finalizingVerdict: input.run.finalization.verdict }),
    }),
    budget: Object.freeze({
      remainingActiveMs: input.run.remainingActiveMs,
      maxActiveMs: input.run.maxActiveMs,
      dynamicPackages: Object.freeze([
        input.run.usage.dynamicPackages,
        input.run.budgets.maxDynamicPackages,
      ] as const),
      subagents: Object.freeze([
        input.run.usage.subagentsStarted,
        input.run.budgets.maxSubagents,
      ] as const),
      maxConcurrentSubagents: input.run.budgets.maxConcurrentSubagents,
      tasks: Object.freeze([tasks.length, input.run.budgets.maxTasks] as const),
      taskAttempts: Object.freeze([taskAttempts, input.run.budgets.maxTaskAttempts] as const),
      evidenceItems: Object.freeze([evidenceItems, input.run.budgets.maxEvidenceItems] as const),
    }),
    cleanup: Object.freeze({
      dynamic: dynamicCounts(input.run),
      deliveries: shownDeliveries.values,
      omittedDeliveries: shownDeliveries.omitted,
      completionReported: input.run.completionReported,
      completionDeliveryAttempts: input.run.completionDeliveryAttempts ?? 0,
      completionDeliveryExhausted: input.run.completionDeliveryExhausted ?? false,
      completionDeliveryExhaustionNotified: input.run.completionDeliveryExhaustionNotified ?? false,
    }),
    notices: shownNotices.values,
    omittedNotices: shownNotices.omitted,
  })
}

function currentDeliveries(records: ReturnType<RunDashboardStores['deliveries']['history']>): readonly DeliverySnapshot[] {
  const current = new Map<string, DeliverySnapshot>()
  for (const record of records) current.set(record.snapshot.repository, record.snapshot)
  return Object.freeze([...current.values()].sort((left, right) => left.repository.localeCompare(right.repository)))
}

function liveGoal(ctx: Context, run: RunSnapshot): GoalView | undefined {
  const agent = ctx.agents.get(SessionId(run.sessionId))
  return agent === undefined ? undefined : ctx.goals.get(agent)
}

/**
 * Take a fresh read across every Autopilot-owned durable domain.
 *
 * This function never calls a store mutation method and filters every worker,
 * delivery, and notice by the exact run id and generation read first.
 */
export async function readRunDashboards(
  ctx: Context,
  request: ReadRunDashboardRequest = {},
  openStores: OpenRunDashboardStores = openRunDashboardStores,
): Promise<readonly RunDashboardSnapshot[]> {
  const sessionId = request.sessionId?.trim()
  if (sessionId !== undefined && sessionId.length === 0) throw new Error('sessionId must not be empty')
  const rowLimit = configuredInteger(
    request.maxRows,
    DEFAULT_RUN_DASHBOARD_ROWS,
    'maxRows',
    1,
    MAX_RUN_DASHBOARD_ROWS,
  )
  const observedAt = request.observedAt ?? Date.now()
  const stores = await openStores(ctx)
  try {
    const runs = sessionId === undefined
      ? stores.runs.currentRuns()
      : [stores.runs.get(sessionId)].filter((run): run is RunSnapshot => run !== undefined)
    const deliveries = currentDeliveries(stores.deliveries.history())
    return Object.freeze(runs.map((run) => {
      const goal = liveGoal(ctx, run)
      return buildRunDashboardSnapshot({
      run,
      ...(goal === undefined ? {} : { goal }),
      team: stores.team.list({
        parentSessionId: run.sessionId,
        runId: run.runId,
        generation: run.generation,
      }),
      ralph: stores.ralph.list({
        parentSessionId: run.sessionId,
        runId: run.runId,
        generation: run.generation,
      }),
      workflows: stores.workflows.list({
        parentSessionId: run.sessionId,
        runId: run.runId,
        generation: run.generation,
        includeTerminal: true,
      }),
      notifications: stores.notifications.list({
        sessionId: run.sessionId,
        runId: run.runId,
        generation: run.generation,
      }),
      deliveries: deliveries.filter(delivery => delivery.parentSessionId === run.sessionId
        && delivery.parentRunId === run.runId
        && delivery.parentRunGeneration === run.generation),
      }, rowLimit, observedAt)
    }))
  } finally {
    await stores.close()
  }
}

function clipped(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

function timestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function duration(value: number): string {
  const seconds = Math.floor(value / 1_000)
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return days > 0
    ? `${days}d ${hours}h ${minutes}m`
    : hours > 0
      ? `${hours}h ${minutes}m ${remainder}s`
      : `${minutes}m ${remainder}s`
}

function pushRows<T>(
  lines: string[],
  heading: string,
  values: readonly T[],
  omitted: number,
  render: (value: T) => string,
): void {
  lines.push(`${heading}: ${values.length + omitted}`)
  for (const value of values) lines.push(`  ${render(value)}`)
  if (omitted > 0) lines.push(`  ... ${omitted} more`)
}

/** Render one or more snapshots as a stable, ANSI-free terminal frame. */
export function renderRunDashboards(
  snapshots: readonly RunDashboardSnapshot[],
  width = DEFAULT_RUN_DASHBOARD_WIDTH,
): string {
  const lineWidth = configuredInteger(width, DEFAULT_RUN_DASHBOARD_WIDTH, 'width', 40, 240)
  if (snapshots.length === 0) return 'DSH Autopilot Dashboard\nNo durable runs found.'
  const frames = snapshots.map((snapshot) => {
    const lines: string[] = [
      `DSH Autopilot Dashboard | ${snapshot.sessionId}`,
      `Run ${snapshot.runId} g${snapshot.generation} r${snapshot.revision} | ${snapshot.phase} | updated ${timestamp(snapshot.updatedAt)}`,
      snapshot.goal.source === 'live'
        ? `Goal ${snapshot.goal.id} | ${String(snapshot.goal.phase)}/${String(snapshot.goal.activation)} | rounds ${String(snapshot.goal.roundsStarted)}/${String(snapshot.goal.maxGoalRounds)}`
        : `Goal ${snapshot.goal.id} | durable reference (Agent not live)`,
    ]
    const counts = snapshot.dag.counts
    lines.push(
      `DAG${snapshot.dag.revision === undefined ? '' : ` r${snapshot.dag.revision}`}`
      + `${snapshot.dag.intent === undefined ? '' : ` ${snapshot.dag.intent}`}`
      + ` | pending=${counts.pending} active=${counts.in_progress} blocked=${counts.blocked}`
      + ` failed=${counts.failed} done=${counts.completed}`,
    )
    for (const task of snapshot.dag.tasks) {
      const deps = task.dependencies.length === 0 ? '-' : task.dependencies.join(',')
      lines.push(`  [${task.status}] ${task.id}: ${task.title} | deps=${deps} attempts=${task.attempts} evidence=${task.evidenceItems}`)
    }
    if (snapshot.dag.omittedTasks > 0) lines.push(`  ... ${snapshot.dag.omittedTasks} more tasks`)
    pushRows(lines, 'Team workers', snapshot.workers.team, snapshot.workers.omittedTeam, worker =>
      `[${worker.phase}] ${worker.taskId} ${worker.provider}/${worker.role} messages=${worker.messages}`)
    pushRows(lines, 'Ralph loops', snapshot.workers.ralph, snapshot.workers.omittedRalph, worker =>
      `[${worker.phase}] ${worker.taskId} rounds=${worker.rounds}/${worker.maxRounds}`
      + `${worker.currentRoundStatus === undefined ? '' : ` current=${worker.currentRoundStatus}`}`)
    pushRows(lines, 'Workflows', snapshot.workers.workflows, snapshot.workers.omittedWorkflows, workflow =>
      `[${workflow.phase}] ${workflow.workflowId} profile=${workflow.profileId}`
      + ` tasks=${workflow.settledTasks}/${workflow.tasks}`
      + `${workflow.agentsStarted === undefined ? '' : ` agents=${workflow.agentsStarted}`}`)
    const verification = snapshot.verification
    lines.push(
      `Verification: ${verification.attempts}/${verification.maximum}`
      + ` | candidate=${verification.candidateSubmitted ? 'yes' : 'no'}`
      + `${verification.baseline === undefined ? '' : ` | baseline=${verification.baseline}`}`
      + `${verification.latest === undefined ? '' : ` | latest=${verification.latest.verdict}#${verification.latest.attempt}`}`,
    )
    const budget = snapshot.budget
    lines.push(
      `Budget: active=${duration(budget.remainingActiveMs)}/${duration(budget.maxActiveMs)}`
      + ` dynamic=${budget.dynamicPackages[0]}/${budget.dynamicPackages[1]}`
      + ` subagents=${budget.subagents[0]}/${budget.subagents[1]}`
      + ` concurrent=${budget.maxConcurrentSubagents}`,
      `        tasks=${budget.tasks[0]}/${budget.tasks[1]}`
      + ` attempts=${budget.taskAttempts[0]}/${budget.taskAttempts[1]}`
      + ` evidence=${budget.evidenceItems[0]}/${budget.evidenceItems[1]}`,
    )
    const dynamic = snapshot.cleanup.dynamic
    lines.push(
      `Cleanup: dynamic applying=${dynamic.applying} active=${dynamic.active}`
      + ` superseded=${dynamic.superseded} failed=${dynamic.failed}`
      + ` removing=${dynamic.removing} removed=${dynamic.removed}`,
      `         completion-notice=${snapshot.cleanup.completionReported
        ? 'reported'
        : snapshot.cleanup.completionDeliveryExhausted
          ? snapshot.cleanup.completionDeliveryExhaustionNotified ? 'exhausted-notified' : 'exhausted-pending'
          : 'pending'}`
      + ` attempts=${snapshot.cleanup.completionDeliveryAttempts}`,
    )
    pushRows(lines, 'Deliveries', snapshot.cleanup.deliveries, snapshot.cleanup.omittedDeliveries, delivery =>
      `[${delivery.phase}] ${delivery.repository} dirty=${String(delivery.dirty)}`
      + ` conflicted=${String(delivery.conflicted)} checks=${delivery.verifications}`)
    pushRows(lines, 'Notices', snapshot.notices, snapshot.omittedNotices, notice =>
      `[${notice.phase}] ${notice.event} attempts=${notice.attempts}/${notice.maxAttempts}`
      + `${notice.lastFailureCode === undefined ? '' : ` failure=${notice.lastFailureCode}`}`)
    return lines.map(line => clipped(line, lineWidth)).join('\n')
  })
  return frames.join('\n\n')
}

const nodeScheduler: RunDashboardScheduler = Object.freeze({
  every(intervalMs: number, callback: () => void) {
    const timer = setInterval(callback, intervalMs)
    return () => clearInterval(timer)
  },
})

/** Serialized read-only polling loop for a Host terminal. */
export class RunDashboardWatch {
  private readonly intervalMs: number
  private readonly width: number
  private readonly clearScreen: boolean
  private readonly scheduler: RunDashboardScheduler
  private readonly read: RunDashboardWatchOptions['read']
  private readonly write: RunDashboardWatchOptions['write']
  private readonly onError: NonNullable<RunDashboardWatchOptions['onError']>
  private stopTimer: (() => void) | undefined
  private inFlight: Promise<readonly RunDashboardSnapshot[]> | undefined
  private lastFrame: string | undefined

  /** @param options - Read function, terminal sink, scheduler, and bounded presentation policy. */
  constructor(options: RunDashboardWatchOptions) {
    this.intervalMs = configuredInteger(
      options.intervalMs,
      DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
      'intervalMs',
      MIN_RUN_DASHBOARD_INTERVAL_MS,
      MAX_RUN_DASHBOARD_INTERVAL_MS,
    )
    this.width = configuredInteger(options.width, DEFAULT_RUN_DASHBOARD_WIDTH, 'width', 40, 240)
    this.clearScreen = options.clearScreen ?? true
    this.scheduler = options.scheduler ?? nodeScheduler
    this.read = options.read
    this.write = options.write
    this.onError = options.onError ?? (() => {})
  }

  /** Read and emit one frame; concurrent calls share the same durable read. */
  refresh(force = true): Promise<readonly RunDashboardSnapshot[]> {
    if (this.inFlight !== undefined) return this.inFlight
    const task = this.read().then((snapshots) => {
      const frame = renderRunDashboards(snapshots, this.width)
      if (force || frame !== this.lastFrame) {
        this.write(`${this.clearScreen ? '\u001B[2J\u001B[H' : ''}${frame}\n`)
      }
      this.lastFrame = frame
      return snapshots
    })
    this.inFlight = task
    void task.finally(() => {
      this.inFlight = undefined
    }).catch(() => {})
    return task
  }

  /** Start immediate and interval refreshes; the returned disposer is idempotent. */
  start(): () => void {
    if (this.stopTimer !== undefined) throw new Error('run dashboard watch is already started')
    const tick = () => {
      void this.refresh(false).catch(this.onError)
    }
    tick()
    this.stopTimer = this.scheduler.every(this.intervalMs, tick)
    return () => this.stop()
  }

  /** Stop future reads without cancelling an already-running read. */
  stop(): void {
    const stopTimer = this.stopTimer
    if (stopTimer === undefined) return
    this.stopTimer = undefined
    stopTimer()
  }
}
