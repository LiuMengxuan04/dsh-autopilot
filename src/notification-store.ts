/** Append-only storage-domain provider for completion-notification outbox state. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assertNotificationTransition,
  NOTIFICATION_STATE_VERSION,
  notificationAuditRecordSchema,
} from './notification-state.ts'
import type {
  CompletionNotificationEvent,
  NotificationAuditRecord,
  NotificationOperation,
  NotificationSnapshot,
} from './notification-state.ts'

/** Storage declaration for immutable notification revisions. */
export const notificationStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot_notifications',
  version: NOTIFICATION_STATE_VERSION,
  tables: {
    events: domainTable<string, NotificationAuditRecord>(notificationAuditRecordSchema),
  },
})

/** Durable outbox conflict or materialized-limit failure. */
export class NotificationStoreError extends Error {
  /** Machine-readable failure classification. */
  readonly code = 'AUTOPILOT_NOTIFICATION_STORE_INVALID' as const

  /** @param message - Exact persistence failure. */
  constructor(message: string) {
    super(message)
    this.name = 'NotificationStoreError'
  }
}

/** UTF-8 JSON usage retained for one notification audit history. */
export interface NotificationAuditUsage {
  readonly records: number
  readonly bytes: number
}

/** Stable storage key for one immutable notification revision. */
export function notificationAuditKey(snapshot: NotificationSnapshot): string {
  return `${snapshot.notificationId}.${String(snapshot.revision).padStart(12, '0')}`
}

