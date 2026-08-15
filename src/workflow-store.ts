/** Append-only DSH storage-domain provider for managed workflow execution. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  isManagedWorkflowTerminal,
  managedWorkflowAuditRecordSchema,
  managedWorkflowIdentity,
  managedWorkflowRunIdentity,
  managedWorkflowSnapshotSchema,
  WORKFLOW_STATE_VERSION,
} from './workflow-state.ts'
import type {
  ManagedWorkflowAuditRecord,
  ManagedWorkflowOperation,
  ManagedWorkflowPhase,
  ManagedWorkflowSnapshot,
} from './workflow-state.ts'

/** Storage declaration for immutable managed-workflow snapshots. */
export const managedWorkflowStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot_workflow',
  version: WORKFLOW_STATE_VERSION,
  tables: {
    events: domainTable<string, ManagedWorkflowAuditRecord>(managedWorkflowAuditRecordSchema),
  },
})

/** Aggregate audit use for one exact parent run generation. */
export interface ManagedWorkflowAuditUsage {
  readonly records: number
  readonly bytes: number
}

/** Stable durable-store failure. */
export class ManagedWorkflowStoreError extends Error {
  /** Machine-routable failure category. */
  readonly code = 'AUTOPILOT_WORKFLOW_STORE_INVALID' as const

  /** @param message - Exact persistence invariant that failed. */
  constructor(message: string) {
    super(message)
    this.name = 'ManagedWorkflowStoreError'
  }
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Stable immutable-row key for one workflow revision. */
export function managedWorkflowAuditKey(snapshot: ManagedWorkflowSnapshot): string {
  return [
    encoded(snapshot.parentSessionId),
    encoded(snapshot.runId),
    String(snapshot.generation).padStart(12, '0'),
    snapshot.workflowId,
    String(snapshot.revision).padStart(12, '0'),
  ].join('.')
}

/** Exact UTF-8 bytes charged by one immutable workflow row. */
export function managedWorkflowAuditBytes(record: ManagedWorkflowAuditRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

/** Validate and fold a complete workflow audit history. */
export function foldManagedWorkflowAudit(records: readonly ManagedWorkflowAuditRecord[]): {
  readonly current: ReadonlyMap<string, ManagedWorkflowSnapshot>
  readonly history: readonly ManagedWorkflowAuditRecord[]
  readonly usage: ReadonlyMap<string, ManagedWorkflowAuditUsage>
} {
  const ordered = [...records].sort(compareAuditRecords)
  const current = new Map<string, ManagedWorkflowSnapshot>()
  const usage = new Map<string, ManagedWorkflowAuditUsage>()
  const limits = new Map<string, { readonly records: number; readonly bytes: number }>()
  for (const record of ordered) {
    managedWorkflowAuditRecordSchema.parse(record)
    if (record.time !== record.snapshot.updatedAt) {
      throw new ManagedWorkflowStoreError('workflow audit time does not match its snapshot')
    }
    const workflowKey = managedWorkflowIdentity(record.snapshot)
    const previous = current.get(workflowKey)
    if (previous === undefined) assertInitial(record)
    else assertTransition(previous, record)

    const runKey = managedWorkflowRunIdentity(record.snapshot)
    assertMaterializedLimits(limits.get(runKey), record.snapshot)
    const prior = usage.get(runKey) ?? { records: 0, bytes: 0 }
    const next = Object.freeze({
      records: prior.records + 1,
      bytes: prior.bytes + managedWorkflowAuditBytes(record),
    })
    assertAuditLimits(record.snapshot, next)
    limits.set(runKey, Object.freeze({
      records: record.snapshot.maxAuditRecords,
      bytes: record.snapshot.maxAuditBytes,
    }))
    usage.set(runKey, next)
    current.set(workflowKey, record.snapshot)
  }
  return Object.freeze({ current, history: Object.freeze(ordered), usage })
}

/** Serialized compare-and-append storage for managed workflows. */
export class DurableManagedWorkflowStore {
  private readonly current = new Map<string, ManagedWorkflowSnapshot>()
  private readonly usage = new Map<string, ManagedWorkflowAuditUsage>()
  private readonly limits = new Map<string, { readonly records: number; readonly bytes: number }>()
  private historyRecords: readonly ManagedWorkflowAuditRecord[] = Object.freeze([])
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof managedWorkflowStoreDomainSpec>,
    private readonly table: KvTable<string, ManagedWorkflowAuditRecord>,
  ) {}

  /** Open and validate the complete workflow domain before serving reads. */
  static async open(ctx: Context): Promise<DurableManagedWorkflowStore> {
    const domain = await ctx.storageDomain.open(managedWorkflowStoreDomainSpec)
    try {
      const table = domain.table('events')
      const store = new DurableManagedWorkflowStore(domain, table)
      store.rebuild([...table.entries()].map(([, record]) => record))
      return store
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
  }

  /** Read one exact workflow intent. */
  get(workflowId: string): ManagedWorkflowSnapshot | undefined {
    return this.current.get(workflowId)
  }

  /** List current snapshots in stable parent/run/generation/creation order. */
  list(filter: {
    readonly parentSessionId?: string
    readonly runId?: string
    readonly generation?: number
    readonly includeTerminal?: boolean
  } = {}): readonly ManagedWorkflowSnapshot[] {
    return Object.freeze([...this.current.values()]
      .filter(snapshot => (filter.parentSessionId === undefined
        || snapshot.parentSessionId === filter.parentSessionId)
        && (filter.runId === undefined || snapshot.runId === filter.runId)
        && (filter.generation === undefined || snapshot.generation === filter.generation)
        && (filter.includeTerminal === true || !isManagedWorkflowTerminal(snapshot.phase)))
      .sort(compareSnapshots))
  }

  /** Return immutable history, optionally narrowed to one parent session. */
  history(parentSessionId?: string): readonly ManagedWorkflowAuditRecord[] {
    return parentSessionId === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record =>
        record.snapshot.parentSessionId === parentSessionId))
  }

