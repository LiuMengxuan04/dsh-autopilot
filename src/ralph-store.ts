/** Append-only storage provider for bounded Ralph leaf loops. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assertRalphTransition,
  RALPH_STATE_VERSION,
  ralphAuditRecordSchema,
  ralphIdentity,
} from './ralph-state.ts'
import type {
  RalphAuditRecord,
  RalphOperation,
  RalphSnapshot,
} from './ralph-state.ts'

/** DSH storage domain containing immutable Ralph revisions. */
export const ralphStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot_ralph',
  version: RALPH_STATE_VERSION,
  tables: {
    events: domainTable<string, RalphAuditRecord>(ralphAuditRecordSchema),
  },
})

/** Durable Ralph store invariant failure. */
export class RalphStoreError extends Error {
  /** Stable machine-readable failure category. */
  readonly code = 'AUTOPILOT_RALPH_STORE_INVALID' as const

  /** @param message - Exact persistence invariant that failed. */
  constructor(message: string) {
    super(message)
    this.name = 'RalphStoreError'
  }
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Unique key for one immutable Ralph revision. */
export function ralphAuditKey(snapshot: RalphSnapshot): string {
  return [
    encoded(snapshot.parentSessionId),
    encoded(snapshot.runId),
    String(snapshot.generation).padStart(12, '0'),
    encoded(snapshot.taskId),
    String(snapshot.revision).padStart(12, '0'),
  ].join('.')
}

function compareRecords(left: RalphAuditRecord, right: RalphAuditRecord): number {
  return left.snapshot.parentSessionId.localeCompare(right.snapshot.parentSessionId)
    || left.snapshot.generation - right.snapshot.generation
    || left.snapshot.taskId.localeCompare(right.snapshot.taskId)
    || left.snapshot.revision - right.snapshot.revision
}

/** Fold complete audit history into one current row per exact loop identity. */
export function foldRalphAudit(records: readonly RalphAuditRecord[]): {
  readonly current: ReadonlyMap<string, RalphSnapshot>
  readonly history: readonly RalphAuditRecord[]
} {
  const ordered = [...records].sort(compareRecords)
  const current = new Map<string, RalphSnapshot>()
  for (const record of ordered) {
    const identity = ralphIdentity(record.snapshot)
    const previous = current.get(identity)
    assertRalphTransition(previous, record)
    current.set(identity, record.snapshot)
  }
  return Object.freeze({ current, history: Object.freeze(ordered) })
}

/** Serialized compare-and-append Ralph persistence. */
export class DurableRalphStore {
  private readonly current = new Map<string, RalphSnapshot>()
  private historyRecords: readonly RalphAuditRecord[] = Object.freeze([])
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof ralphStoreDomainSpec>,
    private readonly events: KvTable<string, RalphAuditRecord>,
  ) {}

  /** Open and validate the complete Ralph history. */
  static async open(ctx: Context): Promise<DurableRalphStore> {
    const domain = await ctx.storageDomain.open(ralphStoreDomainSpec)
    try {
      const events = domain.table('events')
      const store = new DurableRalphStore(domain, events)
      store.rebuild([...events.entries()].map(([, record]) => record))
      return store
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
  }

  /** Read one exact run-generation task loop. */
  get(identity: Pick<RalphSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId'>):
    RalphSnapshot | undefined {
    return this.current.get(ralphIdentity(identity))
  }

  /** List current loops in stable parent/generation/task order. */
  list(filter: {
    readonly parentSessionId?: string
    readonly runId?: string
    readonly generation?: number
  } = {}): readonly RalphSnapshot[] {
    return Object.freeze([...this.current.values()]
      .filter(snapshot => (filter.parentSessionId === undefined
        || snapshot.parentSessionId === filter.parentSessionId)
        && (filter.runId === undefined || snapshot.runId === filter.runId)
        && (filter.generation === undefined || snapshot.generation === filter.generation))
      .sort((left, right) => left.parentSessionId.localeCompare(right.parentSessionId)
        || left.generation - right.generation
        || left.taskId.localeCompare(right.taskId)))
  }

  /** Return immutable audit history, optionally narrowed to one parent session. */
  history(parentSessionId?: string): readonly RalphAuditRecord[] {
    return parentSessionId === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record =>
        record.snapshot.parentSessionId === parentSessionId))
  }

  /** Append one exact post-mutation snapshot. */
  append(operation: RalphOperation, snapshot: RalphSnapshot): Promise<RalphSnapshot> {
    return this.serialized(() => this.appendSerialized(operation, snapshot))
  }

  /** Append only if the caller-observed revision is still current. */
  appendIfCurrent(
    operation: RalphOperation,
    expected: Pick<RalphSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId' | 'revision'>,
    snapshot: RalphSnapshot,
  ): Promise<RalphSnapshot | undefined> {
    return this.serialized(() => {
      const current = this.current.get(ralphIdentity(expected))
      if (current === undefined || current.revision !== expected.revision) return Promise.resolve(undefined)
      return this.appendSerialized(operation, snapshot)
    })
  }

  /** Drain all pending writes and close the owned domain. */
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
    operation: RalphOperation,
    snapshot: RalphSnapshot,
  ): Promise<RalphSnapshot> {
    const identity = ralphIdentity(snapshot)
    const previous = this.current.get(identity)
    const record: RalphAuditRecord = Object.freeze({
      version: RALPH_STATE_VERSION,
      operation,
      time: snapshot.updatedAt,
      snapshot,
    })
    assertRalphTransition(previous, record)
    const key = ralphAuditKey(snapshot)
    if (this.events.get(key) !== undefined) throw new RalphStoreError(`Ralph audit key "${key}" exists`)
    await this.events.put(key, record)
    this.current.set(identity, snapshot)
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareRecords))
    return snapshot
  }

  private rebuild(records: readonly RalphAuditRecord[]): void {
    const folded = foldRalphAudit(records)
    this.current.clear()
    for (const [identity, snapshot] of folded.current) this.current.set(identity, snapshot)
    this.historyRecords = folded.history
  }
}
