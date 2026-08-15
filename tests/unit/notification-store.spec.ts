import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  beginNotificationAttempt,
  deliverNotification,
  failNotification,
  NOTIFICATION_STATE_VERSION,
  notificationReasonCode,
  prepareNotification,
  retryNotification,
} from '../../src/notification-state.ts'
import type {
  CompletionNotificationEvent,
  NotificationAuditRecord,
  NotificationOperation,
  NotificationSnapshot,
} from '../../src/notification-state.ts'
import {
  DurableNotificationStore,
  foldNotificationAudit,
  notificationAuditKey,
  notificationAuditRecordBytes,
  notificationStoreDomainSpec,
  NotificationStoreError,
} from '../../src/notification-store.ts'
import { createStorageHarness } from '../helpers.ts'

function initial(
  suffix = 'one',
  now = 100,
  overrides: Partial<Parameters<typeof prepareNotification>[0]> = {},
): NotificationSnapshot {
  const event: CompletionNotificationEvent = overrides.event ?? 'completed'
  return prepareNotification({
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    generation: 1,
    runRevision: 4,
    event,
    policySha256: 'a'.repeat(64),
    payload: {
      objectiveSha256: 'b'.repeat(64),
      phase: event,
      reasonCode: notificationReasonCode(event),
      usage: { verificationAttempts: 1, dynamicPackages: 2, subagentsStarted: 3 },
    },
    maxAttempts: 3,
    maxPendingNotifications: 8,
    maxAuditRecords: 7,
    maxAuditBytes: 100_000,
    ...overrides,
  }, now)
}

