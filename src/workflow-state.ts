/** Durable intent, execution, settlement, and recovery state for managed workflows. */
import { z } from 'zod'

/** Current managed-workflow storage format. */
export const WORKFLOW_STATE_VERSION = 1 as const

/** Deployment profile identifiers accepted from model tools. */
export const WORKFLOW_PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

/** Durable lifecycle for one workflow attempt. */
export type ManagedWorkflowPhase =
  | 'prepared'
  | 'claimed'
  | 'running'
  | 'settling'
  | 'cancelling'
  | 'completed'
  | 'partial-failure'
  | 'cancelled'
  | 'error'
  | 'uncertain'

/** Terminal workflow phase selected before task-by-task DAG settlement. */
export type ManagedWorkflowTerminalPhase = 'completed' | 'partial-failure' | 'cancelled' | 'error'

/** One deployment-profile result mapped to an exact claimed DAG task. */
export interface ManagedWorkflowTaskOutcome {
  readonly taskId: string
  readonly status: 'completed' | 'blocked' | 'failed'
  readonly summary: string
  readonly evidence: readonly {
    readonly kind: 'file' | 'command' | 'test' | 'url' | 'note' | 'subagent'
    readonly ref: string
    readonly summary: string
  }[]
}

/** Complete durable snapshot for one workflow intent. */
export interface ManagedWorkflowSnapshot {
  readonly version: typeof WORKFLOW_STATE_VERSION
  readonly workflowId: string
  readonly parentSessionId: string
  readonly runId: string
  readonly generation: number
  readonly goalId: string
  readonly revision: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly profileId: string
  readonly profileSha256: string
  readonly argsSha256: string
  readonly taskIds: readonly string[]
  readonly maxTotalAgents: number
  readonly subagentsStartedBefore: number
  readonly phase: ManagedWorkflowPhase
  readonly createdAt: number
  readonly updatedAt: number
  readonly claimedRunRevision?: number | undefined
  readonly engineRunId?: string | undefined
  readonly engineStopReason?: 'completed' | 'cancelled' | 'error' | undefined
  readonly engineAgentsStarted?: number | undefined
  readonly targetPhase?: ManagedWorkflowTerminalPhase | undefined
  readonly outcomes: readonly ManagedWorkflowTaskOutcome[]
  readonly settledTaskIds: readonly string[]
  readonly reason?: string | undefined
}

/** Immutable whole-snapshot mutation categories. */
export type ManagedWorkflowOperation =
  | 'prepare'
  | 'claim'
  | 'start'
  | 'settle'
  | 'task-applied'
  | 'cancel-request'
  | 'finish'
  | 'uncertain'

/** One append-only managed-workflow audit row. */
export interface ManagedWorkflowAuditRecord {
  readonly version: typeof WORKFLOW_STATE_VERSION
  readonly operation: ManagedWorkflowOperation
  readonly time: number
  readonly snapshot: ManagedWorkflowSnapshot
}

/** Stable state-machine failure. */
export class ManagedWorkflowStateError extends Error {
  /** Machine-routable failure category. */
  readonly code = 'AUTOPILOT_WORKFLOW_STATE_INVALID' as const

  /** @param message - Exact failed state invariant. */
  constructor(message: string) {
    super(message)
    this.name = 'ManagedWorkflowStateError'
  }
}

const nonEmpty = (maximum: number) => z.string().trim().min(1).max(maximum)
const safeTime = z.number().int().nonnegative()
const positiveInteger = z.number().int().positive()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const taskId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)

const evidenceSchema = z.object({
  kind: z.enum(['file', 'command', 'test', 'url', 'note', 'subagent']),
  ref: nonEmpty(4_096),
  summary: nonEmpty(4_096),
}).strict()

/** Runtime validation for one profile-produced task outcome. */
export const managedWorkflowTaskOutcomeSchema: z.ZodType<ManagedWorkflowTaskOutcome> = z.object({
  taskId,
  status: z.enum(['completed', 'blocked', 'failed']),
  summary: nonEmpty(8_192),
  evidence: z.array(evidenceSchema).max(128),
}).strict().superRefine((outcome, context) => {
  if (outcome.status === 'completed' && outcome.evidence.length === 0) {
    context.addIssue({ code: 'custom', message: 'completed workflow tasks require evidence' })
  }
})

