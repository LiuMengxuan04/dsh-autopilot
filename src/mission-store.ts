/** Append-only storage-domain provider for sequential Autopilot missions. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assertMissionTransition,
  foldMissionAudit,
  missionAuditRecordSchema,
  missionIdentity,
  MISSION_STATE_VERSION,
} from './mission-state.ts'
import type {
  MissionAuditRecord,
  MissionOperation,
  MissionSnapshot,
} from './mission-state.ts'

/** Storage declaration for immutable mission summary revisions. */
export const missionStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot_mission',
  version: MISSION_STATE_VERSION,
  tables: {
    events: domainTable<string, MissionAuditRecord>(missionAuditRecordSchema),
  },
})

/** Stable storage or audit-ceiling failure. */
export class MissionStoreError extends Error {
  /** Machine-routable error category. */
  readonly code = 'AUTOPILOT_MISSION_STORE_INVALID' as const

  /** @param message - Exact persistence invariant that failed. */
  constructor(message: string) {
    super(message)
    this.name = 'MissionStoreError'
  }
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Unique key for one immutable mission revision. */
export function missionAuditKey(snapshot: MissionSnapshot): string {
  return [
    encoded(snapshot.parentSessionId),
    encoded(snapshot.runId),
    String(snapshot.generation).padStart(12, '0'),
    encoded(snapshot.missionId),
    String(snapshot.revision).padStart(12, '0'),
  ].join('.')
}

function auditBytes(record: MissionAuditRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

/** Serialized compare-and-append mission persistence. */
export class DurableMissionStore {
  private readonly current = new Map<string, MissionSnapshot>()
  private historyRecords: readonly MissionAuditRecord[] = Object.freeze([])
  private readonly usage = new Map<string, { readonly records: number; readonly bytes: number }>()
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof missionStoreDomainSpec>,
    private readonly events: KvTable<string, MissionAuditRecord>,
  ) {}

  /** Open and validate the complete mission ledger before serving reads. */
  static async open(ctx: Context): Promise<DurableMissionStore> {
    const domain = await ctx.storageDomain.open(missionStoreDomainSpec)
    try {
      const store = new DurableMissionStore(domain, domain.table('events'))
      store.rebuild([...store.events.entries()].map(([, record]) => record))
      return store
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
  }

  /** Read one exact mission identity. */
  get(identity: Pick<MissionSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'missionId'>):
    MissionSnapshot | undefined {
    return this.current.get(missionIdentity(identity))
  }

  /** List current summaries in stable run-generation-mission order. */
  list(filter: {
    readonly parentSessionId?: string
    readonly runId?: string
    readonly generation?: number
  } = {}): readonly MissionSnapshot[] {
    return Object.freeze([...this.current.values()]
      .filter(snapshot => (filter.parentSessionId === undefined
        || snapshot.parentSessionId === filter.parentSessionId)
        && (filter.runId === undefined || snapshot.runId === filter.runId)
        && (filter.generation === undefined || snapshot.generation === filter.generation))
      .sort((left, right) => left.parentSessionId.localeCompare(right.parentSessionId)
        || left.generation - right.generation
        || left.missionId.localeCompare(right.missionId)))
  }

  /** Return immutable append history, optionally narrowed to one parent session. */
  history(parentSessionId?: string): readonly MissionAuditRecord[] {
    return parentSessionId === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record => record.snapshot.parentSessionId === parentSessionId))
  }

  /** Append one exact post-operation mission snapshot. */
  append(operation: MissionOperation, snapshot: MissionSnapshot): Promise<MissionSnapshot> {
    return this.serialized(() => this.appendSerialized(operation, snapshot))
  }

  /** Derive a mutation from the latest revision under the write queue. */
  reduceCurrent(
    identity: Pick<MissionSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'missionId'>,
    reducer: (
      current: MissionSnapshot | undefined,
    ) => { readonly operation: MissionOperation; readonly snapshot: MissionSnapshot } | undefined,
  ): Promise<MissionSnapshot | undefined> {
    return this.serialized(() => {
      const mutation = reducer(this.current.get(missionIdentity(identity)))
      return mutation === undefined
        ? Promise.resolve(undefined)
        : this.appendSerialized(mutation.operation, mutation.snapshot)
    })
  }

  /** Drain pending writes and close the storage-domain handle. */
  async close(): Promise<void> {
    await this.writeTail
    await this.domain.close()
  }

  private async appendSerialized(operation: MissionOperation, snapshot: MissionSnapshot): Promise<MissionSnapshot> {
    const key = missionIdentity(snapshot)
    const previous = this.current.get(key)
    const record: MissionAuditRecord = Object.freeze({
      version: MISSION_STATE_VERSION,
      operation,
      time: snapshot.updatedAt,
      snapshot,
    })
    assertMissionTransition(previous, record)
    const priorUsage = this.usage.get(key) ?? { records: 0, bytes: 0 }
    const nextUsage = {
      records: priorUsage.records + 1,
      bytes: priorUsage.bytes + auditBytes(record),
    }
    if (nextUsage.records > snapshot.maxAuditRecords) {
      throw new MissionStoreError(
        `mission "${snapshot.missionId}" exceeded ${snapshot.maxAuditRecords} audit records`,
      )
    }
    if (nextUsage.bytes > snapshot.maxAuditBytes) {
      throw new MissionStoreError(`mission "${snapshot.missionId}" exceeded ${snapshot.maxAuditBytes} audit bytes`)
    }
    const storageKey = missionAuditKey(snapshot)
    if (this.events.get(storageKey) !== undefined) {
      throw new MissionStoreError(`mission revision key "${storageKey}" already exists`)
    }
    await this.events.put(storageKey, record)
    this.current.set(key, Object.freeze(snapshot))
    this.usage.set(key, nextUsage)
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareRecords))
    return snapshot
  }

  private rebuild(records: readonly MissionAuditRecord[]): void {
    const folded = foldMissionAudit(records)
    const usage = new Map<string, { records: number; bytes: number }>()
    for (const record of [...records].sort(compareRecords)) {
      const key = missionIdentity(record.snapshot)
      const prior = usage.get(key) ?? { records: 0, bytes: 0 }
      const next = { records: prior.records + 1, bytes: prior.bytes + auditBytes(record) }
      if (next.records > record.snapshot.maxAuditRecords || next.bytes > record.snapshot.maxAuditBytes) {
        throw new MissionStoreError(`mission "${record.snapshot.missionId}" audit exceeds its durable ceilings`)
      }
      usage.set(key, next)
    }
    this.current.clear()
    for (const [key, snapshot] of folded) this.current.set(key, snapshot)
    this.usage.clear()
    for (const [key, value] of usage) this.usage.set(key, Object.freeze(value))
    this.historyRecords = Object.freeze([...records].sort(compareRecords))
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task, task)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function compareRecords(left: MissionAuditRecord, right: MissionAuditRecord): number {
  return left.snapshot.parentSessionId.localeCompare(right.snapshot.parentSessionId)
    || left.snapshot.generation - right.snapshot.generation
    || left.snapshot.missionId.localeCompare(right.snapshot.missionId)
    || left.snapshot.revision - right.snapshot.revision
}