/** Exact UTF-8 bytes charged for one immutable whole-snapshot row. */
export function notificationAuditRecordBytes(record: NotificationAuditRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function compareRecords(left: NotificationAuditRecord, right: NotificationAuditRecord): number {
  return left.time - right.time
    || left.snapshot.notificationId.localeCompare(right.snapshot.notificationId)
    || left.snapshot.revision - right.snapshot.revision
}

function isActive(snapshot: NotificationSnapshot): boolean {
  return snapshot.phase === 'pending' || snapshot.phase === 'sending' || snapshot.phase === 'retry-wait'
}

function sameLogicalNotification(left: NotificationSnapshot, right: NotificationSnapshot): boolean {
  return left.notificationId === right.notificationId
    && left.sessionId === right.sessionId
    && left.runId === right.runId
    && left.generation === right.generation
    && left.event === right.event
    && left.payloadSha256 === right.payloadSha256
}

function assertUsage(snapshot: NotificationSnapshot, usage: NotificationAuditUsage): void {
  if (usage.bytes > snapshot.maxAuditBytes) {
    throw new NotificationStoreError(
      `notification "${snapshot.notificationId}" exceeded ${snapshot.maxAuditBytes} audit bytes`,
    )
  }
}

/** Fold complete durable history into current outbox rows and exact usage. */
export function foldNotificationAudit(records: readonly NotificationAuditRecord[]): {
  readonly current: ReadonlyMap<string, NotificationSnapshot>
  readonly history: readonly NotificationAuditRecord[]
  readonly usage: ReadonlyMap<string, NotificationAuditUsage>
} {
  const ordered = [...records].sort(compareRecords)
  const current = new Map<string, NotificationSnapshot>()
  const usage = new Map<string, NotificationAuditUsage>()
  for (const record of ordered) {
    const id = record.snapshot.notificationId
    const previous = current.get(id)
    assertNotificationTransition(previous, record)
    const priorUsage = usage.get(id) ?? { records: 0, bytes: 0 }
    const nextUsage = Object.freeze({
      records: priorUsage.records + 1,
      bytes: priorUsage.bytes + notificationAuditRecordBytes(record),
    })
    assertUsage(record.snapshot, nextUsage)
    if (previous === undefined && isActive(record.snapshot)) {
      const activeCount = [...current.values()].filter(isActive).length + 1
      if (activeCount > record.snapshot.maxPendingNotifications) {
        throw new NotificationStoreError(
          `notification outbox exceeded ${record.snapshot.maxPendingNotifications} active items`,
        )
      }
    }
    usage.set(id, nextUsage)
    current.set(id, record.snapshot)
  }
  return Object.freeze({
    current,
    history: Object.freeze(ordered),
    usage,
  })
}

/** Serialized compare-and-append completion-notification outbox. */
export class DurableNotificationStore {
  private readonly current = new Map<string, NotificationSnapshot>()
  private readonly usage = new Map<string, NotificationAuditUsage>()
  private historyRecords: readonly NotificationAuditRecord[] = Object.freeze([])
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof notificationStoreDomainSpec>,
    private readonly events: KvTable<string, NotificationAuditRecord>,
  ) {}

  /** Open and validate the complete notification domain before reads. */
  static async open(ctx: Context): Promise<DurableNotificationStore> {
    const domain = await ctx.storageDomain.open(notificationStoreDomainSpec)
    try {
      const events = domain.table('events')
      const store = new DurableNotificationStore(domain, events)
      store.rebuild([...events.entries()].map(([, record]) => record))
      return store
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
  }

  /** Read one current notification by deterministic id. */
  get(notificationId: string): NotificationSnapshot | undefined {
    return this.current.get(notificationId)
  }

  /** List current rows in stable creation and identity order. */
  list(filter: {
    readonly sessionId?: string
    readonly runId?: string
    readonly generation?: number
    readonly event?: CompletionNotificationEvent
    readonly active?: boolean
  } = {}): readonly NotificationSnapshot[] {
    return Object.freeze([...this.current.values()]
      .filter(snapshot => (filter.sessionId === undefined || snapshot.sessionId === filter.sessionId)
        && (filter.runId === undefined || snapshot.runId === filter.runId)
        && (filter.generation === undefined || snapshot.generation === filter.generation)
        && (filter.event === undefined || snapshot.event === filter.event)
        && (filter.active === undefined || isActive(snapshot) === filter.active))
      .sort((left, right) => left.createdAt - right.createdAt
        || left.notificationId.localeCompare(right.notificationId)))
  }

  /** Return immutable audit history, optionally narrowed to one notification. */
  history(notificationId?: string): readonly NotificationAuditRecord[] {
    return notificationId === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record => record.snapshot.notificationId === notificationId))
  }

  /**
   * Persist the first pending row, or return the canonical matching row when
   * crash reconciliation observes the same run event again.
   */
  enqueue(snapshot: NotificationSnapshot): Promise<NotificationSnapshot> {
    return this.serialized(async () => {
      const current = this.current.get(snapshot.notificationId)
      if (current !== undefined) {
        if (!sameLogicalNotification(current, snapshot)) {
          throw new NotificationStoreError(
            `notification id "${snapshot.notificationId}" identifies different payload data`,
          )
        }
        return current
      }
      const activeCount = [...this.current.values()].filter(isActive).length
      if (activeCount >= snapshot.maxPendingNotifications) {
        throw new NotificationStoreError(
          `notification outbox reached ${snapshot.maxPendingNotifications} active items`,
        )
      }
      return this.appendSerialized('enqueue', snapshot)
    })
  }

  /** Append only while the caller-observed revision remains current. */
  appendIfCurrent(
    operation: Exclude<NotificationOperation, 'enqueue'>,
    expected: Pick<NotificationSnapshot, 'notificationId' | 'revision'>,
    snapshot: NotificationSnapshot,
  ): Promise<NotificationSnapshot | undefined> {
    return this.serialized(() => {
      const current = this.current.get(expected.notificationId)
      if (current === undefined || current.revision !== expected.revision) {
        return Promise.resolve(undefined)
      }
      return this.appendSerialized(operation, snapshot)
    })
  }

  /** Drain pending writes and close the owned storage domain. */
  async close(): Promise<void> {
    await this.writeTail
    await this.domain.close()
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async appendSerialized(
    operation: NotificationOperation,
    snapshot: NotificationSnapshot,
  ): Promise<NotificationSnapshot> {
    const previous = this.current.get(snapshot.notificationId)
    const record: NotificationAuditRecord = Object.freeze({
      version: NOTIFICATION_STATE_VERSION,
      operation,
      time: snapshot.updatedAt,
      snapshot,
    })
    assertNotificationTransition(previous, record)
    const priorUsage = this.usage.get(snapshot.notificationId) ?? { records: 0, bytes: 0 }
    const nextUsage = Object.freeze({
      records: priorUsage.records + 1,
      bytes: priorUsage.bytes + notificationAuditRecordBytes(record),
    })
    assertUsage(snapshot, nextUsage)
    const key = notificationAuditKey(snapshot)
    if (this.events.get(key) !== undefined) {
      throw new NotificationStoreError(`notification audit key "${key}" already exists`)
    }
    await this.events.put(key, record)
    this.current.set(snapshot.notificationId, snapshot)
    this.usage.set(snapshot.notificationId, nextUsage)
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareRecords))
    return snapshot
  }

  private rebuild(records: readonly NotificationAuditRecord[]): void {
    const folded = foldNotificationAudit(records)
    this.current.clear()
    this.usage.clear()
    for (const [id, snapshot] of folded.current) this.current.set(id, snapshot)
    for (const [id, value] of folded.usage) this.usage.set(id, value)
    this.historyRecords = folded.history
  }
}
