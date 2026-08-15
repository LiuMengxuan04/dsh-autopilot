/** Durable state vocabulary for bounded fresh-agent Ralph loops. */
import { z } from 'zod'

/** Current persisted Ralph format. */
export const RALPH_STATE_VERSION = 1 as const

/** Storage-level text ceilings independent of deployment configuration. */
export const RALPH_STORAGE_LIMITS = Object.freeze({
  instructionChars: 32_768,
  handoffChars: 32_768,
  summaryChars: 16_384,
  reasonChars: 16_384,
  evidenceItems: 512,
  evidenceTextChars: 4_096,
  rounds: 4_096,
  toolNames: 128,
})

const TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

/** Evidence returned by one fresh Ralph worker. */
export interface RalphEvidence {
  readonly kind: 'file' | 'command' | 'test' | 'url' | 'note' | 'subagent'
  readonly ref: string
  readonly summary: string
}

/** One child round retained in the append-only Ralph ledger. */
export interface RalphRound {
  readonly number: number
  readonly status: 'starting' | 'continue' | 'completed' | 'blocked' | 'failed' | 'interrupted'
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  readonly childSessionId?: string | undefined
  readonly summary?: string | undefined
  readonly handoff?: string | undefined
  readonly evidence: readonly RalphEvidence[]
}

/** Lifecycle of one exact run-generation DAG leaf loop. */
export type RalphPhase =
  | 'claiming'
  | 'reserving'
  | 'ready'
  | 'running'
  | 'settling'
  | 'interrupted'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'needs-attention'

/** Complete post-mutation state for one Ralph leaf loop. */
export interface RalphSnapshot {
  readonly version: typeof RALPH_STATE_VERSION
  readonly parentSessionId: string
  readonly runId: string
  readonly generation: number
  readonly goalId: string
  readonly taskId: string
  readonly revision: number
  readonly phase: RalphPhase
  readonly instruction: string
  readonly policySha256: string
  /** Per-loop round ceiling, which may only decrease on explicit resume. */
  readonly maxRounds: number
  readonly maxHandoffChars: number
  readonly maxSummaryChars: number
  readonly maxEvidenceItems: number
  readonly reservedThroughRound: number
  readonly pendingReservationRound?: number | undefined
  readonly claimedRunRevision?: number | undefined
  readonly rounds: readonly RalphRound[]
  readonly handoff?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
  readonly reason?: string | undefined
}

/** Append-only mutation names for a Ralph loop. */
export type RalphOperation =
  | 'prepare'
  | 'claim'
  | 'reservation-prepare'
  | 'reservation-complete'
  | 'round-start'
  | 'round-bind'
  | 'round-continue'
  | 'round-settle'
  | 'terminal'
  | 'interrupt'
  | 'resume'
  | 'cancel'
  | 'attention'

/** One immutable Ralph audit row. */
export interface RalphAuditRecord {
  readonly version: typeof RALPH_STATE_VERSION
  readonly operation: RalphOperation
  readonly time: number
  readonly snapshot: RalphSnapshot
}

/** Stable Ralph state/store failure. */
export class RalphStateError extends Error {
  /** Machine-readable failure category. */
  readonly code = 'AUTOPILOT_RALPH_STATE_INVALID' as const

  /** @param message - Exact failed invariant. */
  constructor(message: string) {
    super(message)
    this.name = 'RalphStateError'
  }
}

const nonEmpty = (max: number) => z.string().trim().min(1).max(max)
const safeTime = z.number().int().nonnegative()
const positive = z.number().int().positive()

/** Runtime schema for one bounded Ralph evidence item. */
export const ralphEvidenceSchema: z.ZodType<RalphEvidence> = z.object({
  kind: z.enum(['file', 'command', 'test', 'url', 'note', 'subagent']),
  ref: nonEmpty(RALPH_STORAGE_LIMITS.evidenceTextChars),
  summary: nonEmpty(RALPH_STORAGE_LIMITS.evidenceTextChars),
}).strict()

