import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CompletionNotificationService, {
  HttpsNotificationTransport,
  MAX_NOTIFICATION_ATTEMPTS,
  MAX_NOTIFICATION_AUDIT_BYTES,
  MAX_NOTIFICATION_RETRY_MS,
  MAX_NOTIFICATION_TIMEOUT_MS,
  MAX_PENDING_NOTIFICATIONS,
  MIN_NOTIFICATION_AUDIT_BYTES,
  notificationRetryDelay,
  NotificationTransportError,
} from '../../src/notification-service.ts'
import type {
  CompletionNotificationConfig,
  NotificationTransport,
  NotificationTransportRequest,
} from '../../src/notification-service.ts'
import {
  beginNotificationAttempt,
  deliverNotification,
  notificationReasonCode,
  prepareNotification,
} from '../../src/notification-state.ts'
import type {
  CompletionNotificationEvent,
  NotificationSnapshot,
  PrepareNotificationInput,
} from '../../src/notification-state.ts'
import { DurableNotificationStore } from '../../src/notification-store.ts'
import type { AutonomyLeaseView } from '../../src/service.ts'
import { createServiceHarness, createTestAgent } from '../helpers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function serviceClass(transport: NotificationTransport) {
  return class TestCompletionNotificationService extends CompletionNotificationService {
    constructor(ctx: Context, config: CompletionNotificationConfig = {}) {
      super(ctx, config, transport)
    }
  }
}

async function setup(
  config: CompletionNotificationConfig = {
    enabled: true,
    webhookUrl: 'https://hooks.example.test/autopilot',
    retryBaseMs: 1,
    retryMaxMs: 2,
  },
  transport: NotificationTransport = { deliver: vi.fn(async () => {}) },
) {
  const base = await createServiceHarness()
  vi.spyOn(base.ctx.autonomy, 'whenRecoveryIdle').mockResolvedValue()
  const NotificationPlugin = serviceClass(transport)
  const fiber = await base.ctx.plugin(NotificationPlugin, config)
  await vi.waitFor(() => {
    expect(base.ctx.autopilotNotifications).toBeInstanceOf(CompletionNotificationService)
  })
  const goal = base.ctx.goals.create(base.agent, { objective: 'Implement a real durable feature' })
  await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
  return { ...base, fiber, goal, service: base.ctx.autopilotNotifications, transport }
}

async function emitOutcome(
  harness: Awaited<ReturnType<typeof setup>>,
  event: CompletionNotificationEvent,
  operation: 'finalization-complete' | 'needs-attention' | 'expire' | 'revoke',
  revisionOffset = 1,
): Promise<void> {
  const current = harness.ctx.autonomy.get(harness.agent)
  if (current === undefined) throw new Error('test Autopilot view is unavailable')
  const view: AutonomyLeaseView = {
    ...current,
    phase: event,
    revision: current.revision + revisionOffset,
  }
  await harness.ctx.parallel('autonomy/changed', { agent: harness.agent, operation, view })
  await harness.service.whenIdle()
}

function storeOf(service: CompletionNotificationService): DurableNotificationStore {
  const store = (service as unknown as { store?: DurableNotificationStore }).store
  if (store === undefined) throw new Error('notification store unavailable')
  return store
}

function requestPump(service: CompletionNotificationService): void {
  ;(service as unknown as { requestPump(): void }).requestPump()
}

interface NotificationServiceInternals {
  stopped: boolean
  store?: DurableNotificationStore | undefined
  observerTail: Promise<void>
  recoveryScanTask?: Promise<void> | undefined
  pumpTask?: Promise<void> | undefined
  wakeTimer?: NodeJS.Timeout | undefined
  wakeAt?: number | undefined
  requestPump(): void
  captureResolved(input: {
    readonly sessionId: string
    readonly runId: string
    readonly generation: number
    readonly revision: number
    readonly event: CompletionNotificationEvent
    readonly objectiveSha256: string
    readonly objectiveSha256Source: 'goal-objective' | 'durable-goal-id-fallback'
    readonly verificationAttempts: number
    readonly dynamicPackages: number
    readonly subagentsStarted: number
  }, reconcileExisting: boolean): Promise<void>
  enqueueCapture(snapshot: NotificationSnapshot): Promise<void>
  requestPump(): void
  nextCandidate(): NotificationSnapshot | undefined
  nextReadyAt(snapshot: NotificationSnapshot): number
  planNextPump(): void
  clearWakeTimer(): void
  requireStore(): DurableNotificationStore
}

