import { describe, expect, it } from 'vitest'
import {
  assertNotificationTransition,
  beginNotificationAttempt,
  completionNotificationPayloadSchema,
  deliverNotification,
  failNotification,
  NOTIFICATION_STATE_VERSION,
  notificationAuditRecordSchema,
  notificationIdentity,
  notificationPayloadSha256,
  notificationReasonCode,
  notificationSnapshotSchema,
  NotificationStateError,
  prepareNotification,
  retryNotification,
} from '../../src/notification-state.ts'
import type {
  CompletionNotificationEvent,
  CompletionNotificationPayload,
  NotificationAuditRecord,
  NotificationOperation,
  NotificationSnapshot,
} from '../../src/notification-state.ts'

function payload(
  phase: CompletionNotificationEvent = 'completed',
): CompletionNotificationPayload {
  return {
    objectiveSha256: 'a'.repeat(64),
    objectiveSha256Source: 'goal-objective',
    phase,
    reasonCode: notificationReasonCode(phase),
    usage: {
      verificationAttempts: 2,
      dynamicPackages: 1,
      subagentsStarted: 3,
    },
  }
}

function initial(
  phase: CompletionNotificationEvent = 'completed',
  overrides: Partial<Parameters<typeof prepareNotification>[0]> = {},
): NotificationSnapshot {
  return prepareNotification({
    sessionId: 'session',
    runId: 'run',
    generation: 2,
    runRevision: 9,
    event: phase,
    policySha256: 'b'.repeat(64),
    payload: payload(phase),
    maxAttempts: 3,
    maxPendingNotifications: 8,
    maxAuditRecords: 7,
    maxAuditBytes: 100_000,
    ...overrides,
  }, 100)
}

function record(
  operation: NotificationOperation,
  snapshot: NotificationSnapshot,
): NotificationAuditRecord {
  return {
    version: NOTIFICATION_STATE_VERSION,
    operation,
    time: snapshot.updatedAt,
    snapshot,
  }
}