  /** Persist the first durable intent for a globally unique workflow id. */
  create(snapshot: ManagedWorkflowSnapshot): Promise<ManagedWorkflowSnapshot> {
    return this.serialized(async () => {
      if (this.current.has(snapshot.workflowId)) {
        throw new ManagedWorkflowStoreError(`workflow id "${snapshot.workflowId}" already exists`)
      }
      const record = makeRecord('prepare', snapshot)
      assertInitial(record)
      return await this.appendRecord(record)
    })
  }

  /** Append an exact next revision after compare-and-set validation. */
  appendIfCurrent(
    operation: Exclude<ManagedWorkflowOperation, 'prepare'>,
    expected: Pick<ManagedWorkflowSnapshot, 'workflowId' | 'revision'>,
    snapshot: ManagedWorkflowSnapshot,
  ): Promise<ManagedWorkflowSnapshot> {
    return this.serialized(async () => {
      const previous = this.current.get(expected.workflowId)
      if (previous === undefined || previous.revision !== expected.revision) {
        throw new ManagedWorkflowStoreError('workflow revision changed before append')
      }
      const record = makeRecord(operation, snapshot)
      assertTransition(previous, record)
      return await this.appendRecord(record)
    })
  }

  /** Derive one next row from the latest state under the store write queue. */
  reduceCurrent(
    workflowId: string,
    reducer: (
      current: ManagedWorkflowSnapshot | undefined,
    ) => {
      readonly operation: Exclude<ManagedWorkflowOperation, 'prepare'>
      readonly snapshot: ManagedWorkflowSnapshot
    } | undefined,
  ): Promise<ManagedWorkflowSnapshot | undefined> {
    return this.serialized(async () => {
      const current = this.current.get(workflowId)
      const mutation = reducer(current)
      if (mutation === undefined) return undefined
      const record = makeRecord(mutation.operation, mutation.snapshot)
      if (current === undefined) throw new ManagedWorkflowStoreError('workflow does not exist')
      assertTransition(current, record)
      return await this.appendRecord(record)
    })
  }

  /** Drain pending writes and close the owned domain handle. */
  async close(): Promise<void> {
    await this.writeTail
    await this.domain.close()
  }

