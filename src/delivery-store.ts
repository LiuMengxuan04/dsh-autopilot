/** Durable append-only storage for isolated delivery generations. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  DELIVERY_STATE_VERSION,
  DeliveryError,
  assertDeliverySnapshot,
  deliveryAuditRecordSchema,
} from './delivery-state.ts'
import type {
  DeliveryAuditRecord,
  DeliveryOperation,
  DeliverySnapshot,
} from './delivery-state.ts'

/** Materialized whole-snapshot usage for one exact delivery generation. */
export interface DeliveryAuditUsage {
  readonly records: number
  readonly bytes: number
}

/** DSH storage-domain declaration for isolated delivery audit rows. */
export const deliveryStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot_delivery',
  version: DELIVERY_STATE_VERSION,
  tables: {
    events: domainTable<string, DeliveryAuditRecord>(deliveryAuditRecordSchema),
  },
})

/** Stable storage key for one immutable delivery revision. */
export function deliveryAuditKey(snapshot: DeliverySnapshot): string {
  const repository = createHash('sha256').update(snapshot.repository).digest('base64url')
  return [
    repository,
    String(snapshot.generation).padStart(12, '0'),
    snapshot.deliveryId,
    String(snapshot.revision).padStart(12, '0'),
  ].join('.')
}

function compareRecords(left: DeliveryAuditRecord, right: DeliveryAuditRecord): number {
  return left.snapshot.repository.localeCompare(right.snapshot.repository)
    || left.snapshot.generation - right.snapshot.generation
    || left.snapshot.revision - right.snapshot.revision
    || left.snapshot.deliveryId.localeCompare(right.snapshot.deliveryId)
}

function deliveryIdentity(snapshot: Pick<DeliverySnapshot, 'repository' | 'deliveryId'>): string {
  return `${snapshot.repository}\u0000${snapshot.deliveryId}`
}

