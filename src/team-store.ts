/** Append-only storage-domain provider for continuable-team mailboxes. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assertTeamAuditTransition,
  foldTeamAudit,
  TEAM_STATE_VERSION,
  teamAuditRecordSchema,
  teamOrphanRecordSchema,
  teamThreadIdentity,
} from './team-state.ts'
import type {
  TeamAuditRecord,
  TeamOrphanRecord,
  TeamThreadOperation,
  TeamThreadSnapshot,
} from './team-state.ts'

/** Storage declaration for immutable team revisions and orphan observations. */
export const teamStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot_team',
  version: TEAM_STATE_VERSION,
  tables: {
    events: domainTable<string, TeamAuditRecord>(teamAuditRecordSchema),
    orphans: domainTable<string, TeamOrphanRecord>(teamOrphanRecordSchema),
  },
})

/** Durable team-store invariant failure. */
export class TeamStoreError extends Error {
  /** Stable machine-readable failure category. */
  readonly code = 'AUTOPILOT_TEAM_STORE_INVALID' as const

  /** @param message - Exact persistence invariant that failed. */
  constructor(message: string) {
    super(message)
    this.name = 'TeamStoreError'
  }
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Unique storage key for one immutable thread revision. */
export function teamAuditKey(snapshot: TeamThreadSnapshot): string {
  return [
    encoded(snapshot.parentSessionId),
    encoded(snapshot.runId),
    String(snapshot.generation).padStart(12, '0'),
    encoded(snapshot.taskId),
    String(snapshot.revision).padStart(12, '0'),
  ].join('.')
}

/** Idempotent key for the first observation of one orphan in a run generation. */
export function teamOrphanKey(record: TeamOrphanRecord): string {
  return [
    encoded(record.parentSessionId),
    encoded(record.runId),
    String(record.generation).padStart(12, '0'),
    encoded(record.childSessionId),
  ].join('.')
}

/** Team-state persistence with serialized compare-and-append mutations. */
export class DurableTeamStore {
  private readonly current = new Map<string, TeamThreadSnapshot>()
  private readonly byChild = new Map<string, TeamThreadSnapshot>()
  private historyRecords: readonly TeamAuditRecord[] = Object.freeze([])
  private orphanRecords: readonly TeamOrphanRecord[] = Object.freeze([])
  private readonly auditUsage = new Map<string, { readonly records: number; readonly bytes: number }>()
  private readonly auditLimits = new Map<string, { readonly records: number; readonly bytes: number }>()
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof teamStoreDomainSpec>,
    private readonly events: KvTable<string, TeamAuditRecord>,
    private readonly orphansTable: KvTable<string, TeamOrphanRecord>,
  ) {}