const ralphRoundSchema: z.ZodType<RalphRound> = z.object({
  number: positive,
  status: z.enum(['starting', 'continue', 'completed', 'blocked', 'failed', 'interrupted']),
  startedAt: safeTime,
  finishedAt: safeTime.optional(),
  childSessionId: nonEmpty(256).optional(),
  summary: nonEmpty(RALPH_STORAGE_LIMITS.summaryChars).optional(),
  handoff: nonEmpty(RALPH_STORAGE_LIMITS.handoffChars).optional(),
  evidence: z.array(ralphEvidenceSchema).max(RALPH_STORAGE_LIMITS.evidenceItems),
}).strict().superRefine((round, context) => {
  if (round.status === 'starting') {
    if (round.finishedAt !== undefined || round.summary !== undefined || round.handoff !== undefined
      || round.evidence.length !== 0) {
      context.addIssue({ code: 'custom', message: 'a starting Ralph round cannot carry a result' })
    }
    return
  }
  if (round.finishedAt === undefined || round.summary === undefined) {
    context.addIssue({ code: 'custom', message: 'a settled Ralph round requires finish time and summary' })
  }
  if (round.status === 'continue' && round.handoff === undefined) {
    context.addIssue({ code: 'custom', message: 'a continuing Ralph round requires handoff text' })
  }
})

/** Runtime and storage validation for one complete Ralph snapshot. */
export const ralphSnapshotSchema: z.ZodType<RalphSnapshot> = z.object({
  version: z.literal(RALPH_STATE_VERSION),
  parentSessionId: nonEmpty(256),
  runId: nonEmpty(256),
  generation: positive,
  goalId: nonEmpty(256),
  taskId: z.string().regex(TASK_ID_PATTERN),
  revision: positive,
  phase: z.enum([
    'claiming',
    'reserving',
    'ready',
    'running',
    'settling',
    'interrupted',
    'completed',
    'blocked',
    'failed',
    'cancelled',
    'needs-attention',
  ]),
  instruction: nonEmpty(RALPH_STORAGE_LIMITS.instructionChars),
  policySha256: z.string().regex(SHA256_PATTERN),
  maxRounds: positive.max(RALPH_STORAGE_LIMITS.rounds),
  maxHandoffChars: positive.max(RALPH_STORAGE_LIMITS.handoffChars),
  maxSummaryChars: positive.max(RALPH_STORAGE_LIMITS.summaryChars),
  maxEvidenceItems: positive.max(RALPH_STORAGE_LIMITS.evidenceItems),
  reservedThroughRound: z.number().int().nonnegative(),
  pendingReservationRound: positive.optional(),
  claimedRunRevision: positive.optional(),
  rounds: z.array(ralphRoundSchema).max(RALPH_STORAGE_LIMITS.rounds),
  handoff: nonEmpty(RALPH_STORAGE_LIMITS.handoffChars).optional(),
  createdAt: safeTime,
  updatedAt: safeTime,
  reason: nonEmpty(RALPH_STORAGE_LIMITS.reasonChars).optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.updatedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', message: 'Ralph updatedAt precedes createdAt' })
  }
  if (snapshot.rounds.length > snapshot.maxRounds
    || snapshot.reservedThroughRound > snapshot.rounds.length + 1) {
    context.addIssue({ code: 'custom', message: 'Ralph round counters exceed their materialized limits' })
  }
  if (snapshot.handoff !== undefined && snapshot.handoff.length > snapshot.maxHandoffChars) {
    context.addIssue({ code: 'custom', message: 'Ralph handoff exceeds its materialized limit' })
  }
  if (totalEvidence(snapshot.rounds).length > snapshot.maxEvidenceItems) {
    context.addIssue({ code: 'custom', message: 'Ralph evidence exceeds its materialized limit' })
  }
  snapshot.rounds.forEach((round, index) => {
    if (round.number !== index + 1) {
      context.addIssue({ code: 'custom', message: 'Ralph round numbers must be contiguous' })
    }
    if (index < snapshot.rounds.length - 1 && round.status === 'starting') {
      context.addIssue({ code: 'custom', message: 'only the latest Ralph round may be starting' })
    }
    if ((round.summary?.length ?? 0) > snapshot.maxSummaryChars
      || (round.handoff?.length ?? 0) > snapshot.maxHandoffChars) {
      context.addIssue({ code: 'custom', message: 'Ralph round text exceeds its materialized limits' })
    }
  })
  const latest = snapshot.rounds.at(-1)
  if (snapshot.phase === 'claiming') {
    if (snapshot.claimedRunRevision !== undefined || snapshot.reservedThroughRound !== 0
      || snapshot.pendingReservationRound !== undefined || snapshot.rounds.length !== 0) {
      context.addIssue({ code: 'custom', message: 'claiming state cannot claim work or retain rounds' })
    }
  } else if (snapshot.claimedRunRevision === undefined
    && (snapshot.reservedThroughRound !== 0 || snapshot.rounds.length !== 0
      || (snapshot.phase !== 'interrupted' && snapshot.phase !== 'blocked'
        && snapshot.phase !== 'reserving' && snapshot.phase !== 'cancelled'
        && snapshot.phase !== 'needs-attention'))) {
    context.addIssue({ code: 'custom', message: 'post-claim Ralph state requires an Autopilot revision' })
  }
  if ((snapshot.phase === 'reserving') !== (snapshot.pendingReservationRound !== undefined)) {
    context.addIssue({ code: 'custom', message: 'only reserving state carries a pending reservation' })
  }
  if (snapshot.pendingReservationRound !== undefined
    && snapshot.pendingReservationRound !== snapshot.rounds.length + 1) {
    context.addIssue({ code: 'custom', message: 'Ralph reservation must target the next fresh round' })
  }
  if (snapshot.phase === 'running' && latest?.status !== 'starting') {
    context.addIssue({ code: 'custom', message: 'running Ralph state requires one starting round' })
  }
  if (snapshot.phase === 'running' && snapshot.reservedThroughRound < snapshot.rounds.length) {
    context.addIssue({ code: 'custom', message: 'running Ralph state requires a charged fresh round' })
  }
  if (snapshot.phase === 'settling'
    && (latest === undefined || latest.status === 'starting' || latest.status === 'continue'
      || latest.status === 'interrupted')) {
    context.addIssue({ code: 'custom', message: 'settling Ralph state requires a final child result' })
  }
  if (snapshot.phase === 'completed'
    && (latest?.status !== 'completed' || totalEvidence(snapshot.rounds).length === 0)) {
    context.addIssue({ code: 'custom', message: 'completed Ralph state requires completion evidence' })
  }
})