/** Runtime validation for a complete managed-workflow snapshot. */
export const managedWorkflowSnapshotSchema: z.ZodType<ManagedWorkflowSnapshot> = z.object({
  version: z.literal(WORKFLOW_STATE_VERSION),
  workflowId: z.string().uuid(),
  parentSessionId: nonEmpty(4_096),
  runId: nonEmpty(4_096),
  generation: positiveInteger,
  goalId: nonEmpty(4_096),
  revision: positiveInteger,
  maxAuditRecords: positiveInteger,
  maxAuditBytes: positiveInteger,
  profileId: z.string().regex(WORKFLOW_PROFILE_ID_PATTERN),
  profileSha256: sha256,
  argsSha256: sha256,
  taskIds: z.array(taskId).min(1).max(256),
  maxTotalAgents: positiveInteger,
  subagentsStartedBefore: z.number().int().nonnegative(),
  phase: z.enum([
    'prepared',
    'claimed',
    'running',
    'settling',
    'cancelling',
    'completed',
    'partial-failure',
    'cancelled',
    'error',
    'uncertain',
  ]),
  createdAt: safeTime,
  updatedAt: safeTime,
  claimedRunRevision: positiveInteger.optional(),
  engineRunId: nonEmpty(4_096).optional(),
  engineStopReason: z.enum(['completed', 'cancelled', 'error']).optional(),
  engineAgentsStarted: z.number().int().nonnegative().optional(),
  targetPhase: z.enum(['completed', 'partial-failure', 'cancelled', 'error']).optional(),
  outcomes: z.array(managedWorkflowTaskOutcomeSchema).max(256),
  settledTaskIds: z.array(taskId).max(256),
  reason: nonEmpty(8_192).optional(),
}).strict().superRefine((snapshot, context) => {
  const taskIds = new Set(snapshot.taskIds)
  if (taskIds.size !== snapshot.taskIds.length) {
    context.addIssue({ code: 'custom', message: 'workflow task ids must be unique' })
  }
  if (snapshot.taskIds.length > snapshot.maxTotalAgents) {
    context.addIssue({ code: 'custom', message: 'workflow task count exceeds its total-agent reservation' })
  }
  const outcomeIds = new Set(snapshot.outcomes.map(outcome => outcome.taskId))
  if (outcomeIds.size !== snapshot.outcomes.length
    || snapshot.outcomes.some(outcome => !taskIds.has(outcome.taskId))) {
    context.addIssue({ code: 'custom', message: 'workflow outcomes must uniquely address claimed tasks' })
  }
  const settledIds = new Set(snapshot.settledTaskIds)
  if (settledIds.size !== snapshot.settledTaskIds.length
    || snapshot.settledTaskIds.some(id => !outcomeIds.has(id))) {
    context.addIssue({ code: 'custom', message: 'settled workflow tasks must uniquely address outcomes' })
  }
  if (snapshot.updatedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', message: 'workflow updatedAt precedes createdAt' })
  }
  const hasClaim = snapshot.claimedRunRevision !== undefined
  const hasEngine = snapshot.engineRunId !== undefined
  const hasSettlement = snapshot.engineStopReason !== undefined
    || snapshot.engineAgentsStarted !== undefined
    || snapshot.targetPhase !== undefined
    || snapshot.outcomes.length > 0
    || snapshot.settledTaskIds.length > 0
  if (snapshot.phase === 'prepared' && (hasClaim || hasEngine || hasSettlement)) {
    context.addIssue({ code: 'custom', message: 'prepared workflow cannot carry claim or execution state' })
  }
  if (['claimed', 'running', 'settling', 'completed', 'partial-failure'].includes(snapshot.phase)
    && !hasClaim) {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} workflow requires a claimed run revision` })
  }
  if (['running', 'settling', 'completed', 'partial-failure'].includes(snapshot.phase) && !hasEngine) {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} workflow requires an engine run id` })
  }
  if (snapshot.phase === 'settling' || snapshot.phase === 'completed'
    || snapshot.phase === 'partial-failure') {
    if (!hasEngine || snapshot.engineStopReason === undefined
      || snapshot.engineAgentsStarted === undefined || snapshot.targetPhase === undefined
      || snapshot.outcomes.length !== snapshot.taskIds.length) {
      context.addIssue({ code: 'custom', message: `${snapshot.phase} workflow requires complete settlement data` })
    }
  } else if (hasSettlement && snapshot.phase !== 'cancelling'
    && snapshot.phase !== 'cancelled' && snapshot.phase !== 'error' && snapshot.phase !== 'uncertain') {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} workflow cannot carry settlement data` })
  }
  if ((snapshot.phase === 'completed' || snapshot.phase === 'partial-failure')
    && snapshot.settledTaskIds.length !== snapshot.taskIds.length) {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} workflow requires every task settlement` })
  }
  const reasonRequired = snapshot.phase === 'cancelling' || snapshot.phase === 'partial-failure'
    || snapshot.phase === 'cancelled' || snapshot.phase === 'error' || snapshot.phase === 'uncertain'
    || (snapshot.phase === 'settling' && snapshot.targetPhase !== 'completed')
  if (reasonRequired !== (snapshot.reason !== undefined)) {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} workflow has invalid reason presence` })
  }
})

/** Runtime validation for one immutable audit row. */
export const managedWorkflowAuditRecordSchema: z.ZodType<ManagedWorkflowAuditRecord> = z.object({
  version: z.literal(WORKFLOW_STATE_VERSION),
  operation: z.enum([
    'prepare',
    'claim',
    'start',
    'settle',
    'task-applied',
    'cancel-request',
    'finish',
    'uncertain',
  ]),
  time: safeTime,
  snapshot: managedWorkflowSnapshotSchema,
}).strict()

const TERMINAL_PHASES: ReadonlySet<ManagedWorkflowPhase> = new Set([
  'completed',
  'partial-failure',
  'cancelled',
  'error',
  'uncertain',
])

/** Whether a workflow state can no longer own live engine resources. */
export function isManagedWorkflowTerminal(phase: ManagedWorkflowPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/** Build the stable in-memory identity for one workflow intent. */
export function managedWorkflowIdentity(snapshot: Pick<ManagedWorkflowSnapshot, 'workflowId'>): string {
  return snapshot.workflowId
}

/** Build the aggregate audit-budget identity for one exact Autopilot run generation. */
export function managedWorkflowRunIdentity(
  snapshot: Pick<ManagedWorkflowSnapshot, 'parentSessionId' | 'runId' | 'generation'>,
): string {
  return `${snapshot.parentSessionId}\u0000${snapshot.runId}\u0000${snapshot.generation}`
}

/** Create the durable intent that must precede DAG claims and engine work. */
export function prepareManagedWorkflow(input: Omit<ManagedWorkflowSnapshot,
  'version' | 'revision' | 'phase' | 'createdAt' | 'updatedAt' | 'outcomes' | 'settledTaskIds'
  | 'claimedRunRevision' | 'engineRunId' | 'engineStopReason' | 'engineAgentsStarted' | 'targetPhase'
  | 'reason'>, now: number): ManagedWorkflowSnapshot {
  const snapshot: ManagedWorkflowSnapshot = Object.freeze({
    version: WORKFLOW_STATE_VERSION,
    ...input,
    taskIds: Object.freeze([...input.taskIds]),
    revision: 1,
    phase: 'prepared',
    createdAt: now,
    updatedAt: now,
    outcomes: Object.freeze([]),
    settledTaskIds: Object.freeze([]),
  })
  managedWorkflowSnapshotSchema.parse(snapshot)
  return snapshot
}

/** Record that exact DAG claims and the worst-case child reservation committed. */
export function claimManagedWorkflow(
  current: ManagedWorkflowSnapshot,
  claimedRunRevision: number,
  now: number,
): ManagedWorkflowSnapshot {
  requirePhase(current, ['prepared'], 'claim')
  return checkedNext(current, { phase: 'claimed', claimedRunRevision, updatedAt: now })
}

/** Bind the published DSH workflow-engine run identity. */
export function startManagedWorkflow(
  current: ManagedWorkflowSnapshot,
  engineRunId: string,
  now: number,
): ManagedWorkflowSnapshot {
  requirePhase(current, ['claimed'], 'start')
  return checkedNext(current, { phase: 'running', engineRunId: bounded(engineRunId, 'engine run id'), updatedAt: now })
}

/** Persist complete task outcomes before mutating any DAG task. */
export function settleManagedWorkflow(
  current: ManagedWorkflowSnapshot,
  input: {
    readonly stopReason: 'completed' | 'cancelled' | 'error'
    readonly agentsStarted: number
    readonly targetPhase: ManagedWorkflowTerminalPhase
    readonly outcomes: readonly ManagedWorkflowTaskOutcome[]
    readonly reason?: string | undefined
  },
  now: number,
): ManagedWorkflowSnapshot {
  requirePhase(current, ['running', 'cancelling'], 'settle')
  const outcomes = Object.freeze(input.outcomes.map(outcome => Object.freeze({
    ...outcome,
    evidence: Object.freeze(outcome.evidence.map(item => Object.freeze({ ...item }))),
  })))
  const next = checkedNext(current, {
    phase: 'settling',
    engineStopReason: input.stopReason,
    engineAgentsStarted: input.agentsStarted,
    targetPhase: input.targetPhase,
    outcomes,
    settledTaskIds: Object.freeze([]),
    ...(input.reason === undefined ? { clearReason: true as const } : { reason: bounded(input.reason, 'settlement reason') }),
    updatedAt: now,
  })
  return next
}

/** Record one already-applied exact DAG outcome. */
export function applyManagedWorkflowTask(
  current: ManagedWorkflowSnapshot,
  taskIdValue: string,
  now: number,
): ManagedWorkflowSnapshot {
  requirePhase(current, ['settling'], 'record task settlement')
  if (!current.outcomes.some(outcome => outcome.taskId === taskIdValue)) {
    throw new ManagedWorkflowStateError(`workflow has no outcome for task "${taskIdValue}"`)
  }
  if (current.settledTaskIds.includes(taskIdValue)) {
    throw new ManagedWorkflowStateError(`workflow task "${taskIdValue}" was already settled`)
  }
  return checkedNext(current, {
    settledTaskIds: Object.freeze([...current.settledTaskIds, taskIdValue]),
    updatedAt: now,
  })
}

/** Finish a fully applied task settlement with its preselected terminal phase. */
export function finishManagedWorkflow(
  current: ManagedWorkflowSnapshot,
  now: number,
): ManagedWorkflowSnapshot {
  requirePhase(current, ['settling'], 'finish')
  if (current.targetPhase === undefined || current.settledTaskIds.length !== current.taskIds.length) {
    throw new ManagedWorkflowStateError('workflow cannot finish before every task outcome is applied')
  }
  return checkedNext(current, {
    phase: current.targetPhase,
    ...(current.targetPhase === 'completed'
      ? { clearReason: true as const }
      : { reason: current.reason as string }),
    updatedAt: now,
  })
}

/** Persist cancellation intent before cancelling or disposing live resources. */
export function requestManagedWorkflowCancel(
  current: ManagedWorkflowSnapshot,
  reason: string,
  now: number,
): ManagedWorkflowSnapshot {
  if (isManagedWorkflowTerminal(current.phase)) {
    throw new ManagedWorkflowStateError(`cannot cancel terminal workflow in ${current.phase}`)
  }
  if (current.phase === 'cancelling') return current
  return checkedNext(current, {
    phase: 'cancelling',
    reason: bounded(reason, 'cancellation reason'),
    updatedAt: now,
  })
}

/** Finish a cancellation when the parent lease already settled its task attempts. */
export function finishManagedWorkflowCancel(
  current: ManagedWorkflowSnapshot,
  reason: string,
  now: number,
): ManagedWorkflowSnapshot {
  requirePhase(current, ['prepared', 'claimed', 'running', 'settling', 'cancelling'], 'finish cancellation')
  return checkedNext(current, {
    phase: 'cancelled',
    reason: bounded(reason, 'cancellation reason'),
    updatedAt: now,
  })
}

/** Fail before or after engine publication without fabricating task outcomes. */
export function failManagedWorkflow(
  current: ManagedWorkflowSnapshot,
  reason: string,
  now: number,
): ManagedWorkflowSnapshot {
  if (isManagedWorkflowTerminal(current.phase)) {
    throw new ManagedWorkflowStateError(`cannot fail terminal workflow in ${current.phase}`)
  }
  return checkedNext(current, {
    phase: 'error',
    reason: bounded(reason, 'workflow failure reason'),
    updatedAt: now,
  })
}

/** Fail closed when a process boundary makes execution or settlement unknowable. */
export function markManagedWorkflowUncertain(
  current: ManagedWorkflowSnapshot,
  reason: string,
  now: number,
): ManagedWorkflowSnapshot {
  if (isManagedWorkflowTerminal(current.phase)) return current
  return checkedNext(current, {
    phase: 'uncertain',
    reason: bounded(reason, 'workflow uncertainty reason'),
    updatedAt: now,
  })
}

function checkedNext(
  current: ManagedWorkflowSnapshot,
  patch: Partial<ManagedWorkflowSnapshot> & { readonly clearReason?: true },
): ManagedWorkflowSnapshot {
  const { clearReason, ...fields } = patch
  const mutable: ManagedWorkflowSnapshot = {
    ...current,
    ...fields,
    revision: current.revision + 1,
  }
  if (clearReason === true) delete (mutable as { reason?: string }).reason
  const next = Object.freeze(mutable)
  managedWorkflowSnapshotSchema.parse(next)
  return next
}

function requirePhase(
  current: ManagedWorkflowSnapshot,
  expected: readonly ManagedWorkflowPhase[],
  operation: string,
): void {
  if (!expected.includes(current.phase)) {
    throw new ManagedWorkflowStateError(`${operation} requires ${expected.join(' or ')}, found ${current.phase}`)
  }
}

function bounded(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 8_192) {
    throw new ManagedWorkflowStateError(`${label} must contain 1-8192 characters`)
  }
  return normalized
}
