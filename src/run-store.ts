/** Durable append-only Autopilot audit store over DSH storage-domain. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  MAX_COMPLETION_DELIVERY_ATTEMPTS,
  RUN_STATE_VERSION,
  runAuditRecordSchema,
  runSnapshotSchema,
} from './run-state.ts'
import type { RunAuditRecord, RunOperation, RunSnapshot } from './run-state.ts'

/** DSH storage-domain declaration for append-only Autopilot records. */
export const runStoreDomainSpec = defineDomain({
  name: 'dsh_autopilot',
  version: RUN_STATE_VERSION,
  tables: {
    events: domainTable<string, RunAuditRecord>(runAuditRecordSchema),
  },
})

/** Corrupt or non-monotonic durable Autopilot history. */
export class RunStoreError extends Error {
  /** Stable storage failure category. */
  readonly code = 'AUTOPILOT_RUN_STORE_INVALID' as const

  /** @param message - Exact invariant violation. */
  constructor(message: string) {
    super(message)
    this.name = 'RunStoreError'
  }
}

/** Encode an arbitrary DSH SessionId as a storage key component. */
function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Build the unique key for one immutable audit row. */
export function runAuditKey(snapshot: RunSnapshot): string {
  return [
    encoded(snapshot.sessionId),
    String(snapshot.generation).padStart(12, '0'),
    encoded(snapshot.runId),
    String(snapshot.revision).padStart(12, '0'),
  ].join('.')
}

/** Whether one run phase permits replacement by a new run generation. */
function terminal(phase: RunSnapshot['phase']): boolean {
  return phase === 'completed' || phase === 'revoked'
}

/** Stable identity for aggregate limits that span one run generation. */
function runIdentity(snapshot: RunSnapshot): string {
  return `${snapshot.sessionId}\u0000${snapshot.runId}`
}

/** Exact UTF-8 storage cost of one JSON value. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Reject one internally inconsistent snapshot even when no prior revision exists. */
function assertSnapshotLimits(snapshot: RunSnapshot): void {
  if (snapshot.remainingActiveMs > snapshot.maxActiveMs) {
    throw new RunStoreError(`run "${snapshot.runId}" remaining active time exceeds its materialized maximum`)
  }
  if (snapshot.expiresAt !== undefined && snapshot.expiresAt > snapshot.updatedAt + snapshot.remainingActiveMs) {
    throw new RunStoreError(`run "${snapshot.runId}" expiry exceeds its remaining active-time grant`)
  }
  if (snapshot.budgets.maxConcurrentSubagents > snapshot.budgets.maxSubagents) {
    throw new RunStoreError(`run "${snapshot.runId}" concurrent subagent budget exceeds its total budget`)
  }
  if (snapshot.usage.verificationAttempts > snapshot.budgets.maxVerificationAttempts
    || snapshot.usage.dynamicPackages > snapshot.budgets.maxDynamicPackages
    || snapshot.usage.subagentsStarted > snapshot.budgets.maxSubagents) {
    throw new RunStoreError(`run "${snapshot.runId}" usage exceeds its materialized budget`)
  }
  const tasks = snapshot.plan?.tasks ?? []
  if (tasks.length > snapshot.budgets.maxTasks) {
    throw new RunStoreError(`run "${snapshot.runId}" task graph exceeds its materialized budget`)
  }
  const attempts = tasks.reduce((count, task) => count + task.attemptHistory.length, 0)
  if (attempts > snapshot.budgets.maxTaskAttempts) {
    throw new RunStoreError(`run "${snapshot.runId}" task-attempt history exceeds its materialized budget`)
  }
  const evidenceItems = tasks.reduce(
    (count, task) => count + task.evidence.length
      + task.attemptHistory.reduce((attemptCount, attempt) => attemptCount + attempt.evidence.length, 0),
    0,
  )
  if (evidenceItems > snapshot.budgets.maxEvidenceItems) {
    throw new RunStoreError(`run "${snapshot.runId}" task evidence exceeds its materialized budget`)
  }
  const sourceChars = snapshot.dynamicExtensions.reduce(
    (count, extension) => count + extension.hostCode.length,
    0,
  )
  if (sourceChars > snapshot.budgets.maxDynamicSourceChars) {
    throw new RunStoreError(`run "${snapshot.runId}" dynamic Host source exceeds its materialized budget`)
  }
  if (snapshot.revision > snapshot.budgets.maxAuditRecords) {
    throw new RunStoreError(`run "${snapshot.runId}" audit record count exceeds its materialized budget`)
  }
  if (jsonBytes(snapshot) > snapshot.budgets.maxSnapshotBytes) {
    throw new RunStoreError(`run "${snapshot.runId}" snapshot bytes exceed its materialized budget`)
  }
}