/** Runtime and storage validation for one immutable Ralph audit record. */
export const ralphAuditRecordSchema: z.ZodType<RalphAuditRecord> = z.object({
  version: z.literal(RALPH_STATE_VERSION),
  operation: z.enum([
    'prepare',
    'claim',
    'reservation-prepare',
    'reservation-complete',
    'round-start',
    'round-bind',
    'round-continue',
    'round-settle',
    'terminal',
    'interrupt',
    'resume',
    'cancel',
    'attention',
  ]),
  time: safeTime,
  snapshot: ralphSnapshotSchema,
}).strict()

/** Stable identity for one run-generation task loop. */
export function ralphIdentity(
  value: Pick<RalphSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId'>,
): string {
  return `${value.parentSessionId}\u0000${value.runId}\u0000${value.generation}\u0000${value.taskId}`
}

/** Collect all round evidence in stable round and item order. */
export function totalEvidence(rounds: readonly RalphRound[]): readonly RalphEvidence[] {
  return Object.freeze(rounds.flatMap(round => round.evidence))
}

const allowedPhases: Readonly<Record<RalphOperation, readonly RalphPhase[]>> = Object.freeze({
  prepare: ['claiming'],
  claim: ['ready'],
  'reservation-prepare': ['reserving'],
  'reservation-complete': ['ready'],
  'round-start': ['running'],
  'round-bind': ['running'],
  'round-continue': ['ready'],
  'round-settle': ['settling'],
  terminal: ['completed', 'blocked', 'failed'],
  interrupt: ['interrupted'],
  resume: ['ready'],
  cancel: ['cancelled'],
  attention: ['needs-attention'],
})

const allowedPreviousPhases: Readonly<Record<Exclude<RalphOperation, 'prepare'>, readonly RalphPhase[]>> =
  Object.freeze({
    claim: ['claiming'],
    'reservation-prepare': ['ready', 'interrupted'],
    'reservation-complete': ['reserving'],
    'round-start': ['ready'],
    'round-bind': ['running'],
    'round-continue': ['running'],
    'round-settle': ['running'],
    terminal: ['claiming', 'reserving', 'ready', 'settling', 'interrupted'],
    interrupt: ['claiming', 'reserving', 'ready', 'running', 'settling'],
    resume: ['interrupted'],
    cancel: ['claiming', 'reserving', 'ready', 'running', 'settling', 'interrupted'],
    attention: ['claiming', 'reserving', 'ready', 'running', 'settling', 'interrupted'],
  })