describe('completion notification state', () => {
  it('builds a strict secret-free payload and stable event identity', () => {
    for (const [phase, reasonCode] of [
      ['completed', 'run-completed'],
      ['needs-attention', 'human-attention-required'],
      ['exhausted', 'active-time-exhausted'],
      ['revoked', 'run-revoked'],
    ] as const) {
      expect(notificationReasonCode(phase)).toBe(reasonCode)
      expect(completionNotificationPayloadSchema.parse(payload(phase))).toEqual(payload(phase))
    }
    const first = initial()
    expect(first).toMatchObject({
      revision: 1,
      phase: 'pending',
      attempts: 0,
      nextAttemptAt: 100,
      payloadSha256: notificationPayloadSha256(payload()),
    })
    expect(first.notificationId).toBe(notificationIdentity(first))
    const laterRevision = { ...first, runRevision: 999 }
    expect(notificationIdentity(laterRevision)).toBe(first.notificationId)
    expect(Object.keys(first.payload).sort()).toEqual([
      'objectiveSha256', 'objectiveSha256Source', 'phase', 'reasonCode', 'usage',
    ])
    expect(JSON.stringify(first.payload)).not.toMatch(/plain objective|prompt|evidence|hostCode|credential/u)
    const { objectiveSha256Source: _source, ...legacyPayload } = payload()
    expect(completionNotificationPayloadSchema.parse(legacyPayload)).toEqual(legacyPayload)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.payload)).toBe(true)
    expect(Object.isFrozen(first.payload.usage)).toBe(true)
  })

  it('moves through durable attempt, retry, and delivery transitions', () => {
    const pending = initial()
    const sending = beginNotificationAttempt(pending, 110)
    expect(sending).toMatchObject({
      revision: 2, phase: 'sending', attempts: 1, lastAttemptAt: 110,
    })
    expect(sending.nextAttemptAt).toBeUndefined()
    assertNotificationTransition(undefined, record('enqueue', pending))
    assertNotificationTransition(pending, record('attempt', sending))

    const waiting = retryNotification(sending, 'transport-error', 130, 120)
    expect(waiting).toMatchObject({
      revision: 3, phase: 'retry-wait', attempts: 1,
      nextAttemptAt: 130, lastFailureCode: 'transport-error',
    })
    assertNotificationTransition(sending, record('retry', waiting))

    const retrying = beginNotificationAttempt(waiting, 130)
    expect(retrying).toMatchObject({ revision: 4, phase: 'sending', attempts: 2 })
    expect(retrying.lastFailureCode).toBeUndefined()
    assertNotificationTransition(waiting, record('attempt', retrying))
    const delivered = deliverNotification(retrying, 140)
    expect(delivered).toMatchObject({ revision: 5, phase: 'delivered', deliveredAt: 140 })
    assertNotificationTransition(retrying, record('deliver', delivered))
  })

  it('supports fixed terminal failures before, during, and after a retry wait', () => {
    const pending = initial()
    const failedPending = failNotification(pending, 'policy-drift', 101)
    assertNotificationTransition(pending, record('fail', failedPending))
    expect(failedPending).toMatchObject({ phase: 'failed', failedAt: 101, attempts: 0 })

    const sending = beginNotificationAttempt(initial(), 110)
    const failedSending = failNotification(sending, 'timeout', 120)
    assertNotificationTransition(sending, record('fail', failedSending))
    expect(failedSending.lastAttemptAt).toBe(110)

    const waiting = retryNotification(sending, 'service-stopped', 130, 120)
    const failedWaiting = failNotification(waiting, 'attempt-limit', 131)
    assertNotificationTransition(waiting, record('fail', failedWaiting))
    expect(failedWaiting.nextAttemptAt).toBeUndefined()

    const crashRetry = beginNotificationAttempt(sending, 121)
    assertNotificationTransition(sending, record('attempt', crashRetry))
    expect(crashRetry.attempts).toBe(2)
  })

  it('rejects invalid mutation requests and transition histories', () => {
    const pending = initial()
    const sending = beginNotificationAttempt(pending, 110)
    const waiting = retryNotification(sending, 'transport-error', 130, 120)
    const delivered = deliverNotification(sending, 120)
    const failed = failNotification(pending, 'policy-drift', 110)

    expect(() => beginNotificationAttempt(delivered, 130)).toThrow(NotificationStateError)
    expect(() => beginNotificationAttempt({ ...sending, attempts: 3 }, 130)).toThrow(NotificationStateError)
    expect(() => retryNotification(pending, 'timeout', 130, 120)).toThrow(NotificationStateError)
    expect(() => retryNotification({ ...sending, attempts: 3 }, 'timeout', 130, 120))
      .toThrow(NotificationStateError)
    expect(() => retryNotification(sending, 'timeout', 119, 120)).toThrow(NotificationStateError)
    expect(() => deliverNotification(waiting, 140)).toThrow(NotificationStateError)
    expect(() => failNotification(delivered, 'attempt-limit', 140)).toThrow(NotificationStateError)
    expect(() => failNotification(failed, 'attempt-limit', 140)).toThrow(NotificationStateError)

    expect(() => assertNotificationTransition(undefined, record('attempt', pending)))
      .toThrow(/begin with/u)
    expect(() => assertNotificationTransition(undefined, { ...record('enqueue', pending), time: 999 }))
      .toThrow(/time/u)
    expect(() => assertNotificationTransition(pending, record('attempt', {
      ...sending, policySha256: 'c'.repeat(64),
    }))).toThrow(/immutable/u)
    expect(() => assertNotificationTransition(pending, record('attempt', {
      ...sending, revision: 8,
    }))).toThrow(/revision/u)
    expect(() => assertNotificationTransition(pending, record('attempt', {
      ...sending, updatedAt: 99,
    }))).toThrow(/precedes|revision/u)
    const laterSending = { ...sending, updatedAt: 200 }
    const earlierDelivery = { ...deliverNotification(sending, 150), updatedAt: 150, deliveredAt: 150 }
    expect(() => assertNotificationTransition(laterSending, record('deliver', earlierDelivery)))
      .toThrow(/revision or time/u)
    expect(() => assertNotificationTransition(pending, record('deliver', {
      ...sending, attempts: 2,
    }))).toThrow(/attempt/u)
    expect(() => assertNotificationTransition(delivered, record('deliver', {
      ...delivered, revision: delivered.revision + 1, updatedAt: 130, deliveredAt: 130,
    }))).toThrow(/terminal/u)
    const retryWithoutSending: NotificationSnapshot = {
      ...waiting,
      revision: 2,
      attempts: 0,
      updatedAt: 101,
      lastAttemptAt: undefined,
    }
    expect(() => assertNotificationTransition(pending, record('retry', retryWithoutSending)))
      .toThrow(/cannot follow/u)
    expect(() => assertNotificationTransition(pending, record('enqueue', {
      ...pending, revision: 2, updatedAt: 101,
    }))).toThrow(/cannot produce/u)
    const attemptWithoutIncrement = {
      ...beginNotificationAttempt(waiting, 130),
      attempts: waiting.attempts,
    }
    expect(() => assertNotificationTransition(waiting, record('attempt', attemptWithoutIncrement)))
      .toThrow(/invalid attempt/u)
  })

  it('rejects every inconsistent snapshot relationship at the storage boundary', () => {
    const pending = initial()
    const sending = beginNotificationAttempt(pending, 110)
    const delivered = deliverNotification(sending, 120)
    const failed = failNotification(sending, 'transport-error', 120)
    const invalid: NotificationSnapshot[] = [
      { ...pending, updatedAt: 99 },
      { ...pending, attempts: 4, lastAttemptAt: 100 },
      { ...pending, revision: 8 },
      { ...pending, event: 'revoked' },
      { ...pending, payload: { ...pending.payload, usage: { ...pending.payload.usage, dynamicPackages: 9 } } },
      { ...pending, notificationId: `notification-${'f'.repeat(64)}` },
      { ...pending, nextAttemptAt: undefined },
      { ...pending, lastAttemptAt: 100 },
      { ...pending, deliveredAt: 100 },
      { ...pending, failedAt: 100, lastFailureCode: 'timeout' },
      { ...pending, lastFailureCode: 'timeout' },
      { ...sending, attempts: 0, lastAttemptAt: undefined },
      { ...sending, updatedAt: 109 },
      { ...delivered, deliveredAt: undefined },
      { ...delivered, deliveredAt: 119 },
      { ...failed, failedAt: undefined },
      { ...failed, failedAt: 119 },
      { ...failed, lastFailureCode: undefined },
    ]
    for (const snapshot of invalid) {
      expect(notificationSnapshotSchema.safeParse(snapshot).success).toBe(false)
    }
    expect(completionNotificationPayloadSchema.safeParse({
      ...payload(), reasonCode: 'run-revoked',
    }).success).toBe(false)
    expect(completionNotificationPayloadSchema.safeParse({
      ...payload(), objectiveSha256Source: 'unknown-source',
    }).success).toBe(false)
    expect(completionNotificationPayloadSchema.safeParse({ ...payload(), prompt: 'secret' }).success).toBe(false)
    expect(notificationAuditRecordSchema.safeParse({ ...record('enqueue', pending), extra: true }).success).toBe(false)
  })
})