/** Reject a first row that already claims work or lifecycle progress. */
function assertStartSnapshot(snapshot: RunSnapshot): void {
  if (snapshot.phase !== 'running' || snapshot.usage.verificationAttempts !== 0
    || snapshot.usage.dynamicPackages !== 0 || snapshot.usage.subagentsStarted !== 0
    || snapshot.dynamicExtensions.length !== 0 || snapshot.verificationHistory.length !== 0
    || snapshot.plan !== undefined || snapshot.candidate !== undefined
    || snapshot.verificationPolicy !== undefined
    || snapshot.verificationBaseline !== undefined || snapshot.reason !== undefined
    || snapshot.flow.revision !== 1 || snapshot.flow.stage !== 'interview'
    || snapshot.flow.cycle !== 1 || snapshot.flow.planReviewAttempts !== 0
    || snapshot.flow.updatedAt !== snapshot.grantedAt
    || snapshot.flow.interview !== undefined || snapshot.flow.planReview !== undefined
    || (snapshot.completionDeliveryAttempts ?? 0) !== 0
    || (snapshot.completionDeliveryExhausted ?? false)
    || (snapshot.completionDeliveryExhaustionNotified ?? false)) {
    throw new RunStoreError(`run "${snapshot.runId}" has an invalid initial authorization snapshot`)
  }
}

