/** Typed, disposal-aware lifecycle hooks for an active Autopilot run. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import type { RunOperation } from './run-state.ts'
import type { AutonomyLeaseView } from './service.ts'

/** Default total number of live lifecycle handlers. */
export const DEFAULT_MAX_LIFECYCLE_HANDLERS = 64

/** Deployment ceiling for live lifecycle handlers. */
export const MAX_LIFECYCLE_HANDLERS = 4_096

/** Default wall-clock budget for one handler invocation. */
export const DEFAULT_LIFECYCLE_HANDLER_TIMEOUT_MS = 2_000

/** Largest handler timeout accepted by the deployment configuration. */
export const MAX_LIFECYCLE_HANDLER_TIMEOUT_MS = 60_000

/** Outcome used when a before-tool handler fails or exceeds its time budget. */
export type BeforeToolFailurePolicy = 'deny' | 'continue'

/** Deployment policy for the lifecycle hook registry. */
export interface AutopilotLifecycleHookConfig {
  /** Maximum registrations across every hook point. */
  readonly maxHandlers?: number
  /** Wall-clock budget for each handler invocation. */
  readonly handlerTimeoutMs?: number
  /** Whether a broken before-tool policy denies the pending call. */
  readonly beforeToolFailurePolicy?: BeforeToolFailurePolicy
}

/** Fully validated lifecycle hook deployment policy. */
export interface ResolvedAutopilotLifecycleHookConfig {
  readonly maxHandlers: number
  readonly handlerTimeoutMs: number
  readonly beforeToolFailurePolicy: BeforeToolFailurePolicy
}

/** Stable identity of the exact Autopilot run generation being observed. */
export interface AutopilotLifecycleRunRef {
  readonly agentId: string
  readonly runId: string
  readonly generation: number
  readonly revision: number
  readonly goalId: string
  readonly phase: AutonomyLeaseView['phase']
  readonly activation: AutonomyLeaseView['activation']
}

/** Post-commit mutation of one durable Autopilot run. */
export interface AutopilotRunMutationHookEvent extends AutopilotLifecycleRunRef {
  readonly operation: RunOperation
  readonly reason?: string
}

/** Start or restart of an Agent session while Autopilot is active. */
export interface AutopilotSessionStartHookEvent extends AutopilotLifecycleRunRef {
  readonly source: SessionStartSource
}

/** Proposed model step, exposed without messages or an Agent mutation handle. */
export interface AutopilotPreStepHookEvent extends AutopilotLifecycleRunRef {
  readonly turn: number
  readonly step: number
  readonly messageCount: number
}

/** Immutable pending tool-call facts available to policy handlers. */
export interface AutopilotBeforeToolHookEvent extends AutopilotLifecycleRunRef {
  readonly callId: string
  readonly rootCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly nested: boolean
}

/** Immutable settled tool-call summary available to observers. */
export interface AutopilotAfterToolHookEvent extends AutopilotLifecycleRunRef {
  readonly callId: string
  readonly rootCallId: string
  readonly name: string
  readonly nested: boolean
  readonly isError: boolean
  readonly contentBlocks: number
  readonly concludesTurn: boolean
}

/** Turn stop boundary reached by an active Autopilot Agent. */
export interface AutopilotTurnStoppingHookEvent extends AutopilotLifecycleRunRef {
  readonly turn: number
}

/** Normalized Agent failure without a live Agent authority handle. */
export interface AutopilotAgentErrorHookEvent extends AutopilotLifecycleRunRef {
  readonly turn: number
  readonly step: number
  readonly errorName: string
  readonly errorMessage: string
}

/** Typed event payload at every supported lifecycle point. */
export interface AutopilotLifecycleHookEventMap {
  readonly 'run-mutation': AutopilotRunMutationHookEvent
  readonly 'session-start': AutopilotSessionStartHookEvent
  readonly 'pre-step': AutopilotPreStepHookEvent
  readonly 'before-tool': AutopilotBeforeToolHookEvent
  readonly 'after-tool': AutopilotAfterToolHookEvent
  readonly 'turn-stopping': AutopilotTurnStoppingHookEvent
  readonly 'agent-error': AutopilotAgentErrorHookEvent
}