/** Validate one append-only Ralph transition, including generation/revision CAS fields. */
export function assertRalphTransition(
  previous: RalphSnapshot | undefined,
  record: RalphAuditRecord,
): void {
  ralphAuditRecordSchema.parse(record)
  const next = record.snapshot
  if (!allowedPhases[record.operation].includes(next.phase)) {
    throw new RalphStateError(`operation ${record.operation} cannot produce phase ${next.phase}`)
  }
  if (record.time !== next.updatedAt) throw new RalphStateError('Ralph audit time must equal snapshot updatedAt')
  if (previous === undefined) {
    if (record.operation !== 'prepare' || next.revision !== 1) {
      throw new RalphStateError('a Ralph loop must begin with prepare revision 1')
    }
    return
  }
  const terminal = ['completed', 'blocked', 'failed', 'cancelled', 'needs-attention'] as const
  if (terminal.includes(previous.phase as typeof terminal[number])) {
    throw new RalphStateError(`terminal Ralph phase ${previous.phase} cannot receive another revision`)
  }
  if (record.operation === 'prepare'
    || !allowedPreviousPhases[record.operation].includes(previous.phase)) {
    throw new RalphStateError(`operation ${record.operation} cannot follow phase ${previous.phase}`)
  }
  if (ralphIdentity(previous) !== ralphIdentity(next) || previous.goalId !== next.goalId
    || previous.createdAt !== next.createdAt || previous.instruction !== next.instruction
    || previous.policySha256 !== next.policySha256
    || previous.maxHandoffChars !== next.maxHandoffChars
    || previous.maxSummaryChars !== next.maxSummaryChars
    || previous.maxEvidenceItems !== next.maxEvidenceItems) {
    throw new RalphStateError('Ralph transition changed immutable identity or policy')
  }
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt) {
    throw new RalphStateError('Ralph revisions and timestamps must advance monotonically')
  }
  if (next.maxRounds > previous.maxRounds
    || (next.maxRounds !== previous.maxRounds
      && record.operation !== 'resume' && record.operation !== 'reservation-prepare')) {
    throw new RalphStateError('Ralph maxRounds cannot increase after authorization')
  }
  const sameLengthHistory = next.rounds.length === previous.rounds.length
    && JSON.stringify(next.rounds.slice(0, -1)) === JSON.stringify(previous.rounds.slice(0, -1))
  const appendedRoundHistory = next.rounds.length === previous.rounds.length + 1
    && JSON.stringify(next.rounds.slice(0, -1)) === JSON.stringify(previous.rounds)
  if (!sameLengthHistory && !appendedRoundHistory) {
    throw new RalphStateError('Ralph transition rewrote settled round history')
  }
  if (next.reservedThroughRound < previous.reservedThroughRound) {
    throw new RalphStateError('Ralph transition decreased reserved round accounting')
  }
  if (next.reservedThroughRound !== previous.reservedThroughRound
    && record.operation !== 'claim' && record.operation !== 'reservation-complete') {
    throw new RalphStateError('Ralph reservation accounting changed outside a reservation commit')
  }
  if ((record.operation === 'round-start') !== appendedRoundHistory) {
    throw new RalphStateError('only round-start may append exactly one Ralph round')
  }
  if (previous.claimedRunRevision !== undefined && next.claimedRunRevision !== undefined
    && next.claimedRunRevision < previous.claimedRunRevision) {
    throw new RalphStateError('Ralph claimed Autopilot revision moved backwards')
  }
  if (next.claimedRunRevision !== previous.claimedRunRevision
    && record.operation !== 'claim' && record.operation !== 'reservation-complete') {
    throw new RalphStateError('Ralph claimed Autopilot revision changed outside budget accounting')
  }
  if (next.handoff !== previous.handoff
    && record.operation !== 'round-continue' && record.operation !== 'round-settle') {
    throw new RalphStateError('Ralph handoff changed outside child settlement')
  }
  if (record.operation !== 'round-start' && record.operation !== 'round-bind'
    && record.operation !== 'round-continue' && record.operation !== 'round-settle'
    && record.operation !== 'interrupt'
    && JSON.stringify(next.rounds) !== JSON.stringify(previous.rounds)) {
    throw new RalphStateError(`operation ${record.operation} cannot rewrite Ralph rounds`)
  }
}

/** Replace the latest round without permitting historical mutation. */
export function replaceLatestRound(snapshot: RalphSnapshot, round: RalphRound): readonly RalphRound[] {
  const latest = snapshot.rounds.at(-1)
  if (latest === undefined || latest.number !== round.number) {
    throw new RalphStateError('Ralph latest-round replacement targets no active round')
  }
  return Object.freeze([...snapshot.rounds.slice(0, -1), Object.freeze(round)])
}
