/** Durable identities and state transitions for continuable Autopilot teams. */
import { z } from 'zod'

/** Current storage format for continuable-team records. */
export const TEAM_STATE_VERSION = 1 as const

/** Stable task ids shared with the Autopilot task graph. */
export const TEAM_TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

const SHA256_PATTERN = /^[a-f0-9]{64}$/u

/** Evidence accepted from a continuable worker when it settles a task. */
export interface TeamEvidence {
  readonly kind: 'file' | 'command' | 'test' | 'url' | 'note' | 'subagent'
  readonly ref: string
  readonly summary: string
}

/** Structured task outcome reported by one exact continuable child. */
export interface TeamTaskReport {
  readonly status: 'completed' | 'blocked' | 'failed'
  readonly summary: string
  readonly evidence: readonly TeamEvidence[]
  readonly submittedAt: number
}

/** One exact inbox acceptance retained in the mailbox ledger. */
export interface TeamMessageReceipt {
  readonly sequence: number
  readonly kind: 'initial' | 'followup' | 'report'
  readonly messageId: string
  readonly contentSha256: string
  readonly acceptedAt: number
}

/** A delivery intent that was durable before calling the DSH inbox API. */
export type TeamPendingMessage =
  | {
    readonly kind: 'followup'
    readonly contentSha256: string
    readonly preparedAt: number
  }
  | {
    readonly kind: 'report'
    readonly contentSha256: string
    readonly preparedAt: number
    readonly report: TeamTaskReport
  }

/** A report whose parent inbox acceptance has an exact durable identity. */
export interface TeamAcceptedReport extends TeamTaskReport {
  readonly messageId: string
  readonly acceptedAt: number
}

/** Lifecycle of one claimed task's durable continuable child. */
export type TeamThreadPhase =
  | 'starting'
  | 'active'
  | 'interrupted'
  | 'reporting'
  | 'settled'
  | 'failed'
  | 'needs-attention'

/** Complete post-mutation state for one run-generation task assignment. */
export interface TeamThreadSnapshot {
  readonly version: typeof TEAM_STATE_VERSION
  readonly parentSessionId: string
  readonly runId: string
  readonly generation: number
  readonly runRevisionAtClaim: number
  /** Maximum immutable team revisions retained across this run generation. */
  readonly maxAuditRecords: number
  /** Maximum aggregate team-audit UTF-8 JSON bytes across this run generation. */
  readonly maxAuditBytes: number
  readonly taskId: string
  readonly revision: number
  readonly provider: string
  readonly label: string
  readonly role: string
  readonly promptSha256: string
  readonly phase: TeamThreadPhase
  readonly childSessionId?: string | undefined
  readonly messages: readonly TeamMessageReceipt[]
  readonly pendingMessage?: TeamPendingMessage | undefined
  readonly report?: TeamAcceptedReport | undefined
  readonly createdAt: number
  readonly updatedAt: number
  readonly reason?: string | undefined
  readonly lastError?: string | undefined
}

/** Append-only mutation vocabulary for one team thread. */
export type TeamThreadOperation =
  | 'prepare'
  | 'start'
  | 'start-failed'
  | 'followup-prepare'
  | 'followup-accepted'
  | 'followup-failed'
  | 'interrupt'
  | 'report-prepare'
  | 'report-accepted'
  | 'report-failed'
  | 'settle'
  | 'attention'

/** One immutable team-thread audit row. */
export interface TeamAuditRecord {
  readonly version: typeof TEAM_STATE_VERSION
  readonly operation: TeamThreadOperation
  readonly time: number
  readonly snapshot: TeamThreadSnapshot
}

/** A discovered continuable descendant that has no exact accepted binding. */
export interface TeamOrphanRecord {
  readonly version: typeof TEAM_STATE_VERSION
  readonly parentSessionId: string
  readonly runId: string
  readonly generation: number
  readonly childSessionId: string
  readonly observedAt: number
  readonly reason: string
  readonly label?: string | undefined
  readonly initialMessageId?: string | undefined
  readonly parentId?: string | undefined
  readonly depth?: number | undefined
}