/** Reject a valid-JSON revision that weakens or rewrites prior authorization. */
function assertSnapshotTransition(
  previous: RunSnapshot,
  next: RunSnapshot,
  operation: RunOperation,
): void {
  if (next.goalId !== previous.goalId || next.grantedAt !== previous.grantedAt) {
    throw new RunStoreError(`run "${next.runId}" changed immutable identity fields`)
  }
  if (next.autoResume !== previous.autoResume || next.selfModification !== previous.selfModification
    || JSON.stringify(next.budgets) !== JSON.stringify(previous.budgets)) {
    throw new RunStoreError(`run "${next.runId}" changed immutable authorization policy`)
  }
  if (previous.verificationBaseline !== undefined
    && JSON.stringify(next.verificationBaseline) !== JSON.stringify(previous.verificationBaseline)) {
    throw new RunStoreError(`run "${next.runId}" rewrote its frozen verification baseline`)
  }
  const delta = next.flow.revision - previous.flow.revision
  if (delta < 0 || delta > 1) {
    throw new RunStoreError(`run "${next.runId}" changed its canonical flow revision non-monotonically`)
  }
  if (delta === 0 && JSON.stringify(next.flow) !== JSON.stringify(previous.flow)) {
    throw new RunStoreError(`run "${next.runId}" rewrote canonical flow without advancing its revision`)
  }
  if (previous.flow.interview !== undefined
    && JSON.stringify(next.flow.interview) !== JSON.stringify(previous.flow.interview)) {
    throw new RunStoreError(`run "${next.runId}" rewrote its canonical interview artifact`)
  }
  const changed = delta === 1
  const allowedFlowOperations: readonly RunOperation[] = [
    'flow', 'needs-attention', 'plan', 'verification-start', 'verification-fail',
    'finalization-start', 'finalization-complete',
  ]
  if (changed && !allowedFlowOperations.includes(operation)) {
    throw new RunStoreError(`run "${next.runId}" changed canonical flow during ${operation}`)
  }
  if (changed) {
    const transition = `${previous.flow.stage}->${next.flow.stage}`
    const allowedTransitions: Readonly<Record<RunOperation, readonly string[]>> = {
      start: [], pause: [], resume: [], revoke: [], expire: [],
      'needs-attention': ['plan-review->planning'],
      plan: ['execution->planning'], task: [], subagent: [], 'dynamic-package': [],
      'dynamic-apply': [], 'dynamic-settle': [], 'dynamic-remove-begin': [],
      'dynamic-remove-settle': [], 'verification-policy': [], 'verification-baseline': [],
      flow: ['interview->planning', 'planning->plan-review', 'plan-review->planning',
        'plan-review->execution', 'code-review->qa'],
      'verification-start': ['execution->code-review'],
      'verification-fail': ['code-review->execution', 'qa->execution'],
      'finalization-start': ['code-review->qa'],
      'finalization-complete': ['qa->completed'],
      'verification-error': [], 'task-interrupt': [],
      'completion-reported': [], 'completion-delivery-failed': [],
      'completion-delivery-exhaustion-notified': [],
    }
    if (!allowedTransitions[operation].includes(transition)) {
      throw new RunStoreError(`run "${next.runId}" changed canonical flow ${transition} during ${operation}`)
    }
  }
  const previousVerificationPolicy = JSON.stringify(previous.verificationPolicy)
  const nextVerificationPolicy = JSON.stringify(next.verificationPolicy)
  if (previousVerificationPolicy !== nextVerificationPolicy) {
    if (previous.verificationPolicy !== undefined || operation !== 'verification-policy') {
      throw new RunStoreError(`run "${next.runId}" changed immutable verification policy`)
    }
  } else if (operation === 'verification-policy') {
    throw new RunStoreError(`run "${next.runId}" did not materialize a new verification policy`)
  }
  if (next.updatedAt < previous.updatedAt) {
    throw new RunStoreError(`run "${next.runId}" moved updatedAt backwards`)
  }
  if (next.maxActiveMs < previous.maxActiveMs
    || (next.maxActiveMs !== previous.maxActiveMs && operation !== 'resume')) {
    throw new RunStoreError(`run "${next.runId}" changed maxActiveMs outside resume`)
  }
  assertSnapshotLimits(next)
  const remainingIncrease = next.remainingActiveMs - previous.remainingActiveMs
  const maximumIncrease = next.maxActiveMs - previous.maxActiveMs
  if (remainingIncrease > 0 && (operation !== 'resume' || remainingIncrease > maximumIncrease)) {
    throw new RunStoreError(`run "${next.runId}" increased remaining active time without a matching resume grant`)
  }
  for (const key of ['verificationAttempts', 'dynamicPackages', 'subagentsStarted'] as const) {
    if (next.usage[key] < previous.usage[key]) {
      throw new RunStoreError(`run "${next.runId}" usage ${key} decreased`)
    }
  }
  if (next.verificationHistory.length < previous.verificationHistory.length
    || JSON.stringify(next.verificationHistory.slice(0, previous.verificationHistory.length))
      !== JSON.stringify(previous.verificationHistory)) {
    throw new RunStoreError(`run "${next.runId}" rewrote verification history`)
  }
  if (previous.completionReported && !next.completionReported) {
    throw new RunStoreError(`run "${next.runId}" cleared its completion acknowledgement`)
  }
  const previousDeliveryAttempts = previous.completionDeliveryAttempts ?? 0
  const nextDeliveryAttempts = next.completionDeliveryAttempts ?? 0
  const previousDeliveryExhausted = previous.completionDeliveryExhausted ?? false
  const nextDeliveryExhausted = next.completionDeliveryExhausted ?? false
  const previousDeliveryNotified = previous.completionDeliveryExhaustionNotified ?? false
  const nextDeliveryNotified = next.completionDeliveryExhaustionNotified ?? false
  if (operation === 'completion-delivery-failed') {
    if (previous.phase !== 'completed' || previous.completionReported || next.completionReported
      || nextDeliveryAttempts !== previousDeliveryAttempts + 1
      || nextDeliveryExhausted !== (nextDeliveryAttempts === MAX_COMPLETION_DELIVERY_ATTEMPTS)
      || nextDeliveryNotified !== previousDeliveryNotified
      || next.reason === undefined) {
      throw new RunStoreError(`run "${next.runId}" has an invalid completion delivery failure`)
    }
  } else if (operation === 'completion-delivery-exhaustion-notified') {
    if (previous.phase !== 'completed' || previous.completionReported || !previousDeliveryExhausted
      || previousDeliveryNotified || !nextDeliveryNotified
      || nextDeliveryAttempts !== previousDeliveryAttempts
      || nextDeliveryExhausted !== previousDeliveryExhausted) {
      throw new RunStoreError(`run "${next.runId}" has an invalid completion exhaustion notice`)
    }
  } else if (nextDeliveryAttempts !== previousDeliveryAttempts
    || nextDeliveryExhausted !== previousDeliveryExhausted
    || nextDeliveryNotified !== previousDeliveryNotified) {
    throw new RunStoreError(`run "${next.runId}" changed completion delivery state outside a failed attempt`)
  }
  if (previous.phase === 'revoked') {
    throw new RunStoreError(`revoked run "${next.runId}" cannot receive another revision`)
  }
  if (previous.phase === 'completed'
    && (next.phase !== 'completed'
      || (operation !== 'completion-reported' && operation !== 'completion-delivery-failed'
        && operation !== 'completion-delivery-exhaustion-notified'))) {
    throw new RunStoreError(`completed run "${next.runId}" permits only completion delivery updates`)
  }
  const allowed: Readonly<Record<Exclude<RunSnapshot['phase'], 'completed' | 'revoked'>, readonly RunSnapshot['phase'][]>> = {
    running: ['running', 'verifying', 'paused', 'needs-attention', 'exhausted', 'revoked'],
    verifying: ['running', 'verifying', 'finalizing', 'paused', 'needs-attention', 'exhausted', 'revoked'],
    finalizing: ['finalizing', 'completed', 'needs-attention'],
    paused: ['running', 'paused', 'needs-attention', 'revoked'],
    'needs-attention': ['running', 'needs-attention', 'revoked'],
    exhausted: ['running', 'needs-attention', 'exhausted', 'revoked'],
  }
  if (previous.phase !== 'completed' && !allowed[previous.phase].includes(next.phase)) {
    throw new RunStoreError(`run "${next.runId}" cannot transition ${previous.phase} to ${next.phase}`)
  }
  const operationPhases: Readonly<Record<RunOperation, readonly RunSnapshot['phase'][]>> = {
    start: ['running'],
    pause: ['paused'],
    resume: ['running'],
    revoke: ['revoked'],
    expire: ['exhausted'],
    'needs-attention': ['needs-attention'],
    plan: ['running'],
    task: ['running'],
    'task-interrupt': ['running', 'verifying'],
    subagent: ['running', 'verifying'],
    'dynamic-package': ['running'],
    'dynamic-apply': ['running'],
    'dynamic-settle': ['running'],
    'dynamic-remove-begin': ['running'],
    'dynamic-remove-settle': ['running'],
    'verification-policy': ['running'],
    'verification-baseline': ['running'],
    flow: ['running', 'verifying'],
    'verification-start': ['verifying'],
    'verification-fail': ['running'],
    'finalization-start': ['finalizing'],
    'finalization-complete': ['completed'],
    'completion-delivery-failed': ['completed'],
    'completion-delivery-exhaustion-notified': ['completed'],
    'completion-reported': ['completed'],
    'verification-error': ['paused'],
  }
  if (!operationPhases[operation].includes(next.phase)) {
    throw new RunStoreError(`operation ${operation} cannot produce phase ${next.phase}`)
  }
}

