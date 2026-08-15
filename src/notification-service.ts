/** Deployment-owned HTTPS completion notifications over a durable outbox. */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import s from '@deepseek-ai/schemastery'
import type { RunOperation, RunSnapshot } from './run-state.ts'
import type { AutonomyLeaseView } from './service.ts'
import {
  beginNotificationAttempt,
  deliverNotification,
  failNotification,
  notificationReasonCode,
  prepareNotification,
  retryNotification,
} from './notification-state.ts'
import type {
  CompletionNotificationEvent,
  CompletionNotificationObjectiveSha256Source,
  CompletionNotificationPayload,
  NotificationFailureCode,
  NotificationSnapshot,
} from './notification-state.ts'
import { DurableNotificationStore } from './notification-store.ts'

/** Default events selected when notifications are explicitly enabled. */
export const DEFAULT_NOTIFICATION_EVENTS: readonly CompletionNotificationEvent[] = Object.freeze([
  'completed',
  'needs-attention',
  'exhausted',
])

/** Hard deployment ceiling for one HTTPS request. */
export const MAX_NOTIFICATION_TIMEOUT_MS = 60_000

/** Hard deployment ceiling for total attempts per outbox item. */
export const MAX_NOTIFICATION_ATTEMPTS = 32

/** Hard deployment ceiling for one retry delay. */
export const MAX_NOTIFICATION_RETRY_MS = 3_600_000

/** Hard deployment ceiling for simultaneously active outbox items. */
export const MAX_PENDING_NOTIFICATIONS = 4_096

/** Hard per-item ceiling for immutable outbox audit bytes. */
export const MAX_NOTIFICATION_AUDIT_BYTES = 1_048_576

/** Smallest useful per-item immutable outbox audit-byte allowance. */
export const MIN_NOTIFICATION_AUDIT_BYTES = 4_096

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 60_000
const DEFAULT_MAX_PENDING = 256
const DEFAULT_MAX_AUDIT_BYTES = 262_144
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Deployment-fixed webhook settings; no model-visible surface accepts them. */
export interface CompletionNotificationConfig {
  readonly enabled?: boolean
  readonly webhookUrl?: string
  readonly events?: CompletionNotificationEvent[]
  readonly timeoutMs?: number
  readonly maxAttempts?: number
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
  readonly maxPendingNotifications?: number
  readonly maxAuditBytes?: number
}

interface ResolvedNotificationConfig {
  readonly enabled: boolean
  readonly webhookUrl?: string
  readonly events: ReadonlySet<CompletionNotificationEvent>
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly maxPendingNotifications: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly policySha256?: string
}

/** One transport request whose URL and metadata come only from Host configuration. */
export interface NotificationTransportRequest {
  readonly webhookUrl: string
  readonly notificationId: string
  readonly payload: CompletionNotificationPayload
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/**
 * Deployment-owned delivery seam. Implementations must settle promptly after
 * `signal` aborts so HMR and shutdown can drain without an orphan request.
 */
export interface NotificationTransport {
  /** @param request - Fixed endpoint, safe body, hard timeout, and cancellation signal. */
  deliver(request: NotificationTransportRequest): Promise<void>
}

/** Fixed HTTPS transport failure without response bodies or endpoint data. */
export class NotificationTransportError extends Error {
  /** Machine-readable transport failure classification. */
  readonly code = 'AUTOPILOT_NOTIFICATION_TRANSPORT_FAILED' as const