const evidenceSchema: z.ZodType<TeamEvidence> = z.object({
  kind: z.enum(['file', 'command', 'test', 'url', 'note', 'subagent']),
  ref: z.string().min(1).max(4096),
  summary: z.string().min(1).max(4096),
}).strict()

const reportSchema: z.ZodType<TeamTaskReport> = z.object({
  status: z.enum(['completed', 'blocked', 'failed']),
  summary: z.string().min(1).max(8192),
  evidence: z.array(evidenceSchema).max(128),
  submittedAt: z.number().int().nonnegative(),
}).strict().superRefine((report, context) => {
  if (report.status === 'completed' && report.evidence.length === 0) {
    context.addIssue({ code: 'custom', message: 'completed team reports require evidence' })
  }
})

const acceptedReportSchema: z.ZodType<TeamAcceptedReport> = reportSchema.and(z.object({
  messageId: z.string().min(1).max(256),
  acceptedAt: z.number().int().nonnegative(),
}).strict())

const messageSchema: z.ZodType<TeamMessageReceipt> = z.object({
  sequence: z.number().int().positive(),
  kind: z.enum(['initial', 'followup', 'report']),
  messageId: z.string().min(1).max(256),
  contentSha256: z.string().regex(SHA256_PATTERN),
  acceptedAt: z.number().int().nonnegative(),
}).strict()

const pendingMessageSchema: z.ZodType<TeamPendingMessage> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('followup'),
    contentSha256: z.string().regex(SHA256_PATTERN),
    preparedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('report'),
    contentSha256: z.string().regex(SHA256_PATTERN),
    preparedAt: z.number().int().nonnegative(),
    report: reportSchema,
  }).strict(),
])