/** Return the exact UTF-8 JSON bytes charged for one whole-snapshot audit row. */
export function deliveryAuditRecordBytes(record: DeliveryAuditRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function assertAuditUsage(
  snapshot: DeliverySnapshot,
  usage: DeliveryAuditUsage,
): void {
  if (usage.bytes > snapshot.maxAuditBytes) {
    throw new DeliveryError(
      `delivery reached its ${snapshot.maxAuditBytes}-byte whole-snapshot audit ceiling`,
      'DELIVERY_LIMIT',
    )
  }
}

function assertInitial(snapshot: DeliverySnapshot): void {
  if (snapshot.revision !== 1 || snapshot.phase !== 'active'
    || snapshot.head !== snapshot.baseHead || snapshot.dirty || snapshot.conflicted
    || snapshot.verifications.length !== 0 || snapshot.handoff !== undefined
    || snapshot.plan !== undefined || snapshot.reason !== undefined) {
    throw new DeliveryError('delivery generation has an invalid initial snapshot', 'DELIVERY_INVALID')
  }
}

function assertTransition(
  previous: DeliverySnapshot,
  next: DeliverySnapshot,
  operation: DeliveryOperation,
): void {
  const immutable = [
    'deliveryId',
    'parentSessionId',
    'parentRunId',
    'parentRunGeneration',
    'parentGoalId',
    'repository',
    'generation',
    'maxAuditRecords',
    'maxAuditBytes',
    'createdAt',
    'baseBranch',
    'baseHead',
    'worktreeRoot',
    'worktreePath',
    'branch',
  ] as const
  if (immutable.some(key => next[key] !== previous[key])) {
    throw new DeliveryError('delivery mutation changed immutable identity fields', 'DELIVERY_CONFLICT')
  }
  if (next.revision !== previous.revision + 1) {
    throw new DeliveryError(
      `delivery revision ${next.revision} must follow ${previous.revision}`,
      'DELIVERY_CONFLICT',
    )
  }
  if (next.updatedAt < previous.updatedAt) {
    throw new DeliveryError('delivery updatedAt moved backwards', 'DELIVERY_INVALID')
  }
  if (next.verifications.length < previous.verifications.length
    || JSON.stringify(next.verifications.slice(0, previous.verifications.length))
      !== JSON.stringify(previous.verifications)) {
    throw new DeliveryError('delivery mutation rewrote verification history', 'DELIVERY_CONFLICT')
  }
  if (previous.phase === 'cleaned') {
    throw new DeliveryError('cleaned delivery cannot receive another revision', 'DELIVERY_CONFLICT')
  }
  const phases: Readonly<Record<DeliveryOperation, readonly DeliverySnapshot['phase'][]>> = {
    create: ['active'],
    checkpoint: ['active'],
    'prepare-delivery': ['prepared'],
    attention: ['needs-attention'],
    cleanup: ['cleaned'],
    'host-cleanup': ['cleaned'],
  }
  if (operation === 'create' || !phases[operation].includes(next.phase)) {
    throw new DeliveryError(
      `operation ${operation} cannot produce phase ${next.phase}`,
      'DELIVERY_INVALID',
    )
  }
}

/** Validate and fold durable rows into one current generation per repository. */
export function foldDeliveryAudit(records: readonly DeliveryAuditRecord[]): {
  readonly current: ReadonlyMap<string, DeliverySnapshot>
  readonly history: readonly DeliveryAuditRecord[]
  readonly usage: ReadonlyMap<string, DeliveryAuditUsage>
} {
  const ordered = [...records].sort(compareRecords)
  const current = new Map<string, DeliverySnapshot>()
  const previousByDelivery = new Map<string, DeliverySnapshot>()
  const usage = new Map<string, DeliveryAuditUsage>()
  for (const record of ordered) {
    deliveryAuditRecordSchema.parse(record)
    const snapshot = record.snapshot
    assertDeliverySnapshot(snapshot)
    if (record.time !== snapshot.updatedAt) {
      throw new DeliveryError('delivery audit time does not match its snapshot', 'DELIVERY_INVALID')
    }
    const deliveryKey = deliveryIdentity(snapshot)
    const previous = previousByDelivery.get(deliveryKey)
    if (previous === undefined) {
      if (record.operation !== 'create') {
        throw new DeliveryError('delivery history must begin with create', 'DELIVERY_INVALID')
      }
      assertInitial(snapshot)
      const priorGeneration = current.get(snapshot.repository)
      const expectedGeneration = (priorGeneration?.generation ?? 0) + 1
      if (snapshot.generation !== expectedGeneration) {
        throw new DeliveryError(
          `delivery generation ${snapshot.generation} must be ${expectedGeneration}`,
          'DELIVERY_CONFLICT',
        )
      }
      if (priorGeneration !== undefined && priorGeneration.phase !== 'cleaned') {
        throw new DeliveryError('new delivery generation replaced a live worktree', 'DELIVERY_CONFLICT')
      }
    } else {
      assertTransition(previous, snapshot, record.operation)
    }
    const previousUsage = usage.get(deliveryKey) ?? { records: 0, bytes: 0 }
    const nextUsage = Object.freeze({
      records: previousUsage.records + 1,
      bytes: previousUsage.bytes + deliveryAuditRecordBytes(record),
    })
    assertAuditUsage(snapshot, nextUsage)
    usage.set(deliveryKey, nextUsage)
    previousByDelivery.set(deliveryKey, snapshot)
    current.set(snapshot.repository, snapshot)
  }
  return Object.freeze({ current, history: Object.freeze(ordered), usage })
}

/** Opened durable isolated-delivery store with serialized compare-and-set writes. */
export class DurableDeliveryStore {
  private readonly current = new Map<string, DeliverySnapshot>()
  private readonly auditUsage = new Map<string, DeliveryAuditUsage>()
  private historyRecords: readonly DeliveryAuditRecord[] = Object.freeze([])
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof deliveryStoreDomainSpec>,
    private readonly table: KvTable<string, DeliveryAuditRecord>,
  ) {}

  /** Open and validate the complete delivery audit history. */
  static async open(ctx: Context): Promise<DurableDeliveryStore> {
    const domain = await ctx.storageDomain.open(deliveryStoreDomainSpec)
    try {
      const table = domain.table('events')
      const store = new DurableDeliveryStore(domain, table)
      store.rebuild([...table.entries()].map(([, record]) => record))
      return store
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /** Read the latest durable generation for one canonical repository. */
  get(repository: string): DeliverySnapshot | undefined {
    return this.current.get(repository)
  }

  /** Return deterministic immutable history, optionally for one repository. */
  history(repository?: string): readonly DeliveryAuditRecord[] {
    return repository === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record => record.snapshot.repository === repository))
  }

  /** Return one current snapshot per repository in stable path order. */
  list(): readonly DeliverySnapshot[] {
    return Object.freeze([...this.current.values()]
      .sort((left, right) => left.repository.localeCompare(right.repository)))
  }

  /**
   * Append a new generation only when the caller observed the current generation.
   * @param expectedGeneration - Zero for the first generation, otherwise the exact current generation.
   * @param snapshot - Initial state for the next generation.
   * @returns the durably stored snapshot.
   */
  async create(expectedGeneration: number, snapshot: DeliverySnapshot): Promise<DeliverySnapshot> {
    const write = this.writeTail.then(async () => {
      const current = this.current.get(snapshot.repository)
      const actualGeneration = current?.generation ?? 0
      if (actualGeneration !== expectedGeneration) {
        throw new DeliveryError(
          `delivery generation conflict; expected ${expectedGeneration}, current is ${actualGeneration}`,
          'DELIVERY_CONFLICT',
        )
      }
      if (current !== undefined && current.phase !== 'cleaned') {
        throw new DeliveryError('repository already has a live isolated delivery', 'DELIVERY_CONFLICT')
      }
      if (snapshot.generation !== expectedGeneration + 1) {
        throw new DeliveryError('new delivery generation does not follow expectedGeneration', 'DELIVERY_CONFLICT')
      }
      assertInitial(snapshot)
      return this.appendSerialized('create', snapshot)
    })
    this.writeTail = write.then(() => undefined, () => undefined)
    return write
  }

  /**
   * Append a mutation only when generation and revision remain current.
   * @param operation - Mutation classification.
   * @param expected - Exact generation and revision observed by the caller.
   * @param snapshot - Complete post-mutation state.
   * @returns the durably stored snapshot.
   */
  async appendIfCurrent(
    operation: Exclude<DeliveryOperation, 'create'>,
    expected: Pick<DeliverySnapshot, 'repository' | 'deliveryId' | 'generation' | 'revision'>,
    snapshot: DeliverySnapshot,
  ): Promise<DeliverySnapshot> {
    const write = this.writeTail.then(async () => {
      const current = this.current.get(expected.repository)
      if (current === undefined || current.deliveryId !== expected.deliveryId
        || current.generation !== expected.generation || current.revision !== expected.revision) {
        throw new DeliveryError('delivery generation or revision is stale', 'DELIVERY_CONFLICT')
      }
      assertTransition(current, snapshot, operation)
      return this.appendSerialized(operation, snapshot)
    })
    this.writeTail = write.then(() => undefined, () => undefined)
    return write
  }

  /** Close the owned storage domain after draining queued writes. */
  async close(): Promise<void> {
    await this.writeTail
    await this.domain.close()
  }

  private async appendSerialized(
    operation: DeliveryOperation,
    snapshot: DeliverySnapshot,
  ): Promise<DeliverySnapshot> {
    assertDeliverySnapshot(snapshot)
    const record: DeliveryAuditRecord = Object.freeze({
      version: DELIVERY_STATE_VERSION,
      operation,
      time: snapshot.updatedAt,
      snapshot,
    })
    const key = deliveryAuditKey(snapshot)
    if (this.table.get(key) !== undefined) {
      throw new DeliveryError(`delivery audit key "${key}" already exists`, 'DELIVERY_CONFLICT')
    }
    const identity = deliveryIdentity(snapshot)
    const previousUsage = this.auditUsage.get(identity) ?? { records: 0, bytes: 0 }
    const nextUsage = Object.freeze({
      records: previousUsage.records + 1,
      bytes: previousUsage.bytes + deliveryAuditRecordBytes(record),
    })
    assertAuditUsage(snapshot, nextUsage)
    await this.table.put(key, record)
    this.current.set(snapshot.repository, snapshot)
    this.auditUsage.set(identity, nextUsage)
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareRecords))
    return snapshot
  }

  private rebuild(records: readonly DeliveryAuditRecord[]): void {
    const folded = foldDeliveryAudit(records)
    this.current.clear()
    for (const [repository, snapshot] of folded.current) this.current.set(repository, snapshot)
    this.auditUsage.clear()
    for (const [identity, usage] of folded.usage) this.auditUsage.set(identity, usage)
    this.historyRecords = folded.history
  }
}