  /** Open and fold the complete team domain before serving reads. */
  static async open(ctx: Context): Promise<DurableTeamStore> {
    const domain = await ctx.storageDomain.open(teamStoreDomainSpec)
    try {
      const store = new DurableTeamStore(domain, domain.table('events'), domain.table('orphans'))
      store.rebuild(
        [...store.events.entries()].map(([, record]) => record),
        [...store.orphansTable.entries()].map(([, record]) => record),
      )
      return store
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
  }

  /** Read one exact run-generation task assignment. */
  get(identity: Pick<TeamThreadSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId'>):
    TeamThreadSnapshot | undefined {
    return this.current.get(teamThreadIdentity(identity))
  }

  /** Resolve the one task ledger that owns a durable child id. */
  getByChild(childSessionId: string): TeamThreadSnapshot | undefined {
    return this.byChild.get(childSessionId)
  }

  /** List current task ledgers in stable run-generation-task order. */
  list(filter: {
    readonly parentSessionId?: string
    readonly runId?: string
    readonly generation?: number
  } = {}): readonly TeamThreadSnapshot[] {
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
  history(parentSessionId?: string): readonly TeamAuditRecord[] {
    return parentSessionId === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record =>
        record.snapshot.parentSessionId === parentSessionId))
  }

  /** Return durable orphan observations in deterministic order. */
  orphans(parentSessionId?: string): readonly TeamOrphanRecord[] {
    return parentSessionId === undefined
      ? this.orphanRecords
      : Object.freeze(this.orphanRecords.filter(record => record.parentSessionId === parentSessionId))
  }

  /** Append one exact post-mutation thread snapshot. */
  append(operation: TeamThreadOperation, snapshot: TeamThreadSnapshot): Promise<TeamThreadSnapshot> {
    return this.serialized(() => this.appendSerialized(operation, snapshot))
  }

  /**
   * Derive an append from the latest in-process revision under the write queue.
   * @param identity - Exact task ledger to reduce.
   * @param reducer - Synchronous mutation derivation, or undefined for no-op.
   * @returns the stored snapshot, or undefined when no mutation was requested.
   */
  reduceCurrent(
    identity: Pick<TeamThreadSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'taskId'>,
    reducer: (
      current: TeamThreadSnapshot | undefined,
    ) => { readonly operation: TeamThreadOperation; readonly snapshot: TeamThreadSnapshot } | undefined,
  ): Promise<TeamThreadSnapshot | undefined> {
    return this.serialized(() => {
      const mutation = reducer(this.current.get(teamThreadIdentity(identity)))
      return mutation === undefined
        ? Promise.resolve(undefined)
        : this.appendSerialized(mutation.operation, mutation.snapshot)
    })
  }

  /** Persist one orphan observation once and return the canonical first row. */
  recordOrphan(record: TeamOrphanRecord): Promise<TeamOrphanRecord> {
    return this.serialized(async () => {
      teamOrphanRecordSchema.parse(record)
      const key = teamOrphanKey(record)
      const current = this.orphansTable.get(key)
      if (current !== undefined) return current
      await this.orphansTable.put(key, record)
      this.orphanRecords = Object.freeze([...this.orphanRecords, Object.freeze({ ...record })]
        .sort(compareOrphans))
      return record
    })
  }

  /** Drain pending writes and close the owned storage-domain handle. */
  async close(): Promise<void> {
    await this.writeTail
    await this.domain.close()
  }

  private async appendSerialized(
    operation: TeamThreadOperation,
    snapshot: TeamThreadSnapshot,
  ): Promise<TeamThreadSnapshot> {
    const key = teamThreadIdentity(snapshot)
    const previous = this.current.get(key)
    const record: TeamAuditRecord = Object.freeze({
      version: TEAM_STATE_VERSION,
      operation,
      time: snapshot.updatedAt,
      snapshot,
    })
    assertTeamAuditTransition(previous, record)
    const auditKey = teamRunIdentity(snapshot)
    this.assertAuditLimits(auditKey, snapshot)
    const priorUsage = this.auditUsage.get(auditKey) ?? { records: 0, bytes: 0 }
    const nextUsage = {
      records: priorUsage.records + 1,
      bytes: priorUsage.bytes + auditRecordBytes(record),
    }
    if (nextUsage.records > snapshot.maxAuditRecords) {
      throw new TeamStoreError(`team run "${snapshot.runId}" exceeded ${snapshot.maxAuditRecords} audit records`)
    }
    if (nextUsage.bytes > snapshot.maxAuditBytes) {
      throw new TeamStoreError(`team run "${snapshot.runId}" exceeded ${snapshot.maxAuditBytes} audit bytes`)
    }
    const child = snapshot.childSessionId
    if (child !== undefined) {
      const collision = this.byChild.get(child)
      if (collision !== undefined && teamThreadIdentity(collision) !== key) {
        throw new TeamStoreError(`child session "${child}" is already attributed to task "${collision.taskId}"`)
      }
    }
    const storageKey = teamAuditKey(snapshot)
    if (this.events.get(storageKey) !== undefined) {
      throw new TeamStoreError(`team audit key "${storageKey}" already exists`)
    }
    await this.events.put(storageKey, record)
    this.auditLimits.set(auditKey, materializedAuditLimits(snapshot))
    const priorChild = previous?.childSessionId
    if (priorChild !== undefined) this.byChild.delete(priorChild)
    this.current.set(key, snapshot)
    if (child !== undefined) this.byChild.set(child, snapshot)
    this.auditUsage.set(auditKey, Object.freeze(nextUsage))
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareAudit))
    return snapshot
  }

  private rebuild(records: readonly TeamAuditRecord[], orphans: readonly TeamOrphanRecord[]): void {
    const folded = foldTeamAudit(records)
    this.current.clear()
    this.byChild.clear()
    this.auditUsage.clear()
    this.auditLimits.clear()
    for (const [key, snapshot] of folded.current) this.current.set(key, snapshot)
    for (const [child, snapshot] of folded.byChild) this.byChild.set(child, snapshot)
    this.historyRecords = folded.history
    for (const record of folded.history) {
      const key = teamRunIdentity(record.snapshot)
      this.assertAuditLimits(key, record.snapshot)
      const prior = this.auditUsage.get(key) ?? { records: 0, bytes: 0 }
      const next = {
        records: prior.records + 1,
        bytes: prior.bytes + auditRecordBytes(record),
      }
      if (next.records > record.snapshot.maxAuditRecords || next.bytes > record.snapshot.maxAuditBytes) {
        throw new TeamStoreError(`persisted team run "${record.snapshot.runId}" exceeds its audit limits`)
      }
      this.auditLimits.set(key, materializedAuditLimits(record.snapshot))
      this.auditUsage.set(key, Object.freeze(next))
    }
    const uniqueOrphans = new Set<string>()
    for (const orphan of orphans) {
      teamOrphanRecordSchema.parse(orphan)
      const key = teamOrphanKey(orphan)
      if (uniqueOrphans.has(key)) throw new TeamStoreError(`duplicate orphan key "${key}"`)
      uniqueOrphans.add(key)
    }
    this.orphanRecords = Object.freeze([...orphans].sort(compareOrphans))
  }

  private assertAuditLimits(key: string, snapshot: TeamThreadSnapshot): void {
    const limits = this.auditLimits.get(key)
    if (limits !== undefined
      && (limits.records !== snapshot.maxAuditRecords || limits.bytes !== snapshot.maxAuditBytes)) {
      throw new TeamStoreError(`team run "${snapshot.runId}" changed its materialized audit limits`)
    }
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function auditRecordBytes(record: TeamAuditRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function materializedAuditLimits(
  snapshot: Pick<TeamThreadSnapshot, 'maxAuditRecords' | 'maxAuditBytes'>,
): { readonly records: number; readonly bytes: number } {
  return Object.freeze({ records: snapshot.maxAuditRecords, bytes: snapshot.maxAuditBytes })
}

function teamRunIdentity(
  snapshot: Pick<TeamThreadSnapshot, 'parentSessionId' | 'runId' | 'generation'>,
): string {
  return `${snapshot.parentSessionId}\u0000${snapshot.runId}\u0000${snapshot.generation}`
}

function compareAudit(left: TeamAuditRecord, right: TeamAuditRecord): number {
  return teamThreadIdentity(left.snapshot).localeCompare(teamThreadIdentity(right.snapshot))
    || left.snapshot.revision - right.snapshot.revision
}

function compareOrphans(left: TeamOrphanRecord, right: TeamOrphanRecord): number {
  return left.parentSessionId.localeCompare(right.parentSessionId)
    || left.generation - right.generation
    || left.childSessionId.localeCompare(right.childSessionId)
}