/** Runtime and storage validation for a complete team-thread snapshot. */
export const teamThreadSnapshotSchema: z.ZodType<TeamThreadSnapshot> = z.object({
  version: z.literal(TEAM_STATE_VERSION),
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  generation: z.number().int().positive(),
  runRevisionAtClaim: z.number().int().positive(),
  maxAuditRecords: z.number().int().positive(),
  maxAuditBytes: z.number().int().positive(),
  taskId: z.string().regex(TEAM_TASK_ID_PATTERN),
  revision: z.number().int().positive(),
  provider: z.string().min(1).max(128),
  label: z.string().min(1).max(512),
  role: z.string().min(1).max(256),
  promptSha256: z.string().regex(SHA256_PATTERN),
  phase: z.enum(['starting', 'active', 'interrupted', 'reporting', 'settled', 'failed', 'needs-attention']),
  childSessionId: z.string().min(1).max(256).optional(),
  messages: z.array(messageSchema).max(4096),
  pendingMessage: pendingMessageSchema.optional(),
  report: acceptedReportSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  reason: z.string().min(1).max(8192).optional(),
  lastError: z.string().min(1).max(8192).optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.updatedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', message: 'updatedAt precedes createdAt' })
  }
  const ids = new Set<string>()
  snapshot.messages.forEach((message, index) => {
    if (message.sequence !== index + 1) {
      context.addIssue({ code: 'custom', message: 'message sequences must be contiguous' })
    }
    if (ids.has(message.messageId)) {
      context.addIssue({ code: 'custom', message: 'message ids must be unique within a team thread' })
    }
    ids.add(message.messageId)
  })
  if (snapshot.messages[0]?.kind !== 'initial' && snapshot.messages.length > 0) {
    context.addIssue({ code: 'custom', message: 'the first team message must be initial' })
  }
  const hasChild = snapshot.childSessionId !== undefined
  const hasInitial = snapshot.messages[0]?.kind === 'initial'
  if (hasChild !== hasInitial) {
    context.addIssue({ code: 'custom', message: 'child identity and initial message must appear together' })
  }
  if (hasInitial && snapshot.messages[0]?.contentSha256 !== snapshot.promptSha256) {
    context.addIssue({ code: 'custom', message: 'the initial message must identify the claimed prompt' })
  }
  if ((snapshot.phase === 'starting' || snapshot.phase === 'failed') && hasChild) {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} threads cannot own a child` })
  }
  if (snapshot.phase !== 'starting' && snapshot.phase !== 'failed' && !hasChild) {
    context.addIssue({ code: 'custom', message: `${snapshot.phase} threads require a child` })
  }
  if (snapshot.phase === 'reporting') {
    if ((snapshot.pendingMessage?.kind === 'report') === (snapshot.report !== undefined)) {
      context.addIssue({ code: 'custom', message: 'reporting requires exactly one pending or accepted report' })
    }
  } else if (snapshot.report !== undefined && snapshot.phase !== 'settled' && snapshot.phase !== 'needs-attention') {
    context.addIssue({ code: 'custom', message: 'accepted reports require reporting, settled, or attention state' })
  }
  if (snapshot.phase === 'settled' && snapshot.report === undefined) {
    context.addIssue({ code: 'custom', message: 'settled threads require an accepted report' })
  }
})

/** Runtime and storage validation for one immutable audit row. */
export const teamAuditRecordSchema: z.ZodType<TeamAuditRecord> = z.object({
  version: z.literal(TEAM_STATE_VERSION),
  operation: z.enum([
    'prepare',
    'start',
    'start-failed',
    'followup-prepare',
    'followup-accepted',
    'followup-failed',
    'interrupt',
    'report-prepare',
    'report-accepted',
    'report-failed',
    'settle',
    'attention',
  ]),
  time: z.number().int().nonnegative(),
  snapshot: teamThreadSnapshotSchema,
}).strict()

/** Runtime and storage validation for one orphan observation. */
export const teamOrphanRecordSchema: z.ZodType<TeamOrphanRecord> = z.object({
  version: z.literal(TEAM_STATE_VERSION),
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  generation: z.number().int().positive(),
  childSessionId: z.string().min(1).max(256),
  observedAt: z.number().int().nonnegative(),
  reason: z.string().min(1).max(8192),
  label: z.string().min(1).max(512).optional(),
  initialMessageId: z.string().min(1).max(256).optional(),
  parentId: z.string().min(1).max(256).optional(),
  depth: z.number().int().positive().optional(),
}).strict()

/** Stable team-state validation failure. */
export class TeamStateError extends Error {
  /** Machine-routable error category. */
  readonly code = 'AUTOPILOT_TEAM_STATE_INVALID' as const

  /** @param message - Exact failed invariant. */
  constructor(message: string) {
    super(message)
    this.name = 'TeamStateError'
  }
}

/** Build the stable identity key for one run-generation task assignment. */
export function teamThreadIdentity(
  value: Pick<TeamThreadSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId'>,
): string {
  return `${value.parentSessionId}\u0000${value.runId}\u0000${value.generation}\u0000${value.taskId}`
}

/** Deterministic child label used to reconcile a crash before binding persistence. */
export function teamChildLabel(runId: string, generation: number, taskId: string): string {
  if (runId.length === 0 || !Number.isSafeInteger(generation) || generation < 1
    || !TEAM_TASK_ID_PATTERN.test(taskId)) {
    throw new TeamStateError('team child label requires a run id, positive generation, and valid task id')
  }
  const encodedRun = Buffer.from(runId, 'utf8').toString('base64url')
  return `dsh-autopilot-team:${encodedRun}:${generation}:${taskId}`
}

/** Parse only labels emitted by {@link teamChildLabel}. */
export function parseTeamChildLabel(label: string): {
  readonly runId: string
  readonly generation: number
  readonly taskId: string
} | undefined {
  const match = /^dsh-autopilot-team:([A-Za-z0-9_-]+):([1-9][0-9]*):([a-z][a-z0-9-]{0,63})$/u.exec(label)
  if (match === null) return undefined
  const encodedRun = match[1]
  const generationText = match[2]
  const taskId = match[3]
  /* v8 ignore next -- the regular expression requires all three captures. */
  if (encodedRun === undefined || generationText === undefined || taskId === undefined) return undefined
  const generation = Number(generationText)
  if (!Number.isSafeInteger(generation)) return undefined
  const runId = Buffer.from(encodedRun, 'base64url').toString('utf8')
  if (runId.length === 0) return undefined
  return Object.freeze({ runId, generation, taskId })
}

/** Create the first durable intent after Autonomy atomically claims the task. */
export function prepareTeamThread(input: {
  readonly parentSessionId: string
  readonly runId: string
  readonly generation: number
  readonly runRevisionAtClaim: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly taskId: string
  readonly provider: string
  readonly label: string
  readonly role: string
  readonly promptSha256: string
}, now: number): TeamThreadSnapshot {
  return checked({
    version: TEAM_STATE_VERSION,
    ...input,
    revision: 1,
    phase: 'starting',
    messages: [],
    createdAt: now,
    updatedAt: now,
  })
}

/** Bind the exact durable child and accepted initial inbox message. */
export function acceptTeamStart(
  current: TeamThreadSnapshot,
  childSessionId: string,
  messageId: string,
  now: number,
): TeamThreadSnapshot {
  requirePhase(current, ['starting'], 'accept start')
  return nextSnapshot(current, now, {
    phase: 'active',
    childSessionId,
    messages: [receipt(1, 'initial', messageId, current.promptSha256, now)],
  })
}

/**
 * Bind an accepted child directly into fail-closed attention after its normal ledger append failed.
 * @param current - Exact durable start intent that preceded DSH admission.
 * @param childSessionId - Stable child session returned by DSH.
 * @param messageId - Stable initial inbox message returned by DSH.
 * @param reason - Operational reason requiring reconciliation.
 * @param now - Mutation timestamp.
 * @returns immutable attention snapshot with exact child and message attribution.
 */
export function bindAcceptedTeamStartAttention(
  current: TeamThreadSnapshot,
  childSessionId: string,
  messageId: string,
  reason: string,
  now: number,
): TeamThreadSnapshot {
  requirePhase(current, ['starting'], 'bind uncertain start')
  return nextSnapshot(current, now, {
    phase: 'needs-attention',
    childSessionId,
    messages: [receipt(1, 'initial', messageId, current.promptSha256, now)],
    reason: nonEmpty(reason, 'attention reason'),
  })
}

/** Record a rejected start without inventing child or message identities. */
export function failTeamStart(current: TeamThreadSnapshot, reason: string, now: number): TeamThreadSnapshot {
  requirePhase(current, ['starting'], 'fail start')
  return nextSnapshot(current, now, { phase: 'failed', reason: nonEmpty(reason, 'start failure') })
}

/** Persist a follow-up or structured report intent before inbox admission. */
export function prepareTeamMessage(
  current: TeamThreadSnapshot,
  pending: TeamPendingMessage,
  now: number,
): TeamThreadSnapshot {
  requirePhase(current, ['active', 'interrupted'], `prepare ${pending.kind}`)
  if (current.pendingMessage !== undefined) throw new TeamStateError('a team delivery is already pending')
  return nextSnapshot(current, now, {
    phase: pending.kind === 'report' ? 'reporting' : current.phase,
    pendingMessage: freezePending(pending),
    lastError: undefined,
  })
}

/** Commit the exact message id returned by DSH after inbox acceptance. */
export function acceptTeamMessage(
  current: TeamThreadSnapshot,
  messageId: string,
  now: number,
): TeamThreadSnapshot {
  const pending = current.pendingMessage
  if (pending === undefined) throw new TeamStateError('no team delivery is pending')
  const message = receipt(current.messages.length + 1, pending.kind, messageId, pending.contentSha256, now)
  if (pending.kind === 'followup') {
    requirePhase(current, ['active', 'interrupted'], 'accept followup')
    return nextSnapshot(current, now, {
      phase: 'active',
      messages: [...current.messages, message],
      pendingMessage: undefined,
      lastError: undefined,
    })
  }
  requirePhase(current, ['reporting'], 'accept report')
  return nextSnapshot(current, now, {
    messages: [...current.messages, message],
    pendingMessage: undefined,
    report: Object.freeze({ ...pending.report, messageId, acceptedAt: now }),
    lastError: undefined,
  })
}

/** Clear a delivery rejected before DSH inbox acceptance so a retry is safe. */
export function failTeamMessage(current: TeamThreadSnapshot, reason: string, now: number): TeamThreadSnapshot {
  const pending = current.pendingMessage
  if (pending === undefined) throw new TeamStateError('no team delivery is pending')
  const priorPhase: TeamThreadPhase = pending.kind === 'report' ? 'active' : current.phase
  return nextSnapshot(current, now, {
    phase: priorPhase,
    pendingMessage: undefined,
    lastError: nonEmpty(reason, 'delivery failure'),
  })
}

/** Record a turn interrupt while retaining the durable continuable child. */
export function interruptTeamThread(current: TeamThreadSnapshot, reason: string, now: number): TeamThreadSnapshot {
  requirePhase(current, ['active'], 'interrupt')
  return nextSnapshot(current, now, {
    phase: 'interrupted',
    reason: nonEmpty(reason, 'interrupt reason'),
  })
}

/** Mark the accepted structured report as applied to the Autopilot DAG. */
export function settleTeamThread(current: TeamThreadSnapshot, now: number): TeamThreadSnapshot {
  requirePhase(current, ['reporting'], 'settle')
  if (current.pendingMessage !== undefined || current.report === undefined) {
    throw new TeamStateError('settlement requires an accepted report and no pending delivery')
  }
  return nextSnapshot(current, now, { phase: 'settled', reason: undefined })
}

/** Fail closed around a crash window or an unattributed descendant. */
export function markTeamThreadAttention(
  current: TeamThreadSnapshot,
  reason: string,
  now: number,
): TeamThreadSnapshot {
  requirePhase(current, ['active', 'interrupted', 'reporting'], 'mark attention')
  return nextSnapshot(current, now, {
    phase: 'needs-attention',
    reason: nonEmpty(reason, 'attention reason'),
  })
}

/** Validate the first row or one exact append-only transition. */
export function assertTeamAuditTransition(
  previous: TeamThreadSnapshot | undefined,
  record: TeamAuditRecord,
): void {
  teamAuditRecordSchema.parse(record)
  const next = record.snapshot
  if (record.time !== next.updatedAt) throw new TeamStateError('audit time must equal snapshot updatedAt')
  if (previous === undefined) {
    if (record.operation !== 'prepare' || next.revision !== 1 || next.phase !== 'starting'
      || next.childSessionId !== undefined || next.messages.length !== 0) {
      throw new TeamStateError('a team thread must begin with one empty prepare revision')
    }
    return
  }
  if (teamThreadIdentity(previous) !== teamThreadIdentity(next)) {
    throw new TeamStateError('team thread identity changed')
  }
  for (const field of [
    'runRevisionAtClaim', 'maxAuditRecords', 'maxAuditBytes', 'provider', 'label', 'role', 'promptSha256', 'createdAt',
  ] as const) {
    if (next[field] !== previous[field]) throw new TeamStateError(`team thread changed immutable ${field}`)
  }
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt) {
    throw new TeamStateError('team revisions must be contiguous and monotonic')
  }
  if (previous.childSessionId !== undefined && next.childSessionId !== previous.childSessionId) {
    throw new TeamStateError('team child identity changed')
  }
  if (next.messages.length < previous.messages.length
    || JSON.stringify(next.messages.slice(0, previous.messages.length)) !== JSON.stringify(previous.messages)) {
    throw new TeamStateError('team mailbox receipts are append-only')
  }
  const allowed: Readonly<Record<TeamThreadOperation, readonly TeamThreadPhase[]>> = {
    prepare: [],
    start: ['active'],
    'start-failed': ['failed'],
    'followup-prepare': ['active', 'interrupted'],
    'followup-accepted': ['active'],
    'followup-failed': ['active', 'interrupted'],
    interrupt: ['interrupted'],
    'report-prepare': ['reporting'],
    'report-accepted': ['reporting'],
    'report-failed': ['active'],
    settle: ['settled'],
    attention: ['needs-attention'],
  }
  if (!allowed[record.operation].includes(next.phase)) {
    throw new TeamStateError(`operation ${record.operation} cannot produce ${next.phase}`)
  }
  assertOperationDelta(previous, next, record.operation)
}

/** Fold unordered persisted rows into exact current assignment and child indexes. */
export function foldTeamAudit(records: readonly TeamAuditRecord[]): {
  readonly current: ReadonlyMap<string, TeamThreadSnapshot>
  readonly byChild: ReadonlyMap<string, TeamThreadSnapshot>
  readonly history: readonly TeamAuditRecord[]
} {
  const history = [...records].sort((left, right) =>
    teamThreadIdentity(left.snapshot).localeCompare(teamThreadIdentity(right.snapshot))
      || left.snapshot.revision - right.snapshot.revision)
  const current = new Map<string, TeamThreadSnapshot>()
  const byChild = new Map<string, TeamThreadSnapshot>()
  for (const record of history) {
    const key = teamThreadIdentity(record.snapshot)
    const previous = current.get(key)
    assertTeamAuditTransition(previous, record)
    const priorChild = previous?.childSessionId
    if (priorChild !== undefined) byChild.delete(priorChild)
    const child = record.snapshot.childSessionId
    if (child !== undefined) {
      const collision = byChild.get(child)
      if (collision !== undefined && teamThreadIdentity(collision) !== key) {
        throw new TeamStateError(`child session "${child}" belongs to more than one team task`)
      }
      byChild.set(child, record.snapshot)
    }
    current.set(key, record.snapshot)
  }
  return Object.freeze({ current, byChild, history: Object.freeze(history) })
}

function assertOperationDelta(
  previous: TeamThreadSnapshot,
  next: TeamThreadSnapshot,
  operation: TeamThreadOperation,
): void {
  switch (operation) {
    case 'start':
      if (previous.phase !== 'starting' || next.childSessionId === undefined
        || next.messages.length !== 1 || next.messages[0]?.kind !== 'initial') {
        throw new TeamStateError('start must bind one child and its initial message')
      }
      return
    case 'start-failed':
      if (previous.phase !== 'starting' || next.reason === undefined) {
        throw new TeamStateError('start-failed requires a starting thread and reason')
      }
      return
    case 'followup-prepare':
      if (!['active', 'interrupted'].includes(previous.phase) || next.pendingMessage?.kind !== 'followup'
        || next.messages.length !== previous.messages.length) {
        throw new TeamStateError('followup-prepare must add one pending followup')
      }
      return
    case 'followup-accepted':
      if (previous.pendingMessage?.kind !== 'followup' || next.pendingMessage !== undefined
        || next.messages.length !== previous.messages.length + 1 || next.messages.at(-1)?.kind !== 'followup') {
        throw new TeamStateError('followup-accepted must append the pending message')
      }
      return
    case 'followup-failed':
      if (previous.pendingMessage?.kind !== 'followup' || next.pendingMessage !== undefined
        || next.lastError === undefined || next.messages.length !== previous.messages.length) {
        throw new TeamStateError('followup-failed must clear the rejected pending message')
      }
      return
    case 'interrupt':
      if (previous.phase !== 'active' || next.childSessionId === undefined || next.reason === undefined) {
        throw new TeamStateError('interrupt must retain an active child and reason')
      }
      return
    case 'report-prepare':
      if (!['active', 'interrupted'].includes(previous.phase) || next.pendingMessage?.kind !== 'report') {
        throw new TeamStateError('report-prepare must retain one structured pending report')
      }
      return
    case 'report-accepted':
      if (previous.pendingMessage?.kind !== 'report' || next.pendingMessage !== undefined
        || next.report === undefined || next.messages.at(-1)?.kind !== 'report') {
        throw new TeamStateError('report-accepted must bind the parent message id')
      }
      return
    case 'report-failed':
      if (previous.pendingMessage?.kind !== 'report' || next.pendingMessage !== undefined
        || next.lastError === undefined || next.messages.length !== previous.messages.length) {
        throw new TeamStateError('report-failed must clear the rejected pending report')
      }
      return
    case 'settle':
      if (previous.phase !== 'reporting' || previous.report === undefined || next.report === undefined) {
        throw new TeamStateError('settle requires the accepted structured report')
      }
      return
    case 'attention':
      if (['settled', 'failed', 'needs-attention'].includes(previous.phase) || next.reason === undefined) {
        throw new TeamStateError('attention requires a live ambiguous thread and reason')
      }
      return
    /* v8 ignore next -- the operation-phase table rejects prepare before delta validation. */
    case 'prepare':
      throw new TeamStateError('prepare cannot follow an existing team revision')
  }
}

function receipt(
  sequence: number,
  kind: TeamMessageReceipt['kind'],
  messageId: string,
  contentSha256: string,
  acceptedAt: number,
): TeamMessageReceipt {
  return Object.freeze({ sequence, kind, messageId, contentSha256, acceptedAt })
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TeamStateError(`${field} must not be empty`)
  return normalized
}

function requirePhase(
  current: TeamThreadSnapshot,
  phases: readonly TeamThreadPhase[],
  action: string,
): void {
  if (!phases.includes(current.phase)) {
    throw new TeamStateError(`cannot ${action} while team task ${current.taskId} is ${current.phase}`)
  }
}

function freezePending(pending: TeamPendingMessage): TeamPendingMessage {
  return pending.kind === 'followup'
    ? Object.freeze({ ...pending })
    : Object.freeze({
      ...pending,
      report: Object.freeze({
        ...pending.report,
        evidence: Object.freeze(pending.report.evidence.map(item => Object.freeze({ ...item }))),
      }),
    })
}

function checked(candidate: TeamThreadSnapshot): TeamThreadSnapshot {
  teamThreadSnapshotSchema.parse(candidate)
  return Object.freeze({
    ...candidate,
    messages: Object.freeze(candidate.messages.map(message => Object.freeze({ ...message }))),
    ...(candidate.pendingMessage === undefined ? {} : { pendingMessage: freezePending(candidate.pendingMessage) }),
    ...(candidate.report === undefined ? {} : {
      report: Object.freeze({
        ...candidate.report,
        evidence: Object.freeze(candidate.report.evidence.map(item => Object.freeze({ ...item }))),
      }),
    }),
  })
}

function nextSnapshot(
  current: TeamThreadSnapshot,
  now: number,
  changes: Partial<TeamThreadSnapshot>,
): TeamThreadSnapshot {
  const candidate: TeamThreadSnapshot = {
    ...current,
    ...changes,
    revision: current.revision + 1,
    updatedAt: now,
  }
  if (changes.pendingMessage === undefined && Object.hasOwn(changes, 'pendingMessage')) {
    delete (candidate as { pendingMessage?: TeamPendingMessage }).pendingMessage
  }
  if (changes.reason === undefined && Object.hasOwn(changes, 'reason')) {
    delete (candidate as { reason?: string }).reason
  }
  if (changes.lastError === undefined && Object.hasOwn(changes, 'lastError')) {
    delete (candidate as { lastError?: string }).lastError
  }
  return checked(candidate)
}
