/** Durable, secret-free state for deployment-owned completion notifications. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Current storage format for completion-notification outbox records. */
export const NOTIFICATION_STATE_VERSION = 1 as const

/** Fixed Autopilot events that may be selected by a deployment allowlist. */
export type CompletionNotificationEvent =
  | 'completed'
  | 'needs-attention'
  | 'exhausted'
  | 'revoked'

/** Fixed non-sensitive reason codes delivered to a webhook. */
export type CompletionNotificationReasonCode =
  | 'run-completed'
  | 'human-attention-required'
  | 'active-time-exhausted'
  | 'run-revoked'

/** Stable run-usage counters safe to disclose to a deployment webhook. */
export interface CompletionNotificationUsage {
  readonly verificationAttempts: number
  readonly dynamicPackages: number
  readonly subagentsStarted: number
}

/** Source material represented by the notification's irreversible objective reference. */
export type CompletionNotificationObjectiveSha256Source =
  | 'goal-objective'
  | 'durable-goal-id-fallback'

/**
 * Complete webhook body. It intentionally excludes objectives, prompts,
 * evidence, Host source, credentials, free-form reasons, and run identifiers.
 */
export interface CompletionNotificationPayload {
  readonly objectiveSha256: string
  /**
   * Material hashed into `objectiveSha256`. Omission identifies a legacy
   * `goal-objective` row written before the source field was introduced.
   */
  readonly objectiveSha256Source?: CompletionNotificationObjectiveSha256Source | undefined
  readonly phase: CompletionNotificationEvent
  readonly reasonCode: CompletionNotificationReasonCode
  readonly usage: CompletionNotificationUsage
}

/** Durable outbox delivery lifecycle. */
export type NotificationDeliveryPhase =
  | 'pending'
  | 'sending'
  | 'retry-wait'
  | 'delivered'
  | 'failed'

/** Fixed local delivery failures that cannot contain transport response data. */
export type NotificationFailureCode =
  | 'transport-error'
  | 'timeout'
  | 'service-stopped'
  | 'policy-drift'
  | 'attempt-limit'

/** One complete immutable post-mutation notification snapshot. */
export interface NotificationSnapshot {
  readonly version: typeof NOTIFICATION_STATE_VERSION
  readonly notificationId: string
  readonly sessionId: string
  readonly runId: string
  readonly generation: number
  readonly runRevision: number
  readonly event: CompletionNotificationEvent
  readonly revision: number
  readonly policySha256: string
  readonly payload: CompletionNotificationPayload
  readonly payloadSha256: string
  readonly phase: NotificationDeliveryPhase
  readonly attempts: number
  readonly maxAttempts: number
  readonly maxPendingNotifications: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly nextAttemptAt?: number | undefined
  readonly lastAttemptAt?: number | undefined
  readonly deliveredAt?: number | undefined
  readonly failedAt?: number | undefined
  readonly lastFailureCode?: NotificationFailureCode | undefined
}

/** Append-only notification mutation vocabulary. */
export type NotificationOperation = 'enqueue' | 'attempt' | 'retry' | 'deliver' | 'fail'

/** One immutable outbox audit row. */
export interface NotificationAuditRecord {
  readonly version: typeof NOTIFICATION_STATE_VERSION
  readonly operation: NotificationOperation
  readonly time: number
  readonly snapshot: NotificationSnapshot
}

/** Stable notification-state validation failure. */
export class NotificationStateError extends Error {
  /** Machine-readable failure classification. */
  readonly code = 'AUTOPILOT_NOTIFICATION_STATE_INVALID' as const