/** Supported lifecycle extension point. */
export type AutopilotLifecycleHookName = keyof AutopilotLifecycleHookEventMap

/** Per-invocation cancellation, aborted by the caller, timeout, or disposal. */
export interface AutopilotLifecycleHookContext {
  readonly signal: AbortSignal
}

/** Monotonic before-tool policy result; no result leaves prior policy unchanged. */
export type AutopilotBeforeToolHookDecision = { readonly kind: 'deny'; readonly reason: string } | void

/** Typed hook function for one lifecycle extension point. */
export type AutopilotLifecycleHookHandler<K extends AutopilotLifecycleHookName> = (
  event: Readonly<AutopilotLifecycleHookEventMap[K]>,
  context: AutopilotLifecycleHookContext,
) => K extends 'before-tool'
  ? AutopilotBeforeToolHookDecision | Promise<AutopilotBeforeToolHookDecision>
  : void | Promise<void>

/** Ordering controls for a lifecycle registration. */
export interface AutopilotLifecycleHookOptions {
  /** Higher priorities run first; equal priorities preserve registration order. */
  readonly priority?: number
}

/** Awaitable disposer returned for an exact hook registration. */
export type AutopilotLifecycleHookDisposer = () => Promise<void>

interface HookRecord {
  readonly id: string
  readonly hook: AutopilotLifecycleHookName
  readonly priority: number
  readonly sequence: number
  readonly handler: (
    event: AutopilotLifecycleHookEventMap[AutopilotLifecycleHookName],
    context: AutopilotLifecycleHookContext,
  ) => unknown
  readonly inFlight: Set<Promise<InvocationSettlement>>
  readonly controllers: Set<AbortController>
  registered: boolean
}

type InvocationSettlement =
  | { readonly kind: 'fulfilled'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }

type InvocationOutcome = InvocationSettlement | { readonly kind: 'timeout' }

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotLifecycleHooks: AutopilotLifecycleHookService
  }
}

/** Validate and materialize lifecycle hook deployment policy. */
export function resolveAutopilotLifecycleHookConfig(
  config: AutopilotLifecycleHookConfig,
): ResolvedAutopilotLifecycleHookConfig {
  return Object.freeze({
    maxHandlers: configuredInteger(
      config.maxHandlers,
      DEFAULT_MAX_LIFECYCLE_HANDLERS,
      'maxHandlers',
      MAX_LIFECYCLE_HANDLERS,
    ),
    handlerTimeoutMs: configuredInteger(
      config.handlerTimeoutMs,
      DEFAULT_LIFECYCLE_HANDLER_TIMEOUT_MS,
      'handlerTimeoutMs',
      MAX_LIFECYCLE_HANDLER_TIMEOUT_MS,
    ),
    beforeToolFailurePolicy: config.beforeToolFailurePolicy ?? 'deny',
  })
}

/** Cordis service that owns typed lifecycle registrations and DSH event bridges. */
export class AutopilotLifecycleHookService extends Service {
  static inject = ['autonomy', 'tools']

  static Config: s<AutopilotLifecycleHookConfig> = s.object({
    maxHandlers: s.number().default(DEFAULT_MAX_LIFECYCLE_HANDLERS),
    handlerTimeoutMs: s.number().default(DEFAULT_LIFECYCLE_HANDLER_TIMEOUT_MS),
    beforeToolFailurePolicy: s.union(['deny', 'continue'] as const).default('deny'),
  })

  /** Validated, deployment-owned limits. */
  readonly config: ResolvedAutopilotLifecycleHookConfig