function internals(service: CompletionNotificationService): NotificationServiceInternals {
  return service as unknown as NotificationServiceInternals
}

function pendingInput(
  service: CompletionNotificationService,
  suffix: string,
  overrides: Partial<Parameters<typeof prepareNotification>[0]> = {},
): PrepareNotificationInput {
  const config = service as unknown as {
    config: {
      policySha256?: string
      maxAttempts: number
      maxPendingNotifications: number
      maxAuditRecords: number
      maxAuditBytes: number
    }
  }
  const event = overrides.event ?? 'completed'
  return {
    sessionId: `manual-session-${suffix}`,
    runId: `manual-run-${suffix}`,
    generation: 1,
    runRevision: 2,
    event,
    policySha256: config.config.policySha256 ?? 'f'.repeat(64),
    payload: {
      objectiveSha256: 'd'.repeat(64),
      objectiveSha256Source: 'goal-objective',
      phase: event,
      reasonCode: notificationReasonCode(event),
      usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 0 },
    },
    maxAttempts: config.config.maxAttempts,
    maxPendingNotifications: config.config.maxPendingNotifications,
    maxAuditRecords: config.config.maxAuditRecords,
    maxAuditBytes: config.config.maxAuditBytes,
    ...overrides,
  }
}

function pendingFor(
  service: CompletionNotificationService,
  suffix: string,
  overrides: Partial<Parameters<typeof prepareNotification>[0]> = {},
): NotificationSnapshot {
  return prepareNotification(pendingInput(service, suffix, overrides), Date.now())
}