  private async appendRecord(record: ManagedWorkflowAuditRecord): Promise<ManagedWorkflowSnapshot> {
    const snapshot = record.snapshot
    const storageKey = managedWorkflowAuditKey(snapshot)
    if (this.table.get(storageKey) !== undefined) {
      throw new ManagedWorkflowStoreError(`workflow audit key "${storageKey}" already exists`)
    }
    const runKey = managedWorkflowRunIdentity(snapshot)
    assertMaterializedLimits(this.limits.get(runKey), snapshot)
    const prior = this.usage.get(runKey) ?? { records: 0, bytes: 0 }
    const next = Object.freeze({
      records: prior.records + 1,
      bytes: prior.bytes + managedWorkflowAuditBytes(record),
    })
    assertAuditLimits(snapshot, next)
    await this.table.put(storageKey, record)
    this.current.set(snapshot.workflowId, snapshot)
    this.usage.set(runKey, next)
    this.limits.set(runKey, Object.freeze({ records: snapshot.maxAuditRecords, bytes: snapshot.maxAuditBytes }))
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareAuditRecords))
    return snapshot
  }

  private rebuild(records: readonly ManagedWorkflowAuditRecord[]): void {
    const folded = foldManagedWorkflowAudit(records)
    this.current.clear()
    for (const [workflowId, snapshot] of folded.current) this.current.set(workflowId, snapshot)
    this.usage.clear()
    for (const [runKey, usage] of folded.usage) this.usage.set(runKey, usage)
    this.limits.clear()
    for (const snapshot of folded.current.values()) {
      const runKey = managedWorkflowRunIdentity(snapshot)
      assertMaterializedLimits(this.limits.get(runKey), snapshot)
      this.limits.set(runKey, Object.freeze({ records: snapshot.maxAuditRecords, bytes: snapshot.maxAuditBytes }))
    }
    this.historyRecords = folded.history
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function makeRecord(
  operation: ManagedWorkflowOperation,
  snapshot: ManagedWorkflowSnapshot,
): ManagedWorkflowAuditRecord {
  const record = Object.freeze({
    version: WORKFLOW_STATE_VERSION,
    operation,
    time: snapshot.updatedAt,
    snapshot,
  })
  managedWorkflowAuditRecordSchema.parse(record)
  return record
}

function assertInitial(record: ManagedWorkflowAuditRecord): void {
  const snapshot = record.snapshot
  managedWorkflowSnapshotSchema.parse(snapshot)
  if (record.operation !== 'prepare' || snapshot.revision !== 1 || snapshot.phase !== 'prepared') {
    throw new ManagedWorkflowStoreError('workflow history must begin with a revision-one prepare row')
  }
}

function assertTransition(
  previous: ManagedWorkflowSnapshot,
  record: ManagedWorkflowAuditRecord,
): void {
  const next = record.snapshot
  managedWorkflowSnapshotSchema.parse(next)
  const immutable = [
    'workflowId',
    'parentSessionId',
    'runId',
    'generation',
    'goalId',
    'maxAuditRecords',
    'maxAuditBytes',
    'profileId',
    'profileSha256',
    'argsSha256',
    'taskIds',
    'maxTotalAgents',
    'subagentsStartedBefore',
    'createdAt',
  ] as const
  if (immutable.some(key => JSON.stringify(next[key]) !== JSON.stringify(previous[key]))) {
    throw new ManagedWorkflowStoreError('workflow mutation changed immutable intent fields')
  }
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt) {
    throw new ManagedWorkflowStoreError('workflow revision or timestamp is not monotonic')
  }
  if (isManagedWorkflowTerminal(previous.phase)) {
    throw new ManagedWorkflowStoreError(`terminal workflow in ${previous.phase} cannot mutate`)
  }
  const allowed: Readonly<Record<Exclude<ManagedWorkflowOperation, 'prepare'>, readonly ManagedWorkflowPhase[]>> = {
    claim: ['claimed'],
    start: ['running'],
    settle: ['settling'],
    'task-applied': ['settling'],
    'cancel-request': ['cancelling'],
    finish: ['completed', 'partial-failure', 'cancelled', 'error'],
    uncertain: ['uncertain'],
  }
  if (record.operation === 'prepare' || !allowed[record.operation].includes(next.phase)) {
    throw new ManagedWorkflowStoreError(`operation ${record.operation} cannot produce ${next.phase}`)
  }
  if (record.operation === 'claim' && previous.phase !== 'prepared') {
    throw new ManagedWorkflowStoreError('workflow claim must follow prepared')
  }
  if (record.operation === 'start' && previous.phase !== 'claimed') {
    throw new ManagedWorkflowStoreError('workflow start must follow claimed')
  }
  if (record.operation === 'settle' && previous.phase !== 'running' && previous.phase !== 'cancelling') {
    throw new ManagedWorkflowStoreError('workflow settlement requires running or cancelling')
  }
  if (record.operation === 'task-applied') {
    if (previous.phase !== 'settling' || next.settledTaskIds.length !== previous.settledTaskIds.length + 1
      || previous.settledTaskIds.some((id, index) => next.settledTaskIds[index] !== id)) {
      throw new ManagedWorkflowStoreError('task-applied must append exactly one settlement id')
    }
  }
}

function assertAuditLimits(
  snapshot: ManagedWorkflowSnapshot,
  usage: ManagedWorkflowAuditUsage,
): void {
  if (usage.records > snapshot.maxAuditRecords) {
    throw new ManagedWorkflowStoreError(
      `workflow run "${snapshot.runId}" exceeded ${snapshot.maxAuditRecords} audit records`,
    )
  }
  if (usage.bytes > snapshot.maxAuditBytes) {
    throw new ManagedWorkflowStoreError(
      `workflow run "${snapshot.runId}" exceeded ${snapshot.maxAuditBytes} audit bytes`,
    )
  }
}

function assertMaterializedLimits(
  prior: { readonly records: number; readonly bytes: number } | undefined,
  snapshot: ManagedWorkflowSnapshot,
): void {
  if (prior !== undefined
    && (prior.records !== snapshot.maxAuditRecords || prior.bytes !== snapshot.maxAuditBytes)) {
    throw new ManagedWorkflowStoreError(`workflow run "${snapshot.runId}" changed its audit limits`)
  }
}

function compareSnapshots(left: ManagedWorkflowSnapshot, right: ManagedWorkflowSnapshot): number {
  return left.parentSessionId.localeCompare(right.parentSessionId)
    || left.runId.localeCompare(right.runId)
    || left.generation - right.generation
    || left.createdAt - right.createdAt
    || left.workflowId.localeCompare(right.workflowId)
}

function compareAuditRecords(
  left: ManagedWorkflowAuditRecord,
  right: ManagedWorkflowAuditRecord,
): number {
  return compareSnapshots(left.snapshot, right.snapshot)
    || left.snapshot.revision - right.snapshot.revision
}