/** Deterministic audit ordering independent of backend record iteration. */
function compareRecords(left: RunAuditRecord, right: RunAuditRecord): number {
  return left.snapshot.sessionId.localeCompare(right.snapshot.sessionId)
    || left.snapshot.generation - right.snapshot.generation
    || left.snapshot.revision - right.snapshot.revision
    || left.snapshot.runId.localeCompare(right.snapshot.runId)
}

/** Validate and fold durable rows into one current snapshot per DSH Session. */
export function foldRunAudit(
  records: readonly RunAuditRecord[],
): { readonly current: ReadonlyMap<string, RunSnapshot>; readonly history: readonly RunAuditRecord[] } {
  const ordered = [...records].sort(compareRecords)
  const current = new Map<string, RunSnapshot>()
  const previousByRun = new Map<string, RunSnapshot>()
  const bytesByRun = new Map<string, number>()
  for (const record of ordered) {
    runAuditRecordSchema.parse(record)
    const snapshot = record.snapshot
    assertSnapshotLimits(snapshot)
    const runKey = runIdentity(snapshot)
    const auditBytes = (bytesByRun.get(runKey) ?? 0) + jsonBytes(record)
    if (auditBytes > snapshot.budgets.maxAuditBytes) {
      throw new RunStoreError(`run "${snapshot.runId}" audit bytes exceed its materialized budget`)
    }
    bytesByRun.set(runKey, auditBytes)
    const previousRun = previousByRun.get(runKey)
    if (previousRun === undefined) {
      if (record.operation !== 'start' || snapshot.revision !== 1) {
        throw new RunStoreError(
          `run "${snapshot.runId}" must begin with revision 1 and operation start`,
        )
      }
      assertStartSnapshot(snapshot)
    } else {
      if (snapshot.generation !== previousRun.generation
        || snapshot.revision !== previousRun.revision + 1) {
        throw new RunStoreError(
          `run "${snapshot.runId}" revision ${snapshot.revision} does not follow ${previousRun.revision}`,
        )
      }
      assertSnapshotTransition(previousRun, snapshot, record.operation)
    }
    previousByRun.set(runKey, snapshot)

    const priorCurrent = current.get(snapshot.sessionId)
    if (priorCurrent === undefined || snapshot.generation > priorCurrent.generation) {
      if (priorCurrent !== undefined) {
        if (snapshot.generation !== priorCurrent.generation + 1) {
          throw new RunStoreError(
            `session "${snapshot.sessionId}" skipped run generation ${priorCurrent.generation + 1}`,
          )
        }
        if (!terminal(priorCurrent.phase)) {
          throw new RunStoreError(
            `session "${snapshot.sessionId}" started a new run before generation ${priorCurrent.generation} became terminal`,
          )
        }
      } else if (snapshot.generation !== 1) {
        throw new RunStoreError(`session "${snapshot.sessionId}" must begin at run generation 1`)
      }
      current.set(snapshot.sessionId, snapshot)
    } else {
      if (snapshot.runId !== priorCurrent.runId) {
        throw new RunStoreError(
          `session "${snapshot.sessionId}" has two run ids in generation ${snapshot.generation}`,
        )
      }
      /* v8 ignore next -- ordered, contiguous revisions always advance the current generation. */
      if (snapshot.revision > priorCurrent.revision) current.set(snapshot.sessionId, snapshot)
    }
  }
  return Object.freeze({ current, history: Object.freeze(ordered) })
}