function audit(
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

describe('durable completion-notification store', () => {
  it('persists idempotent events, compare-and-set revisions, filters, and restart state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-notification-store-'))
    try {
      const firstHarness = await createStorageHarness(root)
      const store = await DurableNotificationStore.open(firstHarness.ctx)
      const pending = initial()
      expect(await store.enqueue(pending)).toEqual(pending)
      expect(await store.enqueue({
        ...pending,
        runRevision: 99,
        policySha256: 'c'.repeat(64),
      })).toEqual(pending)
      expect(store.get(pending.notificationId)).toEqual(pending)
      expect(store.get('missing')).toBeUndefined()

      const sending = beginNotificationAttempt(pending, 110)
      expect(await store.appendIfCurrent('attempt', pending, sending)).toEqual(sending)
      expect(await store.appendIfCurrent('attempt', pending, sending)).toBeUndefined()
      const waiting = retryNotification(sending, 'transport-error', 130, 120)
      await store.appendIfCurrent('retry', sending, waiting)
      const retrying = beginNotificationAttempt(waiting, 130)
      await store.appendIfCurrent('attempt', waiting, retrying)
      const delivered = deliverNotification(retrying, 140)
      await store.appendIfCurrent('deliver', retrying, delivered)

      const attention = initial('attention', 100, { event: 'needs-attention' })
      await store.enqueue(attention)
      const failed = failNotification(attention, 'policy-drift', 102)
      await store.appendIfCurrent('fail', attention, failed)

      expect(store.list().map(item => item.notificationId)).toEqual([
        pending.notificationId,
        attention.notificationId,
      ])
      expect(store.list({ sessionId: 'missing' })).toEqual([])
      expect(store.list({ runId: 'missing' })).toEqual([])
      expect(store.list({ generation: 2 })).toEqual([])
      expect(store.list({ event: 'revoked' })).toEqual([])
      expect(store.list({ active: true })).toEqual([])
      expect(store.list({ active: false })).toHaveLength(2)
      expect(store.history(pending.notificationId).map(item => item.operation))
        .toEqual(['enqueue', 'attempt', 'retry', 'attempt', 'deliver'])
      expect(store.history('missing')).toEqual([])
      expect(notificationAuditKey(pending)).toMatch(/\.000000000001$/u)
      expect(notificationAuditRecordBytes(audit('enqueue', pending))).toBeGreaterThan(0)

      await store.close()
      await firstHarness.ctx.fiber.dispose()
      const secondHarness = await createStorageHarness(root)
      const reopened = await DurableNotificationStore.open(secondHarness.ctx)
      expect(reopened.get(pending.notificationId)).toEqual(delivered)
      expect(reopened.get(attention.notificationId)).toEqual(failed)
      expect(reopened.history()).toHaveLength(7)
      await reopened.close()
      await secondHarness.ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('contains saturation, identity collision, duplicate key, and write failure', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableNotificationStore.open(ctx)
    const only = initial('only', 100, { maxPendingNotifications: 1 })
    await store.enqueue(only)
    await expect(store.enqueue(initial('overflow', 101, { maxPendingNotifications: 1 })))
      .rejects.toThrow(/active items/u)
    await expect(store.enqueue({
      ...only,
      payloadSha256: 'f'.repeat(64),
    })).rejects.toBeInstanceOf(NotificationStoreError)

    const internals = store as unknown as {
      events: {
        get(key: string): NotificationAuditRecord | undefined
        put(key: string, value: NotificationAuditRecord): Promise<void>
      }
    }
    const disk = initial('disk', 102, { maxPendingNotifications: 2 })
    vi.spyOn(internals.events, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.enqueue(disk)).rejects.toThrow('disk full')
    expect(store.get(disk.notificationId)).toBeUndefined()
    expect(store.history()).toHaveLength(1)

    const duplicate = initial('duplicate', 103, { maxPendingNotifications: 2 })
    await internals.events.put(notificationAuditKey(duplicate), audit('enqueue', duplicate))
    await expect(store.enqueue(duplicate)).rejects.toThrow(/already exists/u)
    expect(store.get(duplicate.notificationId)).toBeUndefined()
    await store.close()
    await ctx.fiber.dispose()
  })

  it('enforces per-item whole-history record and byte ceilings atomically', async () => {
    const recordsHarness = await createStorageHarness()
    const recordsStore = await DurableNotificationStore.open(recordsHarness.ctx)
    const recordLimited = initial('record-limit', 100, { maxAuditRecords: 1 })
    await recordsStore.enqueue(recordLimited)
    await expect(recordsStore.appendIfCurrent(
      'attempt',
      recordLimited,
      { ...beginNotificationAttempt({ ...recordLimited, maxAuditRecords: 2 }, 110), maxAuditRecords: 1 },
    )).rejects.toThrow()
    expect(recordsStore.get(recordLimited.notificationId)).toEqual(recordLimited)
    await recordsStore.close()
    await recordsHarness.ctx.fiber.dispose()

    const byteHarness = await createStorageHarness()
    const byteStore = await DurableNotificationStore.open(byteHarness.ctx)
    const probe = initial('byte-limit')
    const firstBytes = notificationAuditRecordBytes(audit('enqueue', probe))
    const byteLimited = initial('byte-limit', 100, { maxAuditBytes: firstBytes })
    await byteStore.enqueue(byteLimited)
    const sending = beginNotificationAttempt(byteLimited, 110)
    await expect(byteStore.appendIfCurrent('attempt', byteLimited, sending))
      .rejects.toThrow(/audit bytes/u)
    expect(byteStore.get(byteLimited.notificationId)).toEqual(byteLimited)
    await byteStore.close()
    await byteHarness.ctx.fiber.dispose()
  })

  it('rejects malformed cold history, saturation, and aggregate audit overflow', async () => {
    const first = initial('first', 100, { maxPendingNotifications: 1 })
    const second = initial('second', 101, { maxPendingNotifications: 1 })
    expect(() => foldNotificationAudit([audit('enqueue', first), audit('enqueue', second)]))
      .toThrow(/exceeded/u)

    const probe = initial('bytes')
    const firstBytes = notificationAuditRecordBytes(audit('enqueue', probe))
    const byteLimited = initial('bytes', 100, { maxAuditBytes: firstBytes })
    const sending = beginNotificationAttempt(byteLimited, 110)
    expect(() => foldNotificationAudit([
      audit('enqueue', byteLimited), audit('attempt', sending),
    ])).toThrow(/audit bytes/u)

    const recordLimited = initial('records', 100, { maxAuditRecords: 1 })
    const recordSending = {
      ...beginNotificationAttempt({ ...recordLimited, maxAuditRecords: 2 }, 110),
      maxAuditRecords: 1,
    }
    expect(() => foldNotificationAudit([
      audit('enqueue', recordLimited), audit('attempt', recordSending),
    ])).toThrow()

    const sameTime = initial('same-time', 200)
    const sameTimeSending = beginNotificationAttempt(sameTime, 200)
    expect(foldNotificationAudit([
      audit('attempt', sameTimeSending), audit('enqueue', sameTime),
    ]).history.map(item => item.operation)).toEqual(['enqueue', 'attempt'])
  })

  it('closes a newly opened domain when table construction or folding fails', async () => {
    const { ctx } = await createStorageHarness()
    const close = vi.fn(async () => {})
    vi.spyOn(ctx.storageDomain, 'open').mockResolvedValueOnce({
      table() { throw new Error('table unavailable') },
      close,
    } as never)
    await expect(DurableNotificationStore.open(ctx)).rejects.toThrow('table unavailable')
    expect(close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()

    const corrupt = await createStorageHarness()
    const domain = await corrupt.ctx.storageDomain.open(notificationStoreDomainSpec)
    const pending = initial('corrupt')
    await domain.table('events').put(notificationAuditKey(pending), {
      ...audit('enqueue', pending), time: 999,
    })
    await domain.close()
    await expect(DurableNotificationStore.open(corrupt.ctx)).rejects.toThrow(/time/u)
    await corrupt.ctx.fiber.dispose()
  })
})