  /** @param message - Exact failed durable invariant. */
  constructor(message: string) {
    super(message)
    this.name = 'NotificationStateError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const NOTIFICATION_ID_PATTERN = /^notification-[a-f0-9]{64}$/u
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const safeTime = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Runtime schema for the only body accepted by the webhook transport. */
export const completionNotificationPayloadSchema: z.ZodType<CompletionNotificationPayload> = z.object({
  objectiveSha256: z.string().regex(SHA256_PATTERN),
  objectiveSha256Source: z.enum([
    'goal-objective',
    'durable-goal-id-fallback',
  ]).optional(),
  phase: z.enum(['completed', 'needs-attention', 'exhausted', 'revoked']),
  reasonCode: z.enum([
    'run-completed',
    'human-attention-required',
    'active-time-exhausted',
    'run-revoked',
  ]),
  usage: z.object({
    verificationAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    dynamicPackages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    subagentsStarted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict().superRefine((payload, context) => {
  if (notificationReasonCode(payload.phase) !== payload.reasonCode) {
    context.addIssue({ code: 'custom', message: 'notification phase and reason code disagree' })
  }
})

/** Runtime and storage validation for one complete outbox snapshot. */
export const notificationSnapshotSchema: z.ZodType<NotificationSnapshot> = z.object({
  version: z.literal(NOTIFICATION_STATE_VERSION),
  notificationId: z.string().regex(NOTIFICATION_ID_PATTERN),
  sessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  generation: positive,
  runRevision: positive,
  event: z.enum(['completed', 'needs-attention', 'exhausted', 'revoked']),
  revision: positive,
  policySha256: z.string().regex(SHA256_PATTERN),
  payload: completionNotificationPayloadSchema,
  payloadSha256: z.string().regex(SHA256_PATTERN),
  phase: z.enum(['pending', 'sending', 'retry-wait', 'delivered', 'failed']),
  attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxAttempts: positive,
  maxPendingNotifications: positive,
  maxAuditRecords: positive,
  maxAuditBytes: positive,
  createdAt: safeTime,
  updatedAt: safeTime,
  nextAttemptAt: safeTime.optional(),
  lastAttemptAt: safeTime.optional(),
  deliveredAt: safeTime.optional(),
  failedAt: safeTime.optional(),
  lastFailureCode: z.enum([
    'transport-error',
    'timeout',
    'service-stopped',
    'policy-drift',
    'attempt-limit',
  ]).optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.updatedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', message: 'notification updatedAt precedes createdAt' })
  }
  if (snapshot.attempts > snapshot.maxAttempts) {
    context.addIssue({ code: 'custom', message: 'notification attempts exceed their materialized limit' })
  }
  if (snapshot.revision > snapshot.maxAuditRecords) {
    context.addIssue({ code: 'custom', message: 'notification revisions exceed their materialized limit' })
  }
  if (snapshot.event !== snapshot.payload.phase) {
    context.addIssue({ code: 'custom', message: 'notification event and payload phase disagree' })
  }
  if (notificationPayloadSha256(snapshot.payload) !== snapshot.payloadSha256) {
    context.addIssue({ code: 'custom', message: 'notification payload hash does not match its body' })
  }
  if (notificationIdentity(snapshot) !== snapshot.notificationId) {
    context.addIssue({ code: 'custom', message: 'notification id does not match its run event identity' })
  }
  const waiting = snapshot.phase === 'pending' || snapshot.phase === 'retry-wait'
  if (waiting !== (snapshot.nextAttemptAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'only waiting notifications carry nextAttemptAt' })
  }
  if ((snapshot.attempts > 0) !== (snapshot.lastAttemptAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'attempt time must match whether delivery was attempted' })
  }
  if (snapshot.lastAttemptAt !== undefined && snapshot.lastAttemptAt > snapshot.updatedAt) {
    context.addIssue({ code: 'custom', message: 'notification lastAttemptAt exceeds updatedAt' })
  }
  if ((snapshot.phase === 'delivered') !== (snapshot.deliveredAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'only delivered notifications carry deliveredAt' })
  }
  if (snapshot.deliveredAt !== undefined && snapshot.deliveredAt !== snapshot.updatedAt) {
    context.addIssue({ code: 'custom', message: 'notification deliveredAt must equal updatedAt' })
  }
  if ((snapshot.phase === 'failed') !== (snapshot.failedAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'only failed notifications carry failedAt' })
  }
  if (snapshot.failedAt !== undefined && snapshot.failedAt !== snapshot.updatedAt) {
    context.addIssue({ code: 'custom', message: 'notification failedAt must equal updatedAt' })
  }
  const failureExpected = snapshot.phase === 'retry-wait' || snapshot.phase === 'failed'
  if (failureExpected !== (snapshot.lastFailureCode !== undefined)) {
    context.addIssue({ code: 'custom', message: 'retrying and failed notifications require a fixed failure code' })
  }
  if (snapshot.phase === 'sending' && snapshot.attempts === 0) {
    context.addIssue({ code: 'custom', message: 'sending notification has no recorded attempt' })
  }
})

/** Runtime and storage validation for one immutable outbox audit row. */
export const notificationAuditRecordSchema: z.ZodType<NotificationAuditRecord> = z.object({
  version: z.literal(NOTIFICATION_STATE_VERSION),
  operation: z.enum(['enqueue', 'attempt', 'retry', 'deliver', 'fail']),
  time: safeTime,
  snapshot: notificationSnapshotSchema,
}).strict()

/** Return the fixed safe reason for one allowlisted event. */
export function notificationReasonCode(
  event: CompletionNotificationEvent,
): CompletionNotificationReasonCode {
  switch (event) {
    case 'completed': return 'run-completed'
    case 'needs-attention': return 'human-attention-required'
    case 'exhausted': return 'active-time-exhausted'
    case 'revoked': return 'run-revoked'
  }
}

/** Stable event id; a run generation emits each fixed event at most once. */
export function notificationIdentity(
  value: Pick<NotificationSnapshot, 'sessionId' | 'runId' | 'generation' | 'event'>,
): string {
  const material = `${value.sessionId}\u0000${value.runId}\u0000${value.generation}\u0000${value.event}`
  return `notification-${createHash('sha256').update(material).digest('hex')}`
}

/** Hash the strict safe webhook body using its fixed property order. */
export function notificationPayloadSha256(payload: CompletionNotificationPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** Input for constructing the first durable outbox revision. */
export interface PrepareNotificationInput {
  readonly sessionId: string
  readonly runId: string
  readonly generation: number
  readonly runRevision: number
  readonly event: CompletionNotificationEvent
  readonly policySha256: string
  readonly payload: CompletionNotificationPayload
  readonly maxAttempts: number
  readonly maxPendingNotifications: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
}

/** Construct and validate the first pending outbox revision. */
export function prepareNotification(
  input: PrepareNotificationInput,
  now: number,
): NotificationSnapshot {
  const notificationId = notificationIdentity(input)
  const snapshot: NotificationSnapshot = Object.freeze({
    version: NOTIFICATION_STATE_VERSION,
    notificationId,
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    runRevision: input.runRevision,
    event: input.event,
    revision: 1,
    policySha256: input.policySha256,
    payload: Object.freeze({ ...input.payload, usage: Object.freeze({ ...input.payload.usage }) }),
    payloadSha256: notificationPayloadSha256(input.payload),
    phase: 'pending',
    attempts: 0,
    maxAttempts: input.maxAttempts,
    maxPendingNotifications: input.maxPendingNotifications,
    maxAuditRecords: input.maxAuditRecords,
    maxAuditBytes: input.maxAuditBytes,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  })
  notificationSnapshotSchema.parse(snapshot)
  return snapshot
}

/** Reserve one durable attempt before invoking the external transport. */
export function beginNotificationAttempt(
  snapshot: NotificationSnapshot,
  now: number,
): NotificationSnapshot {
  if (!['pending', 'retry-wait', 'sending'].includes(snapshot.phase)
    || snapshot.attempts >= snapshot.maxAttempts) {
    throw new NotificationStateError(`notification cannot begin an attempt while ${snapshot.phase}`)
  }
  return mutate(snapshot, {
    phase: 'sending',
    attempts: snapshot.attempts + 1,
    lastAttemptAt: now,
    clearNextAttemptAt: true,
    clearFailure: true,
  }, now)
}

/** Return a failed attempt to the durable retry queue. */
export function retryNotification(
  snapshot: NotificationSnapshot,
  code: NotificationFailureCode,
  nextAttemptAt: number,
  now: number,
): NotificationSnapshot {
  if (snapshot.phase !== 'sending' || snapshot.attempts >= snapshot.maxAttempts
    || nextAttemptAt < now) {
    throw new NotificationStateError('notification cannot enter retry wait from its current state')
  }
  return mutate(snapshot, {
    phase: 'retry-wait',
    nextAttemptAt,
    lastFailureCode: code,
  }, now)
}

/** Mark a transport-confirmed attempt delivered. */
export function deliverNotification(
  snapshot: NotificationSnapshot,
  now: number,
): NotificationSnapshot {
  if (snapshot.phase !== 'sending') {
    throw new NotificationStateError(`notification cannot be delivered while ${snapshot.phase}`)
  }
  return mutate(snapshot, { phase: 'delivered', deliveredAt: now }, now)
}

/** Permanently stop delivery after a fixed local failure classification. */
export function failNotification(
  snapshot: NotificationSnapshot,
  code: NotificationFailureCode,
  now: number,
): NotificationSnapshot {
  if (!['pending', 'retry-wait', 'sending'].includes(snapshot.phase)) {
    throw new NotificationStateError(`notification cannot fail while ${snapshot.phase}`)
  }
  return mutate(snapshot, {
    phase: 'failed',
    failedAt: now,
    lastFailureCode: code,
    clearNextAttemptAt: true,
  }, now)
}

interface NotificationMutation {
  readonly phase: NotificationDeliveryPhase
  readonly attempts?: number
  readonly nextAttemptAt?: number
  readonly lastAttemptAt?: number
  readonly deliveredAt?: number
  readonly failedAt?: number
  readonly lastFailureCode?: NotificationFailureCode
  readonly clearNextAttemptAt?: boolean
  readonly clearFailure?: boolean
}

function mutate(
  snapshot: NotificationSnapshot,
  change: NotificationMutation,
  now: number,
): NotificationSnapshot {
  const next: NotificationSnapshot = Object.freeze({
    ...snapshot,
    revision: snapshot.revision + 1,
    phase: change.phase,
    attempts: change.attempts ?? snapshot.attempts,
    updatedAt: now,
    ...(change.clearNextAttemptAt === true
      ? { nextAttemptAt: undefined }
      : change.nextAttemptAt === undefined ? {} : { nextAttemptAt: change.nextAttemptAt }),
    ...(change.lastAttemptAt === undefined ? {} : { lastAttemptAt: change.lastAttemptAt }),
    ...(change.deliveredAt === undefined ? {} : { deliveredAt: change.deliveredAt }),
    ...(change.failedAt === undefined ? {} : { failedAt: change.failedAt }),
    ...(change.clearFailure === true
      ? { lastFailureCode: undefined }
      : change.lastFailureCode === undefined ? {} : { lastFailureCode: change.lastFailureCode }),
  })
  notificationSnapshotSchema.parse(next)
  return next
}

/** Validate one append against the preceding immutable revision. */
export function assertNotificationTransition(
  previous: NotificationSnapshot | undefined,
  record: NotificationAuditRecord,
): void {
  notificationAuditRecordSchema.parse(record)
  const next = record.snapshot
  if (record.time !== next.updatedAt) {
    throw new NotificationStateError('notification audit time does not match updatedAt')
  }
  if (previous === undefined) {
    if (record.operation !== 'enqueue' || next.revision !== 1 || next.phase !== 'pending'
      || next.attempts !== 0 || next.createdAt !== next.updatedAt) {
      throw new NotificationStateError('notification history must begin with a pending enqueue')
    }
    return
  }
  const immutable = [
    'notificationId',
    'sessionId',
    'runId',
    'generation',
    'runRevision',
    'event',
    'policySha256',
    'payloadSha256',
    'maxAttempts',
    'maxPendingNotifications',
    'maxAuditRecords',
    'maxAuditBytes',
    'createdAt',
  ] as const
  if (immutable.some(key => next[key] !== previous[key])
    || JSON.stringify(next.payload) !== JSON.stringify(previous.payload)) {
    throw new NotificationStateError('notification mutation changed immutable delivery data')
  }
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt) {
    throw new NotificationStateError('notification revision or time is not monotonic')
  }
  if (next.attempts < previous.attempts
    || next.attempts > previous.attempts + (record.operation === 'attempt' ? 1 : 0)) {
    throw new NotificationStateError('notification attempt count is not monotonic')
  }
  if (previous.phase === 'delivered' || previous.phase === 'failed') {
    throw new NotificationStateError(`terminal notification cannot receive ${record.operation}`)
  }
  const allowed: Readonly<Record<NotificationOperation, readonly NotificationDeliveryPhase[]>> = {
    enqueue: [],
    attempt: ['sending'],
    retry: ['retry-wait'],
    deliver: ['delivered'],
    fail: ['failed'],
  }
  if (!allowed[record.operation].includes(next.phase)) {
    throw new NotificationStateError(`operation ${record.operation} cannot produce ${next.phase}`)
  }
  const priorAllowed: Readonly<Record<Exclude<NotificationOperation, 'enqueue'>, readonly NotificationDeliveryPhase[]>> = {
    attempt: ['pending', 'retry-wait', 'sending'],
    retry: ['sending'],
    deliver: ['sending'],
    fail: ['pending', 'retry-wait', 'sending'],
  }
  if (record.operation === 'enqueue' || !priorAllowed[record.operation].includes(previous.phase)) {
    throw new NotificationStateError(`operation ${record.operation} cannot follow ${previous.phase}`)
  }
  const expectedAttempts = previous.attempts + (record.operation === 'attempt' ? 1 : 0)
  if (next.attempts !== expectedAttempts) {
    throw new NotificationStateError(`operation ${record.operation} has an invalid attempt count`)
  }
}