  private readonly records = new Map<string, HookRecord>()
  private readonly pendingToolDenials = new Map<ToolExecution['token'], string>()
  private readonly inFlight = new Set<Promise<InvocationSettlement>>()
  private readonly controllers = new Set<AbortController>()
  private sequence = 0
  private stopping = false

  /**
   * @param ctx - Host context carrying Autonomy and the DSH tool runtime.
   * @param config - Deployment limits and before-tool failure policy.
   */
  constructor(ctx: Context, config: AutopilotLifecycleHookConfig = {}) {
    super(ctx, 'autopilotLifecycleHooks')
    this.config = resolveAutopilotLifecycleHookConfig(config)
  }

  /** Install the native DSH event bridges and drain handlers within their configured timeout. */
  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.stopping = true
      const reason = new Error('Autopilot lifecycle hook service disposed')
      for (const controller of this.controllers) controller.abort(reason)
      await Promise.allSettled(this.inFlight)
      this.pendingToolDenials.clear()
      this.records.clear()
    }, 'dsh-autopilot.lifecycleHooksDrain')

    this.ctx.on('autonomy/changed', ({ agent, operation, view }) => {
      const event: AutopilotRunMutationHookEvent = Object.freeze({
        ...runRef(agent, view),
        operation,
        ...(view.reason === undefined ? {} : { reason: view.reason }),
      })
      return this.observe('run-mutation', event)
    })
    this.ctx.on('agent/session-start', ({ agent, source }) => {
      const ref = this.activeRunRef(agent)
      if (ref === undefined) return
      return this.observe('session-start', Object.freeze({ ...ref, source }))
    }, true)
    this.ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      const ref = this.activeRunRef(agent)
      if (ref !== undefined) {
        await this.observe('pre-step', Object.freeze({
          ...ref,
          turn,
          step,
          messageCount: messages.length,
        }), signal)
      }
      return next()
    })
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      const agent = exec.agent
      const ref = agent === undefined ? undefined : this.activeRunRef(agent)
      if (ref !== undefined) {
        const denial = await this.beforeTool(Object.freeze({
          ...ref,
          callId: String(exec.callId),
          rootCallId: String(exec.rootCallId),
          name: exec.name,
          arguments: exec.arguments,
          nested: exec.parent !== undefined,
        }), exec.signal)
        if (denial !== undefined) this.pendingToolDenials.set(exec.token, denial)
      }
      return next()
    })
    this.ctx.effect(() => this.ctx.tools.guard((exec) => {
      const denial = this.pendingToolDenials.get(exec.token)
      this.pendingToolDenials.delete(exec.token)
      return denial
    }), 'dsh-autopilot.lifecycleHooksToolGuard')
    this.ctx.on('tools/result', (exec, result) => {
      this.pendingToolDenials.delete(exec.token)
      const agent = exec.agent
      const ref = agent === undefined ? undefined : this.activeRunRef(agent)
      if (ref === undefined) return
      const event = afterToolEvent(ref, exec, result)
      void this.observe('after-tool', event, exec.signal)
    })
    this.ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      const ref = this.activeRunRef(agent)
      if (ref === undefined) return
      return this.observe('turn-stopping', Object.freeze({ ...ref, turn }), signal)
    })
    this.ctx.on('agent/error', ({ agent, turn, step, error }) => {
      const ref = this.activeRunRef(agent)
      if (ref === undefined) return
      const normalized = normalizedError(error)
      return this.observe('agent-error', Object.freeze({
        ...ref,
        turn,
        step,
        errorName: normalized.name,
        errorMessage: normalized.message,
      }))
    }, true)
  }

  /**
   * Register one uniquely identified typed handler in the calling plugin's fiber.
   * @param hook - Lifecycle point to observe.
   * @param id - Stable deployment-wide handler identity.
   * @param handler - Typed observer or monotonic before-tool policy.
   * @param options - Stable priority controls.
   * @returns Awaitable disposer that removes the handler and drains cooperative invocations.
   */
  register<K extends AutopilotLifecycleHookName>(
    hook: K,
    id: string,
    handler: AutopilotLifecycleHookHandler<K>,
    options: AutopilotLifecycleHookOptions = {},
  ): AutopilotLifecycleHookDisposer {
    const normalizedId = normalizeHandlerId(id)
    if (this.stopping) throw new Error('Autopilot lifecycle hook service is stopping')
    if (this.records.has(normalizedId)) {
      throw new Error(`Autopilot lifecycle hook id "${normalizedId}" is already registered`)
    }
    if (this.records.size >= this.config.maxHandlers) {
      throw new Error(`Autopilot lifecycle hook registry reached its ${this.config.maxHandlers}-handler limit`)
    }
    const priority = normalizedPriority(options.priority)
    const record: HookRecord = {
      id: normalizedId,
      hook,
      priority,
      sequence: this.sequence,
      handler: handler as unknown as HookRecord['handler'],
      inFlight: new Set(),
      controllers: new Set(),
      registered: true,
    }
    this.sequence += 1
    return this.ctx.effect(() => {
      this.records.set(normalizedId, record)
      return async () => {
        record.registered = false
        if (this.records.get(normalizedId) === record) this.records.delete(normalizedId)
        const reason = new Error(`Autopilot lifecycle hook "${normalizedId}" disposed`)
        for (const controller of record.controllers) controller.abort(reason)
        await Promise.allSettled(record.inFlight)
      }
    }, `dsh-autopilot.lifecycleHook:${normalizedId}`)
  }

  /** Resolve after every currently running handler reaches quiescence. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled(this.inFlight)
  }

  private activeRunRef(agent: Agent): AutopilotLifecycleRunRef | undefined {
    const view = this.ctx.autonomy.get(agent)
    if (view === undefined || view.activation !== 'armed'
      || (view.phase !== 'running' && view.phase !== 'verifying')) return undefined
    return runRef(agent, view)
  }

  private handlers(hook: AutopilotLifecycleHookName): HookRecord[] {
    return [...this.records.values()]
      .filter(record => record.registered && record.hook === hook)
      .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
  }

  private async observe<K extends Exclude<AutopilotLifecycleHookName, 'before-tool'>>(
    hook: K,
    event: AutopilotLifecycleHookEventMap[K],
    sourceSignal?: AbortSignal,
  ): Promise<void> {
    for (const record of this.handlers(hook)) {
      if (!record.registered || this.stopping) continue
      const outcome = await this.invoke(record, event, sourceSignal)
      if (outcome.kind === 'fulfilled') continue
      this.logFailure(hook, record.id, outcome)
    }
  }

  private async beforeTool(
    event: AutopilotBeforeToolHookEvent,
    sourceSignal: AbortSignal,
  ): Promise<string | undefined> {
    let denial: string | undefined
    for (const record of this.handlers('before-tool')) {
      if (!record.registered || this.stopping) continue
      const outcome = await this.invoke(record, event, sourceSignal)
      if (outcome.kind === 'fulfilled') {
        const decision = outcome.value as AutopilotBeforeToolHookDecision
        if (denial === undefined && decision?.kind === 'deny') {
          denial = normalizedDenialReason(decision.reason, record.id)
        }
        continue
      }
      this.logFailure('before-tool', record.id, outcome)
      if (denial === undefined && this.config.beforeToolFailurePolicy === 'deny') {
        denial = `Autopilot lifecycle hook "${record.id}" failed closed`
      }
    }
    return denial
  }

  private async invoke(
    record: HookRecord,
    event: AutopilotLifecycleHookEventMap[AutopilotLifecycleHookName],
    sourceSignal?: AbortSignal,
  ): Promise<InvocationOutcome> {
    const controller = new AbortController()
    const signal = sourceSignal === undefined
      ? controller.signal
      : AbortSignal.any([sourceSignal, controller.signal])
    const settlement: Promise<InvocationSettlement> = Promise.resolve()
      .then(() => record.handler(event, Object.freeze({ signal })))
      .then(
        value => ({ kind: 'fulfilled' as const, value }),
        error => ({ kind: 'rejected' as const, error }),
      )
    record.inFlight.add(settlement)
    record.controllers.add(controller)
    this.inFlight.add(settlement)
    this.controllers.add(controller)
    void settlement.finally(() => {
      record.inFlight.delete(settlement)
      record.controllers.delete(controller)
      this.inFlight.delete(settlement)
      this.controllers.delete(controller)
    })

    let resolveTimeout!: (value: { readonly kind: 'timeout' }) => void
    const timeout = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      resolveTimeout = resolve
    })
    const timer = setTimeout(() => {
      controller.abort(new Error(`Autopilot lifecycle hook "${record.id}" timed out`))
      resolveTimeout({ kind: 'timeout' })
    }, this.config.handlerTimeoutMs)
    timer.unref()
    const outcome = await Promise.race([settlement, timeout])
    clearTimeout(timer)
    if (outcome.kind === 'timeout') this.quarantine(record, settlement, controller)
    return outcome
  }

  private quarantine(
    record: HookRecord,
    settlement: Promise<InvocationSettlement>,
    controller: AbortController,
  ): void {
    record.registered = false
    if (this.records.get(record.id) === record) this.records.delete(record.id)
    record.inFlight.delete(settlement)
    record.controllers.delete(controller)
    this.inFlight.delete(settlement)
    this.controllers.delete(controller)
  }

  private logFailure(
    hook: AutopilotLifecycleHookName,
    id: string,
    outcome: Exclude<InvocationOutcome, { readonly kind: 'fulfilled' }>,
  ): void {
    const detail = outcome.kind === 'timeout' ? 'timed out' : `failed: ${errorMessage(outcome.error)}`
    this.ctx.logger.warn(`dsh-autopilot: lifecycle hook "${id}" at ${hook} ${detail}`)
  }
}

function configuredInteger(value: number | undefined, fallback: number, field: string, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${field} must be a positive safe integer no greater than ${maximum}`)
  }
  return resolved
}

function normalizeHandlerId(value: string): string {
  const id = value.trim()
  if (id.length === 0 || id.length > 128 || /\p{Cc}/u.test(id)) {
    throw new TypeError('lifecycle hook id must be 1-128 visible characters')
  }
  return id
}

function normalizedPriority(value: number | undefined): number {
  const priority = value ?? 0
  if (!Number.isSafeInteger(priority)) throw new TypeError('lifecycle hook priority must be a safe integer')
  return priority
}

function normalizedDenialReason(value: string, id: string): string {
  const reason = value.trim()
  return reason.length === 0 ? `Autopilot lifecycle hook "${id}" denied this tool call` : reason
}

function runRef(agent: Agent, view: AutonomyLeaseView): AutopilotLifecycleRunRef {
  return Object.freeze({
    agentId: String(agent.id),
    runId: view.id,
    generation: view.generation,
    revision: view.revision,
    goalId: String(view.goalId),
    phase: view.phase,
    activation: view.activation,
  })
}

function afterToolEvent(
  ref: AutopilotLifecycleRunRef,
  exec: Readonly<ToolExecution>,
  result: Readonly<ToolExecutionResult>,
): AutopilotAfterToolHookEvent {
  return Object.freeze({
    ...ref,
    callId: String(exec.callId),
    rootCallId: String(exec.rootCallId),
    name: exec.name,
    nested: exec.parent !== undefined,
    isError: result.isError,
    contentBlocks: result.content.length,
    concludesTurn: result.concludesTurn === true,
  })
}

function normalizedError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) return Object.freeze({ name: error.name, message: error.message })
  return Object.freeze({ name: 'Error', message: errorMessage(error) })
}

function errorMessage(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '<unprintable thrown value>'
  }
}

export default AutopilotLifecycleHookService