  /** @param message - Non-sensitive fixed failure description. */
  constructor(message: string) {
    super(message)
    this.name = 'NotificationTransportError'
  }
}

/** Built-in HTTPS POST transport with fixed headers and no credential input. */
export class HttpsNotificationTransport implements NotificationTransport {
  async deliver(request: NotificationTransportRequest): Promise<void> {
    const webhookUrl = normalizedHttpsUrl(request.webhookUrl)
    const response = await fetch(webhookUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-dsh-autopilot-notification-id': request.notificationId,
      },
      body: JSON.stringify(request.payload),
      signal: request.signal,
    })
    if (!response.ok) {
      throw new NotificationTransportError('notification webhook rejected the request')
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotNotifications: CompletionNotificationService
  }
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${field} must be a positive safe integer no greater than ${maximum}`)
  }
  return resolved
}

function normalizedHttpsUrl(value: string): string {
  if (value.length > 2_048) throw new TypeError('webhookUrl exceeds 2048 characters')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('webhookUrl must be an absolute HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.hostname.length === 0
    || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new TypeError('webhookUrl must be HTTPS without userinfo or a fragment')
  }
  return url.href
}

function resolveEvents(
  events: readonly CompletionNotificationEvent[] | undefined,
): ReadonlySet<CompletionNotificationEvent> {
  const selected = events ?? DEFAULT_NOTIFICATION_EVENTS
  const allowed = new Set<CompletionNotificationEvent>([
    'completed', 'needs-attention', 'exhausted', 'revoked',
  ])
  const resolved = new Set<CompletionNotificationEvent>()
  for (const event of selected) {
    if (!allowed.has(event)) throw new TypeError(`unsupported notification event "${String(event)}"`)
    if (resolved.has(event)) throw new TypeError(`notification event "${event}" is duplicated`)
    resolved.add(event)
  }
  return resolved
}

function policyFingerprint(config: {
  readonly webhookUrl: string
  readonly events: ReadonlySet<CompletionNotificationEvent>
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly maxPendingNotifications: number
  readonly maxAuditBytes: number
}): string {
  return createHash('sha256').update(JSON.stringify({
    webhookUrl: config.webhookUrl,
    events: [...config.events].sort(),
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
    maxPendingNotifications: config.maxPendingNotifications,
    maxAuditBytes: config.maxAuditBytes,
  })).digest('hex')
}

function resolveConfig(config: CompletionNotificationConfig): ResolvedNotificationConfig {
  const enabled = config.enabled ?? false
  const events = resolveEvents(config.events)
  const timeoutMs = configuredInteger(
    config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', MAX_NOTIFICATION_TIMEOUT_MS,
  )
  const maxAttempts = configuredInteger(
    config.maxAttempts, DEFAULT_MAX_ATTEMPTS, 'maxAttempts', MAX_NOTIFICATION_ATTEMPTS,
  )
  const retryBaseMs = configuredInteger(
    config.retryBaseMs, DEFAULT_RETRY_BASE_MS, 'retryBaseMs', MAX_NOTIFICATION_RETRY_MS,
  )
  const retryMaxMs = configuredInteger(
    config.retryMaxMs, DEFAULT_RETRY_MAX_MS, 'retryMaxMs', MAX_NOTIFICATION_RETRY_MS,
  )
  if (retryBaseMs > retryMaxMs) throw new TypeError('retryBaseMs cannot exceed retryMaxMs')
  const maxPendingNotifications = configuredInteger(
    config.maxPendingNotifications,
    DEFAULT_MAX_PENDING,
    'maxPendingNotifications',
    MAX_PENDING_NOTIFICATIONS,
  )
  const maxAuditBytes = configuredInteger(
    config.maxAuditBytes,
    DEFAULT_MAX_AUDIT_BYTES,
    'maxAuditBytes',
    MAX_NOTIFICATION_AUDIT_BYTES,
  )
  if (maxAuditBytes < MIN_NOTIFICATION_AUDIT_BYTES) {
    throw new TypeError(`maxAuditBytes must be at least ${MIN_NOTIFICATION_AUDIT_BYTES}`)
  }
  const webhookUrl = config.webhookUrl === undefined ? undefined : normalizedHttpsUrl(config.webhookUrl)
  if (enabled && webhookUrl === undefined) {
    throw new TypeError('enabled completion notifications require webhookUrl')
  }
  const shared = {
    enabled,
    events,
    timeoutMs,
    maxAttempts,
    retryBaseMs,
    retryMaxMs,
    maxPendingNotifications,
    maxAuditRecords: 1 + (2 * maxAttempts),
    maxAuditBytes,
  }
  if (webhookUrl === undefined) return shared
  return {
    ...shared,
    webhookUrl,
    policySha256: policyFingerprint({
      webhookUrl,
      events,
      timeoutMs,
      maxAttempts,
      retryBaseMs,
      retryMaxMs,
      maxPendingNotifications,
      maxAuditBytes,
    }),
  }
}

function eventFromChange(
  operation: RunOperation,
  phase: AutonomyLeaseView['phase'],
): CompletionNotificationEvent | undefined {
  const event = operation === 'finalization-complete'
    ? 'completed'
    : operation === 'needs-attention'
      ? 'needs-attention'
      : operation === 'expire'
        ? 'exhausted'
        : operation === 'revoke' ? 'revoked' : undefined
  return event === phase ? event : undefined
}

function eventFromCurrentPhase(
  phase: AutonomyLeaseView['phase'],
): CompletionNotificationEvent | undefined {
  return phase === 'completed' || phase === 'needs-attention' || phase === 'exhausted' || phase === 'revoked'
    ? phase
    : undefined
}

function objectiveSha256(objective: string): string {
  return createHash('sha256').update(objective).digest('hex')
}

function durableGoalIdFallbackSha256(goalId: string): string {
  return createHash('sha256')
    .update('dsh-autopilot:completion-notification:durable-goal-id-fallback:v1\u0000')
    .update(goalId)
    .digest('hex')
}

function nextMutationTime(snapshot: NotificationSnapshot): number {
  return Math.max(Date.now(), snapshot.updatedAt + 1)
}

/** Return capped exponential delay after the specified failed attempt count. */
export function notificationRetryDelay(
  attempts: number,
  baseMs: number,
  maximumMs: number,
): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1
    || !Number.isSafeInteger(baseMs) || baseMs < 1
    || !Number.isSafeInteger(maximumMs) || maximumMs < baseMs) {
    throw new TypeError('retry delay inputs are invalid')
  }
  return Math.min(baseMs * (2 ** Math.min(attempts - 1, 30)), maximumMs)
}

/**
 * Host service that captures fixed Autopilot outcomes and drains a durable webhook outbox.
 * Delivery is at-least-once after enqueue. A crash after remote acceptance but before the
 * delivered revision is durable causes a repeat; this service does not promise exactly-once.
 */
export class CompletionNotificationService extends Service {
  static inject = ['agents', 'autonomy', 'goals', 'storageDomain']

  static Config: s<CompletionNotificationConfig> = s.object({
    enabled: s.boolean().default(false),
    webhookUrl: s.string(),
    events: s.array(s.union([
      'completed', 'needs-attention', 'exhausted', 'revoked',
    ] as const)).default([...DEFAULT_NOTIFICATION_EVENTS]),
    timeoutMs: s.number().step(1).min(1).max(MAX_NOTIFICATION_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    maxAttempts: s.number().step(1).min(1).max(MAX_NOTIFICATION_ATTEMPTS).default(DEFAULT_MAX_ATTEMPTS),
    retryBaseMs: s.number().step(1).min(1).max(MAX_NOTIFICATION_RETRY_MS).default(DEFAULT_RETRY_BASE_MS),
    retryMaxMs: s.number().step(1).min(1).max(MAX_NOTIFICATION_RETRY_MS).default(DEFAULT_RETRY_MAX_MS),
    maxPendingNotifications: s.number().step(1).min(1).max(MAX_PENDING_NOTIFICATIONS)
      .default(DEFAULT_MAX_PENDING),
    maxAuditBytes: s.number().step(1).min(MIN_NOTIFICATION_AUDIT_BYTES).max(MAX_NOTIFICATION_AUDIT_BYTES)
      .default(DEFAULT_MAX_AUDIT_BYTES),
  })

  private readonly config: ResolvedNotificationConfig
  private readonly transport: NotificationTransport
  private readonly shutdown = new AbortController()
  private store: DurableNotificationStore | undefined
  private observerTail: Promise<void> = Promise.resolve()
  private recoveryScanTask: Promise<void> | undefined
  private pumpTask: Promise<void> | undefined
  private wakeTimer: NodeJS.Timeout | undefined
  private wakeAt: number | undefined
  private operationalBackoffUntil = 0
  private stopped = false

  /**
   * @param ctx - Host context carrying Autonomy, Goals, Agents, and storage-domain.
   * @param config - Deployment-owned endpoint, allowlist, and bounded retry policy.
   * @param transport - Optional deployment transport seam; defaults to fixed HTTPS POST.
   */
  constructor(
    ctx: Context,
    config: CompletionNotificationConfig = {},
    transport: NotificationTransport = new HttpsNotificationTransport(),
  ) {
    super(ctx, 'autopilotNotifications')
    this.config = resolveConfig(config)
    this.transport = transport
  }

  /** Open durable state and begin recovery only after explicit deployment opt-in. */
  protected async [Service.init](): Promise<void> {
    if (!this.config.enabled) return
    const store = await DurableNotificationStore.open(this.ctx)
    this.store = store
    this.ctx.effect(() => async () => {
      this.stopped = true
      this.clearWakeTimer()
      this.shutdown.abort()
      await this.observerTail
      await this.pumpTask
      /* v8 ignore else -- this cleanup exclusively owns the opened store slot. */
      if (this.store === store) this.store = undefined
      await store.close()
    }, 'dsh-autopilot.notificationStoreClose')

    this.ctx.on('autonomy/changed', ({ agent, operation, view }) => {
      const event = eventFromChange(operation, view.phase)
      return event === undefined ? undefined : this.capture(agent, view, event)
    })
    this.ctx.on('agent/created', ({ agent }) => {
      void this.captureCurrent(agent)
    })
    for (const agent of this.ctx.agents.list()) void this.captureCurrent(agent)
    for (const snapshot of this.ctx.autonomy.currentSnapshots()) void this.captureDurableCurrent(snapshot)
    this.recoveryScanTask = this.captureAfterRecovery()
    this.requestPump()
  }

  /** Return current safe outbox rows without endpoint configuration. */
  list(agent?: Agent): readonly NotificationSnapshot[] {
    const store = this.store
    if (store === undefined) return Object.freeze([])
    return store.list(agent === undefined ? {} : { sessionId: String(agent.id) })
  }

  /** Drain capture and currently due delivery work without waiting for future retries. */
  async whenIdle(): Promise<void> {
    const recoveryScan = this.recoveryScanTask
    if (recoveryScan !== undefined) await recoveryScan
    await this.observerTail
    const pump = this.pumpTask
    if (pump !== undefined) await pump
    await this.observerTail
  }

  private async captureAfterRecovery(): Promise<void> {
    await this.ctx.autonomy.whenRecoveryIdle()
    if (this.stopped) return
    for (const snapshot of this.ctx.autonomy.currentSnapshots()) {
      await this.captureDurableCurrent(snapshot)
    }
  }

  private captureCurrent(agent: Agent): Promise<void> {
    const view = this.ctx.autonomy.get(agent)
    if (view === undefined) return Promise.resolve()
    const event = eventFromCurrentPhase(view.phase)
    return event === undefined ? Promise.resolve() : this.capture(agent, view, event, true)
  }

  private captureDurableCurrent(snapshot: RunSnapshot): Promise<void> {
    const event = eventFromCurrentPhase(snapshot.phase)
    if (event === undefined) return Promise.resolve()
    return this.captureResolved({
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      revision: snapshot.revision,
      event,
      objectiveSha256: durableGoalIdFallbackSha256(snapshot.goalId),
      objectiveSha256Source: 'durable-goal-id-fallback',
      verificationAttempts: snapshot.usage.verificationAttempts,
      dynamicPackages: snapshot.usage.dynamicPackages,
      subagentsStarted: snapshot.usage.subagentsStarted,
    }, true)
  }

  private capture(
    agent: Agent,
    view: AutonomyLeaseView,
    event: CompletionNotificationEvent,
    reconcileExisting = false,
  ): Promise<void> {
    if (this.stopped || !this.config.events.has(event)) return Promise.resolve()
    try {
      if (this.ctx.agents.get(agent.id) !== agent) {
        throw new Error('notification event does not belong to the exact live Agent')
      }
      const goal = this.ctx.goals.get(agent)
      if (goal === undefined || String(goal.id) !== String(view.goalId)) {
        throw new Error('notification event does not match the exact live Goal')
      }
      return this.captureResolved({
        sessionId: String(agent.id),
        runId: view.id,
        generation: view.generation,
        revision: view.revision,
        event,
        objectiveSha256: objectiveSha256(goal.objective),
        objectiveSha256Source: 'goal-objective',
        verificationAttempts: view.verificationAttempts,
        dynamicPackages: view.dynamicPackages,
        subagentsStarted: view.subagentsStarted,
      }, reconcileExisting)
    } catch (error: unknown) {
      this.logContained('capture', error)
      return Promise.resolve()
    }
  }

  private captureResolved(
    input: {
      readonly sessionId: string
      readonly runId: string
      readonly generation: number
      readonly revision: number
      readonly event: CompletionNotificationEvent
      readonly objectiveSha256: string
      readonly objectiveSha256Source: CompletionNotificationObjectiveSha256Source
      readonly verificationAttempts: number
      readonly dynamicPackages: number
      readonly subagentsStarted: number
    },
    reconcileExisting: boolean,
  ): Promise<void> {
    if (this.stopped || !this.config.events.has(input.event)) return Promise.resolve()
    try {
      const policySha256 = this.config.policySha256
      /* v8 ignore next -- enabled configuration always materializes a validated endpoint fingerprint. */
      if (policySha256 === undefined) throw new Error('notification policy is unavailable')
      const payload: CompletionNotificationPayload = Object.freeze({
        objectiveSha256: input.objectiveSha256,
        objectiveSha256Source: input.objectiveSha256Source,
        phase: input.event,
        reasonCode: notificationReasonCode(input.event),
        usage: Object.freeze({
          verificationAttempts: input.verificationAttempts,
          dynamicPackages: input.dynamicPackages,
          subagentsStarted: input.subagentsStarted,
        }),
      })
      const snapshot = prepareNotification({
        sessionId: input.sessionId,
        runId: input.runId,
        generation: input.generation,
        runRevision: input.revision,
        event: input.event,
        policySha256,
        payload,
        maxAttempts: this.config.maxAttempts,
        maxPendingNotifications: this.config.maxPendingNotifications,
        maxAuditRecords: this.config.maxAuditRecords,
        maxAuditBytes: this.config.maxAuditBytes,
      }, Date.now())
      return this.enqueueCapture(snapshot, reconcileExisting)
    } catch (error: unknown) {
      this.logContained('capture', error)
      return Promise.resolve()
    }
  }

  private enqueueCapture(snapshot: NotificationSnapshot, reconcileExisting = false): Promise<void> {
    const work = this.observerTail.then(async () => {
      if (this.stopped) return
      const store = this.requireStore()
      if (reconcileExisting && store.get(snapshot.notificationId) !== undefined) return
      const stored = await store.enqueue(snapshot)
      if (stored.phase !== 'delivered' && stored.phase !== 'failed') this.requestPump()
    })
    const contained = work.catch((error: unknown) => {
      this.logContained('durable capture', error)
    })
    this.observerTail = contained
    return contained
  }

  private requestPump(): void {
    if (this.stopped || this.pumpTask !== undefined || this.store === undefined) return
    this.clearWakeTimer()
    const task = this.pumpLoop().catch((error: unknown) => {
      this.operationalBackoffUntil = Date.now() + this.config.retryBaseMs
      this.logContained('outbox worker', error)
    })
    this.pumpTask = task
    void task.finally(() => {
      /* v8 ignore else -- one pump occupies the slot until this exact task settles. */
      if (this.pumpTask === task) this.pumpTask = undefined
      this.planNextPump()
    })
  }

  private async pumpLoop(): Promise<void> {
    while (!this.stopped) {
      const candidate = this.nextCandidate()
      if (candidate === undefined || this.nextReadyAt(candidate) > Date.now()
        || this.operationalBackoffUntil > Date.now()) return
      await this.deliverOne(candidate)
    }
  }

  private nextCandidate(): NotificationSnapshot | undefined {
    return [...this.requireStore().list({ active: true })].sort((left, right) =>
      this.nextReadyAt(left) - this.nextReadyAt(right)
      || left.createdAt - right.createdAt
      || left.notificationId.localeCompare(right.notificationId))[0]
  }

  private nextReadyAt(snapshot: NotificationSnapshot): number {
    return snapshot.phase === 'sending' ? 0 : snapshot.nextAttemptAt ?? 0
  }

  private async deliverOne(observed: NotificationSnapshot): Promise<void> {
    const store = this.requireStore()
    const policySha256 = this.config.policySha256
    if (policySha256 === undefined || observed.policySha256 !== policySha256) {
      const failed = failNotification(observed, 'policy-drift', nextMutationTime(observed))
      await store.appendIfCurrent('fail', observed, failed)
      return
    }
    if (observed.phase === 'sending' && observed.attempts >= observed.maxAttempts) {
      const failed = failNotification(observed, 'attempt-limit', nextMutationTime(observed))
      await store.appendIfCurrent('fail', observed, failed)
      return
    }
    const attempting = beginNotificationAttempt(observed, nextMutationTime(observed))
    const stored = await store.appendIfCurrent('attempt', observed, attempting)
    if (stored === undefined) return
    const controller = new AbortController()
    let timedOut = false
    const onShutdown = () => controller.abort()
    this.shutdown.signal.addEventListener('abort', onShutdown, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.config.timeoutMs)
    try {
      const webhookUrl = this.config.webhookUrl
      /* v8 ignore next -- enabled configuration always has one validated URL. */
      if (webhookUrl === undefined) throw new Error('notification endpoint is unavailable')
      await this.transport.deliver({
        webhookUrl,
        notificationId: stored.notificationId,
        payload: stored.payload,
        timeoutMs: this.config.timeoutMs,
        signal: controller.signal,
      })
      const delivered = deliverNotification(stored, nextMutationTime(stored))
      await store.appendIfCurrent('deliver', stored, delivered)
    } catch {
      const code: NotificationFailureCode = this.shutdown.signal.aborted
        ? 'service-stopped'
        : timedOut ? 'timeout' : 'transport-error'
      await this.settleFailure(stored, code)
    } finally {
      clearTimeout(timeout)
      this.shutdown.signal.removeEventListener('abort', onShutdown)
    }
  }

  private async settleFailure(
    snapshot: NotificationSnapshot,
    code: NotificationFailureCode,
  ): Promise<void> {
    const store = this.requireStore()
    const now = nextMutationTime(snapshot)
    if (snapshot.attempts >= snapshot.maxAttempts) {
      await store.appendIfCurrent('fail', snapshot, failNotification(snapshot, code, now))
      return
    }
    const delay = notificationRetryDelay(
      snapshot.attempts,
      this.config.retryBaseMs,
      this.config.retryMaxMs,
    )
    await store.appendIfCurrent(
      'retry',
      snapshot,
      retryNotification(snapshot, code, now + delay, now),
    )
  }

  private planNextPump(): void {
    if (this.stopped || this.pumpTask !== undefined || this.store === undefined) return
    const candidate = this.nextCandidate()
    if (candidate === undefined) return
    const readyAt = Math.max(this.nextReadyAt(candidate), this.operationalBackoffUntil)
    const delay = Math.max(0, Math.min(readyAt - Date.now(), MAX_TIMER_DELAY_MS))
    if (delay === 0) {
      this.requestPump()
      return
    }
    if (this.wakeTimer !== undefined && this.wakeAt !== undefined && this.wakeAt <= readyAt) return
    this.clearWakeTimer()
    this.wakeAt = readyAt
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      this.wakeAt = undefined
      this.requestPump()
    }, delay)
    this.wakeTimer.unref()
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    this.wakeAt = undefined
  }

  private requireStore(): DurableNotificationStore {
    if (this.store === undefined) throw new Error('completion notification store is unavailable')
    return this.store
  }

  private logContained(stage: string, error: unknown): void {
    this.ctx.logger.error(`dsh-autopilot: notification ${stage} failed: ${String(error)}`)
  }
}

export default CompletionNotificationService