describe('completion notification service', () => {
  it('is completely inert by default', async () => {
    const transport = { deliver: vi.fn(async () => {}) }
    const base = await createServiceHarness()
    const open = vi.spyOn(base.ctx.storageDomain, 'open')
    const fiber = await base.ctx.plugin(serviceClass(transport), {})
    await vi.waitFor(() => expect(base.ctx.autopilotNotifications).toBeDefined())
    const goal = base.ctx.goals.create(base.agent, { objective: 'disabled notification' })
    await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
    await base.ctx.autonomy.revoke(base.agent, 'test')
    await base.ctx.autopilotNotifications.whenIdle()
    expect(transport.deliver).not.toHaveBeenCalled()
    expect(base.ctx.autopilotNotifications.list()).toEqual([])
    expect(open).not.toHaveBeenCalled()
    await fiber.dispose()
    await base.ctx.fiber.dispose()
  })

  it('delivers only allowlisted fixed outcomes with a strict safe body', async () => {
    const deliver = vi.fn(async (_request: NotificationTransportRequest) => {})
    const harness = await setup({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/path',
      events: ['completed'],
      retryBaseMs: 1,
      retryMaxMs: 2,
    }, { deliver })
    await emitOutcome(harness, 'revoked', 'revoke')
    expect(deliver).not.toHaveBeenCalled()
    await emitOutcome(harness, 'completed', 'finalization-complete')
    expect(deliver).toHaveBeenCalledOnce()
    const request = deliver.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      webhookUrl: 'https://hooks.example.test/path',
      timeoutMs: 10_000,
      payload: {
        phase: 'completed',
        reasonCode: 'run-completed',
        objectiveSha256Source: 'goal-objective',
        usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 0 },
      },
    })
    expect(request?.payload.objectiveSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(Object.keys(request?.payload ?? {}).sort()).toEqual([
      'objectiveSha256', 'objectiveSha256Source', 'phase', 'reasonCode', 'usage',
    ])
    expect(JSON.stringify(request?.payload)).not.toContain('Implement a real durable feature')
    expect(request?.signal.aborted).toBe(false)
    expect(harness.service.list(harness.agent)).toMatchObject([{
      phase: 'delivered', event: 'completed', attempts: 1,
    }])
    expect(harness.service.list(createTestAgent('other'))).toEqual([])

    await emitOutcome(harness, 'completed', 'finalization-complete', 2)
    expect(deliver).toHaveBeenCalledOnce()
    await harness.ctx.fiber.dispose()
  })

  it('retries transport failures, caps attempts, and applies exponential delay', async () => {
    let calls = 0
    const deliver = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('remote response must not be persisted')
    })
    const harness = await setup({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/retry',
      timeoutMs: 100,
      maxAttempts: 3,
      retryBaseMs: 1,
      retryMaxMs: 2,
    }, { deliver })
    await emitOutcome(harness, 'needs-attention', 'needs-attention')
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
    await harness.service.whenIdle()
    expect(harness.service.list()[0]).toMatchObject({ phase: 'delivered', attempts: 2 })
    expect(storeOf(harness.service).history().map(record => record.operation))
      .toEqual(['enqueue', 'attempt', 'retry', 'attempt', 'deliver'])
    expect(notificationRetryDelay(1, 10, 1_000)).toBe(10)
    expect(notificationRetryDelay(2, 10, 1_000)).toBe(20)
    expect(notificationRetryDelay(40, 10, 1_000)).toBe(1_000)
    for (const args of [[0, 1, 1], [1, 0, 1], [1, 2, 1]] as const) {
      expect(() => notificationRetryDelay(args[0], args[1], args[2])).toThrow(TypeError)
    }
    await harness.ctx.fiber.dispose()

    const failedDeliver = vi.fn(async () => { throw new Error('always unavailable') })
    const exhausted = await setup({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/exhausted',
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }, { deliver: failedDeliver })
    await emitOutcome(exhausted, 'exhausted', 'expire')
    await vi.waitFor(() => expect(exhausted.service.list()[0]?.phase).toBe('failed'))
    expect(exhausted.service.list()[0]).toMatchObject({
      attempts: 2, lastFailureCode: 'transport-error',
    })
    await exhausted.ctx.fiber.dispose()
  })

  it('aborts timed-out requests and persists only the fixed timeout code', async () => {
    const deliver = vi.fn((request: NotificationTransportRequest) => new Promise<void>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('secret response body')), { once: true })
    }))
    const harness = await setup({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/timeout',
      timeoutMs: 2,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }, { deliver })
    await emitOutcome(harness, 'completed', 'finalization-complete')
    await vi.waitFor(() => expect(harness.service.list()[0]?.phase).toBe('failed'))
    const snapshot = harness.service.list()[0]
    expect(snapshot).toMatchObject({ attempts: 1, lastFailureCode: 'timeout' })
    expect(JSON.stringify(snapshot)).not.toContain('secret response body')
    expect(deliver.mock.calls[0]?.[0].signal.aborted).toBe(true)
    await harness.ctx.fiber.dispose()
  })

  it('drains HMR cancellation, then retries the uncertain attempt after restart', async () => {
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const firstDeliver = vi.fn((request: NotificationTransportRequest) => new Promise<void>((_resolve, reject) => {
      started()
      request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    }))
    const base = await createServiceHarness()
    vi.spyOn(base.ctx.autonomy, 'whenRecoveryIdle').mockResolvedValue()
    const config: CompletionNotificationConfig = {
      enabled: true,
      webhookUrl: 'https://hooks.example.test/hmr',
      timeoutMs: 1_000,
      maxAttempts: 3,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }
    const firstFiber = await base.ctx.plugin(serviceClass({ deliver: firstDeliver }), config)
    await vi.waitFor(() => expect(base.ctx.autopilotNotifications).toBeDefined())
    const goal = base.ctx.goals.create(base.agent, { objective: 'survive HMR' })
    await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
    const current = base.ctx.autonomy.get(base.agent)
    if (current === undefined) throw new Error('missing view')
    await base.ctx.parallel('autonomy/changed', {
      agent: base.agent,
      operation: 'finalization-complete',
      view: { ...current, phase: 'completed', revision: current.revision + 1 },
    })
    await began
    const dispose = firstFiber.dispose()
    await dispose
    expect(firstDeliver.mock.calls[0]?.[0].signal.aborted).toBe(true)

    const secondDeliver = vi.fn(async () => {})
    await base.ctx.plugin(serviceClass({ deliver: secondDeliver }), config)
    await vi.waitFor(() => expect(secondDeliver).toHaveBeenCalledOnce())
    await base.ctx.autopilotNotifications.whenIdle()
    expect(base.ctx.autopilotNotifications.list()[0]).toMatchObject({
      phase: 'delivered', attempts: 2,
    })
    expect(storeOf(base.ctx.autopilotNotifications).history().map(item => item.operation))
      .toEqual(['enqueue', 'attempt', 'retry', 'attempt', 'deliver'])
    await base.ctx.fiber.dispose()
  })

  it('fails closed on policy drift and an uncertain exhausted attempt without sending', async () => {
    const deliver = vi.fn(async () => {})
    const harness = await setup(undefined, { deliver })
    const drifted = pendingFor(harness.service, 'drifted', { policySha256: 'f'.repeat(64) })
    await storeOf(harness.service).enqueue(drifted)
    requestPump(harness.service)
    await vi.waitFor(() => expect(storeOf(harness.service).get(drifted.notificationId)?.phase).toBe('failed'))
    expect(storeOf(harness.service).get(drifted.notificationId)?.lastFailureCode).toBe('policy-drift')

    const pending = pendingFor(harness.service, 'uncertain', { maxAttempts: 1, maxAuditRecords: 3 })
    await storeOf(harness.service).enqueue(pending)
    const sending = beginNotificationAttempt(pending, Date.now() + 1)
    await storeOf(harness.service).appendIfCurrent('attempt', pending, sending)
    requestPump(harness.service)
    await vi.waitFor(() => expect(storeOf(harness.service).get(pending.notificationId)?.phase).toBe('failed'))
    expect(storeOf(harness.service).get(pending.notificationId)?.lastFailureCode).toBe('attempt-limit')
    expect(deliver).not.toHaveBeenCalled()

    const crashPending = pendingFor(harness.service, 'crash-retry')
    await storeOf(harness.service).enqueue(crashPending)
    const crashSending = beginNotificationAttempt(crashPending, Date.now() + 1)
    await storeOf(harness.service).appendIfCurrent('attempt', crashPending, crashSending)
    requestPump(harness.service)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    await harness.service.whenIdle()
    expect(storeOf(harness.service).get(crashPending.notificationId)).toMatchObject({
      phase: 'delivered', attempts: 2,
    })
    await harness.ctx.fiber.dispose()
  })

  it('contains listener and storage failures outside the Autonomy transaction', async () => {
    const deliver = vi.fn(async () => {})
    const harness = await setup(undefined, { deliver })
    const logger = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => {})
    const outsider = createTestAgent('outsider')
    const current = harness.ctx.autonomy.get(harness.agent)
    if (current === undefined) throw new Error('missing view')
    await expect(harness.ctx.parallel('autonomy/changed', {
      agent: outsider,
      operation: 'finalization-complete',
      view: { ...current, phase: 'completed' },
    })).resolves.toBeUndefined()
    const goal = harness.ctx.goals.get(harness.agent)
    if (goal === undefined) throw new Error('missing goal')
    await expect(harness.ctx.parallel('autonomy/changed', {
      agent: harness.agent,
      operation: 'finalization-complete',
      view: { ...current, goalId: `${goal.id}-different` as typeof goal.id, phase: 'completed' },
    })).resolves.toBeUndefined()
    await internals(harness.service).captureResolved({
      sessionId: 'invalid-capture',
      runId: 'invalid-capture',
      generation: 0,
      revision: 1,
      event: 'completed',
      objectiveSha256: 'e'.repeat(64),
      objectiveSha256Source: 'goal-objective',
      verificationAttempts: 0,
      dynamicPackages: 0,
      subagentsStarted: 0,
    }, false)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('notification capture failed'))
    await internals(harness.service).captureResolved({
      sessionId: 'filtered-capture',
      runId: 'filtered-capture',
      generation: 1,
      revision: 1,
      event: 'revoked',
      objectiveSha256: 'e'.repeat(64),
      objectiveSha256Source: 'goal-objective',
      verificationAttempts: 0,
      dynamicPackages: 0,
      subagentsStarted: 0,
    }, false)

    const store = storeOf(harness.service)
    const enqueueOriginal = store.enqueue.bind(store)
    vi.spyOn(store, 'enqueue')
      .mockImplementation(enqueueOriginal)
      .mockRejectedValueOnce(new Error('durable store unavailable'))
    await expect(harness.ctx.parallel('autonomy/changed', {
      agent: harness.agent,
      operation: 'finalization-complete',
      view: { ...current, phase: 'completed' },
    })).resolves.toBeUndefined()
    await harness.service.whenIdle()
    expect(deliver).not.toHaveBeenCalled()

    const pending = pendingFor(harness.service, 'storage-recovery')
    await enqueueOriginal(pending)
    const appendOriginal = store.appendIfCurrent.bind(store)
    const append = vi.spyOn(store, 'appendIfCurrent')
      .mockImplementation(appendOriginal)
      .mockRejectedValueOnce(new Error('write unavailable'))
    requestPump(harness.service)
    await harness.service.whenIdle()
    await vi.waitFor(() => expect(append).toHaveBeenCalled())
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    await harness.service.whenIdle()
    expect(harness.service.list().some(item => item.phase === 'delivered')).toBe(true)
    await harness.ctx.fiber.dispose()
  })

  it('recovers a current terminal run during plugin load and agent creation', async () => {
    const base = await createServiceHarness()
    const goal = base.ctx.goals.create(base.agent, { objective: 'notify recovered stop' })
    await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
    await base.ctx.autonomy.revoke(base.agent, 'operator stopped')
    vi.spyOn(base.ctx.autonomy, 'whenRecoveryIdle').mockResolvedValue()
    const deliver = vi.fn(async () => {})
    await base.ctx.plugin(serviceClass({ deliver }), {
      enabled: true,
      webhookUrl: 'https://hooks.example.test/recovery',
      events: ['revoked'],
    })
    await base.ctx.autopilotNotifications.whenIdle()
    expect(deliver).toHaveBeenCalledOnce()
    agentEvents(base.ctx, base.agent).emit('agent/created', { agent: base.agent })
    await base.ctx.autopilotNotifications.whenIdle()
    expect(deliver).toHaveBeenCalledOnce()
    await base.ctx.fiber.dispose()
  })

  it('captures cold needs-attention state without a live Agent using an explicit stable fallback', async () => {
    const base = await createServiceHarness()
    const coldAgent = createTestAgent('cold-notification-session')
    const unregister = base.ctx.agents.register(coldAgent)
    const objective = 'private objective unavailable during cold notification recovery'
    const goal = base.ctx.goals.create(coldAgent, { objective })
    const running = await base.ctx.autonomy.start(coldAgent, { goalId: goal.id })
    await base.ctx.autonomy.markNeedsAttention({
      runId: running.id,
      generation: running.generation,
      revision: running.revision,
      sessionId: String(coldAgent.id),
    }, 'cold recovery mismatch')
    unregister()
    expect(base.ctx.agents.get(coldAgent.id)).toBeUndefined()
    vi.spyOn(base.ctx.autonomy, 'whenRecoveryIdle').mockResolvedValue()

    const deliver = vi.fn(async (_request: NotificationTransportRequest) => {})
    await base.ctx.plugin(serviceClass({ deliver }), {
      enabled: true,
      webhookUrl: 'https://hooks.example.test/cold-recovery',
      events: ['needs-attention'],
    })
    await base.ctx.autopilotNotifications.whenIdle()
    expect(deliver).toHaveBeenCalledOnce()
    const request = deliver.mock.calls[0]?.[0]
    expect(request?.payload).toMatchObject({
      phase: 'needs-attention',
      reasonCode: 'human-attention-required',
      objectiveSha256Source: 'durable-goal-id-fallback',
      usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 0 },
    })
    expect(request?.payload.objectiveSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(request?.payload.objectiveSha256).toBe(createHash('sha256')
      .update('dsh-autopilot:completion-notification:durable-goal-id-fallback:v1\u0000')
      .update(String(goal.id))
      .digest('hex'))
    expect(request?.payload.objectiveSha256).not.toBe(
      createHash('sha256').update(String(goal.id)).digest('hex'),
    )
    expect(request?.payload.objectiveSha256).not.toBe(
      createHash('sha256').update(objective).digest('hex'),
    )
    expect(JSON.stringify(request?.payload)).not.toContain(String(goal.id))
    expect(JSON.stringify(request?.payload)).not.toContain(objective)

    const logger = vi.spyOn(base.ctx.logger, 'error').mockImplementation(() => {})
    const unregisterAgain = base.ctx.agents.register(coldAgent)
    await base.ctx.autopilotNotifications.whenIdle()
    expect(deliver).toHaveBeenCalledOnce()
    expect(base.ctx.autopilotNotifications.list()).toHaveLength(1)
    expect(logger).not.toHaveBeenCalledWith(expect.stringContaining('different payload data'))
    unregisterAgain()
    await base.ctx.fiber.dispose()
  })

  it('rescans after delayed cold recovery marks a detached run needs-attention', async () => {
    const base = await createServiceHarness()
    const coldAgent = createTestAgent('delayed-cold-notification-session')
    const unregister = base.ctx.agents.register(coldAgent)
    const goal = base.ctx.goals.create(coldAgent, { objective: 'delayed cold recovery objective' })
    const running = await base.ctx.autonomy.start(coldAgent, { goalId: goal.id })
    unregister()

    let releaseRecovery!: () => void
    const recoveryIdle = new Promise<void>((resolve) => { releaseRecovery = resolve })
    let observeWaiter!: () => void
    const waiterObserved = new Promise<void>((resolve) => { observeWaiter = resolve })
    vi.spyOn(base.ctx.autonomy, 'whenRecoveryIdle').mockImplementation(() => {
      observeWaiter()
      return recoveryIdle
    })
    const deliver = vi.fn(async (_request: NotificationTransportRequest) => {})
    await base.ctx.plugin(serviceClass({ deliver }), {
      enabled: true,
      webhookUrl: 'https://hooks.example.test/delayed-cold-recovery',
      events: ['needs-attention'],
    })
    await waiterObserved
    expect(deliver).not.toHaveBeenCalled()

    await base.ctx.autonomy.markNeedsAttention({
      runId: running.id,
      generation: running.generation,
      revision: running.revision,
      sessionId: String(coldAgent.id),
    }, 'delayed cold recovery mismatch')
    releaseRecovery()
    await base.ctx.autopilotNotifications.whenIdle()
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver.mock.calls[0]?.[0].payload).toMatchObject({
      phase: 'needs-attention',
      objectiveSha256Source: 'durable-goal-id-fallback',
    })
    await base.ctx.fiber.dispose()
  })

  it('abandons a pending post-recovery scan when the notification service unloads', async () => {
    const base = await createServiceHarness()
    let releaseRecovery!: () => void
    const recoveryIdle = new Promise<void>((resolve) => { releaseRecovery = resolve })
    let observeWaiter!: () => void
    const waiterObserved = new Promise<void>((resolve) => { observeWaiter = resolve })
    vi.spyOn(base.ctx.autonomy, 'whenRecoveryIdle').mockImplementation(() => {
      observeWaiter()
      return recoveryIdle
    })
    const deliver = vi.fn(async (_request: NotificationTransportRequest) => {})
    const fiber = await base.ctx.plugin(serviceClass({ deliver }), {
      enabled: true,
      webhookUrl: 'https://hooks.example.test/unloaded-recovery',
    })
    await waiterObserved
    const details = internals(base.ctx.autopilotNotifications)
    await fiber.dispose()
    releaseRecovery()
    await details.recoveryScanTask
    expect(details.stopped).toBe(true)
    expect(deliver).not.toHaveBeenCalled()
    await base.ctx.fiber.dispose()
  })

  it('orders queued work deterministically and leaves no scheduler activity after unload', async () => {
    const deliver = vi.fn(async () => {})
    const harness = await setup({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/scheduler',
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
    }, { deliver })
    await harness.service.whenIdle()
    const details = internals(harness.service)
    const now = Date.now()
    const first = prepareNotification({
      ...pendingInput(harness.service, 'order-first'),
    }, now + 1_000)
    const second = prepareNotification({
      ...pendingInput(harness.service, 'order-second'),
    }, now + 1_001)
    const third = prepareNotification({
      ...pendingInput(harness.service, 'order-third'),
    }, now + 1_000)
    await storeOf(harness.service).enqueue(second)
    await storeOf(harness.service).enqueue(third)
    await storeOf(harness.service).enqueue(first)
    expect(details.nextCandidate()?.notificationId).toBe(
      [first.notificationId, third.notificationId].sort()[0],
    )

    details.planNextPump()
    expect(details.wakeTimer).toBeDefined()
    const originalTimer = details.wakeTimer
    details.planNextPump()
    expect(details.wakeTimer).toBe(originalTimer)
    details.wakeAt = undefined
    details.planNextPump()
    expect(details.wakeTimer).not.toBe(originalTimer)
    details.wakeAt = now + 2_000
    details.planNextPump()
    expect(details.wakeAt).toBeLessThan(now + 2_000)
    details.clearWakeTimer()
    expect(details.wakeTimer).toBeUndefined()

    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2_000)
    details.planNextPump()
    await harness.service.whenIdle()
    expect(deliver).toHaveBeenCalledTimes(3)
    clock.mockRestore()

    const syntheticSending = beginNotificationAttempt(first, now + 1_001)
    const syntheticDelivered = deliverNotification(syntheticSending, now + 1_002)
    expect(details.nextReadyAt(syntheticSending)).toBe(0)
    expect(details.nextReadyAt(syntheticDelivered)).toBe(0)

    const pumpSlot = Promise.resolve()
    details.pumpTask = pumpSlot
    details.requestPump()
    expect(details.pumpTask).toBe(pumpSlot)
    details.pumpTask = undefined

    await harness.fiber.dispose()
    details.requestPump()
    details.enqueueCapture(first)
    await details.observerTail
    expect(details.stopped).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(3)

    const disabledBase = await createServiceHarness()
    await disabledBase.ctx.plugin(serviceClass({ deliver }), {})
    const disabled = internals(disabledBase.ctx.autopilotNotifications)
    disabled.requestPump()
    expect(() => disabled.requireStore()).toThrow(/unavailable/u)
    await disabledBase.ctx.fiber.dispose()
  })

  it('tolerates a compare-and-set loser without duplicating the reserved request', async () => {
    const deliver = vi.fn(async () => {})
    const harness = await setup(undefined, { deliver })
    await harness.service.whenIdle()
    const pending = prepareNotification(
      pendingInput(harness.service, 'cas-loser'),
      Date.now() + 5,
    )
    const store = storeOf(harness.service)
    await store.enqueue(pending)
    const original = store.appendIfCurrent.bind(store)
    vi.spyOn(store, 'appendIfCurrent')
      .mockImplementation(original)
      .mockResolvedValueOnce(undefined)
    requestPump(harness.service)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    await harness.service.whenIdle()
    expect(store.get(pending.notificationId)?.phase).toBe('delivered')
    await harness.ctx.fiber.dispose()
  })

  it('wakes a delayed notification pump at its scheduled time', async () => {
    const harness = await setup({
      enabled: true,
      webhookUrl: 'https://hooks.example.test/scheduled-wake',
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
    }, { deliver: vi.fn(async () => {}) })
    await harness.service.whenIdle()
    const details = internals(harness.service)
    const now = Date.now()
    const delayed = prepareNotification(pendingInput(harness.service, 'scheduled-wake'), now + 1_000)
    await storeOf(harness.service).enqueue(delayed)
    vi.useFakeTimers({ now })
    try {
      const request = vi.spyOn(details, 'requestPump').mockImplementation(() => {})
      details.planNextPump()
      expect(details.wakeTimer).toBeDefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(request).toHaveBeenCalledOnce()
      expect(details.wakeTimer).toBeUndefined()
      expect(details.wakeAt).toBeUndefined()
    } finally {
      details.clearWakeTimer()
      vi.useRealTimers()
      await harness.ctx.fiber.dispose()
    }
  })

  it('validates deployment-only endpoint, allowlist, and all hard ceilings', () => {
    const invalid: CompletionNotificationConfig[] = [
      { enabled: true },
      { webhookUrl: 'http://hooks.example.test' },
      { webhookUrl: 'not a url' },
      { webhookUrl: `https://hooks.example.test/${'a'.repeat(2_100)}` },
      { webhookUrl: 'https://user:secret@hooks.example.test/path' },
      { webhookUrl: 'https://hooks.example.test/path#secret' },
      { events: ['completed', 'completed'] },
      { events: ['unknown' as CompletionNotificationEvent] },
      { timeoutMs: 0 },
      { timeoutMs: MAX_NOTIFICATION_TIMEOUT_MS + 1 },
      { maxAttempts: MAX_NOTIFICATION_ATTEMPTS + 1 },
      { retryBaseMs: MAX_NOTIFICATION_RETRY_MS + 1 },
      { retryMaxMs: MAX_NOTIFICATION_RETRY_MS + 1 },
      { retryBaseMs: 3, retryMaxMs: 2 },
      { maxPendingNotifications: MAX_PENDING_NOTIFICATIONS + 1 },
      { maxAuditBytes: MIN_NOTIFICATION_AUDIT_BYTES - 1 },
      { maxAuditBytes: MAX_NOTIFICATION_AUDIT_BYTES + 1 },
    ]
    for (const config of invalid) {
      expect(() => new CompletionNotificationService(new Context(), config, { deliver: vi.fn() }))
        .toThrow(TypeError)
    }
    expect(() => new CompletionNotificationService(new Context(), {
      webhookUrl: 'https://hooks.example.test',
      events: [],
      timeoutMs: 1,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      maxPendingNotifications: 1,
      maxAuditBytes: MIN_NOTIFICATION_AUDIT_BYTES,
    }, { deliver: vi.fn() })).not.toThrow()
  })

  it('uses fixed HTTPS POST semantics and never reads response bodies', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new HttpsNotificationTransport()
    const controller = new AbortController()
    const request: NotificationTransportRequest = {
      webhookUrl: 'https://hooks.example.test/path',
      notificationId: `notification-${'a'.repeat(64)}`,
      payload: {
        objectiveSha256: 'b'.repeat(64),
        objectiveSha256Source: 'goal-objective',
        phase: 'completed',
        reasonCode: 'run-completed',
        usage: { verificationAttempts: 1, dynamicPackages: 0, subagentsStarted: 2 },
      },
      timeoutMs: 1_000,
      signal: controller.signal,
    }
    await transport.deliver(request)
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.example.test/path', {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-dsh-autopilot-notification-id': request.notificationId,
      },
      body: JSON.stringify(request.payload),
      signal: controller.signal,
    })
    fetchMock.mockResolvedValueOnce({ ok: false })
    await expect(transport.deliver(request)).rejects.toBeInstanceOf(NotificationTransportError)
    await expect(transport.deliver({ ...request, webhookUrl: 'http://unsafe.test' })).rejects.toBeInstanceOf(TypeError)
  })
})