/** Run-state persistence whose in-memory cache changes only after durable writes. */
export class DurableRunStore {
  private readonly current = new Map<string, RunSnapshot>()
  private readonly auditBytesByRun = new Map<string, number>()
  private historyRecords: readonly RunAuditRecord[] = Object.freeze([])
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly domain: Domain<typeof runStoreDomainSpec>,
    private readonly table: KvTable<string, RunAuditRecord>,
  ) {}

  /** Open and validate the complete audit history. */
  static async open(ctx: Context): Promise<DurableRunStore> {
    const domain = await ctx.storageDomain.open(runStoreDomainSpec)
    try {
      const table = domain.table('events')
      const store = new DurableRunStore(domain, table)
      store.rebuild([...table.entries()].map(([, record]) => record))
      return store
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /** Read the latest detached immutable snapshot for one DSH Session. */
  get(sessionId: string): RunSnapshot | undefined {
    return this.current.get(sessionId)
  }

  /** Return one latest snapshot per session in stable session-id order. */
  currentRuns(): readonly RunSnapshot[] {
    return Object.freeze(
      [...this.current.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    )
  }

  /** Return the immutable audit history, optionally narrowed to one session. */
  history(sessionId?: string): readonly RunAuditRecord[] {
    return sessionId === undefined
      ? this.historyRecords
      : Object.freeze(this.historyRecords.filter(record => record.snapshot.sessionId === sessionId))
  }

  /**
   * Append one whole-snapshot mutation and publish it to the current cache.
   * @param operation - Mutation classification.
   * @param snapshot - Complete post-mutation state.
   * @returns the durably stored snapshot.
   */
  async append(operation: RunOperation, snapshot: RunSnapshot): Promise<RunSnapshot> {
    const write = this.writeTail.then(() => this.appendSerialized(operation, snapshot))
    this.writeTail = write.then(() => undefined, () => undefined)
    return write
  }

  /**
   * Append only when the named run revision is still current.
   * @param operation - Mutation classification.
   * @param expected - Run identity and revision observed before preparing the mutation.
   * @param snapshot - Complete post-mutation state.
   * @returns The stored snapshot, or `undefined` when another mutation won the compare-and-set.
   */
  async appendIfCurrent(
    operation: RunOperation,
    expected: Pick<RunSnapshot, 'sessionId' | 'runId' | 'generation' | 'revision'>,
    snapshot: RunSnapshot,
  ): Promise<RunSnapshot | undefined> {
    const write = this.writeTail.then(() => {
      const current = this.current.get(expected.sessionId)
      if (current === undefined || current.runId !== expected.runId
        || current.generation !== expected.generation || current.revision !== expected.revision) {
        return undefined
      }
      return this.appendSerialized(operation, snapshot)
    })
    this.writeTail = write.then(() => undefined, () => undefined)
    return write
  }

  /**
   * Derive and append one mutation while holding the store's per-process write
   * serialization point. The reducer observes the latest committed snapshot,
   * so a safety transition cannot be prepared from a revision that another
   * queued mutation has already replaced.
   * @param sessionId - Exact DSH Session whose current run is reduced.
   * @param reducer - Pure synchronous derivation and mutation classification from the serialized current row.
   * @returns The stored snapshot, or `undefined` when the reducer deliberately makes no change.
   */
  async reduceCurrent(
    sessionId: string,
    reducer: (
      current: RunSnapshot | undefined,
    ) => { readonly operation: RunOperation; readonly snapshot: RunSnapshot } | undefined,
  ): Promise<RunSnapshot | undefined> {
    const write = this.writeTail.then(() => {
      const mutation = reducer(this.current.get(sessionId))
      return mutation === undefined
        ? undefined
        : this.appendSerialized(mutation.operation, mutation.snapshot)
    })
    this.writeTail = write.then(() => undefined, () => undefined)
    return write
  }

  private async appendSerialized(operation: RunOperation, snapshot: RunSnapshot): Promise<RunSnapshot> {
    runSnapshotSchema.parse(snapshot)
    assertSnapshotLimits(snapshot)
    this.assertAppend(operation, snapshot)
    const record: RunAuditRecord = Object.freeze({
      version: RUN_STATE_VERSION,
      operation,
      time: snapshot.updatedAt,
      snapshot,
    })
    const identity = runIdentity(snapshot)
    const auditBytes = (this.auditBytesByRun.get(identity) ?? 0) + jsonBytes(record)
    if (auditBytes > snapshot.budgets.maxAuditBytes) {
      throw new RunStoreError(`run "${snapshot.runId}" audit bytes exceed its materialized budget`)
    }
    const key = runAuditKey(snapshot)
    if (this.table.get(key) !== undefined) throw new RunStoreError(`audit key "${key}" already exists`)
    await this.table.put(key, record)
    this.auditBytesByRun.set(identity, auditBytes)
    this.current.set(snapshot.sessionId, snapshot)
    this.historyRecords = Object.freeze([...this.historyRecords, record].sort(compareRecords))
    return snapshot
  }

  /** Close the owned DSH storage-domain handle after draining writes. */
  async close(): Promise<void> {
    await this.writeTail
    await this.domain.close()
  }

  private rebuild(records: readonly RunAuditRecord[]): void {
    const folded = foldRunAudit(records)
    this.current.clear()
    this.auditBytesByRun.clear()
    for (const [sessionId, snapshot] of folded.current) this.current.set(sessionId, snapshot)
    for (const record of folded.history) {
      const identity = runIdentity(record.snapshot)
      this.auditBytesByRun.set(
        identity,
        (this.auditBytesByRun.get(identity) ?? 0) + jsonBytes(record),
      )
    }
    this.historyRecords = folded.history
  }

  private assertAppend(operation: RunOperation, snapshot: RunSnapshot): void {
    const current = this.current.get(snapshot.sessionId)
    if (operation === 'start') {
      if (snapshot.revision !== 1) throw new RunStoreError('a start snapshot must have revision 1')
      assertStartSnapshot(snapshot)
      const expectedGeneration = (current?.generation ?? 0) + 1
      if (snapshot.generation !== expectedGeneration) {
        throw new RunStoreError(`start generation ${snapshot.generation} must be ${expectedGeneration}`)
      }
      if (current !== undefined && !terminal(current.phase)) {
        throw new RunStoreError(`cannot start a new run while generation ${current.generation} is ${current.phase}`)
      }
      return
    }
    if (current === undefined) throw new RunStoreError(`cannot append ${operation} before start`)
    if (snapshot.runId !== current.runId || snapshot.generation !== current.generation) {
      throw new RunStoreError('mutation targets a stale run identity')
    }
    if (snapshot.revision !== current.revision + 1) {
      throw new RunStoreError(`revision ${snapshot.revision} must follow ${current.revision}`)
    }
    if (snapshot.goalId !== current.goalId || snapshot.grantedAt !== current.grantedAt) {
      throw new RunStoreError('mutation changed immutable run identity fields')
    }
    assertSnapshotTransition(current, snapshot, operation)
  }
}
