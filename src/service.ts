/** Process-local autonomy leases layered over DSH's durable Goal service. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { GoalId } from '@deepseek-ai/dsh-goal/types'
import z from '@deepseek-ai/schemastery'

/** Default active lease duration: seven days. */
export const DEFAULT_MAX_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000

/** Deployment ceiling for one active lease: thirty days. */
export const DEFAULT_ACTIVE_MS_CEILING = 30 * 24 * 60 * 60 * 1000

/** Default Goal round budget. */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/** Deployment ceiling for Goal rounds requested through `/autopilot`. */
export const DEFAULT_GOAL_ROUNDS_CEILING = 1024

/** Largest delay accepted reliably by Node timers. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Dynamic Cordis capability available to an autonomous run. */
export type SelfModificationMode = 'off' | 'host-only' | 'client-approved'

/** Process-local lifecycle of an autonomy lease. */
export type AutonomyLeasePhase =
  | 'running'
  | 'verifying'
  | 'paused'
  | 'exhausted'
  | 'revoked'
  | 'completed'

/** Stable machine-readable autonomy failures. */
export type AutonomyErrorCode =
  | 'AUTONOMY_ALREADY_ACTIVE'
  | 'AUTONOMY_INVALID_DURATION'
  | 'AUTONOMY_INVALID_ROUNDS'
  | 'AUTONOMY_INVALID_TRANSITION'
  | 'AUTONOMY_LEASE_MISSING'
  | 'AUTONOMY_VERIFICATION_EXHAUSTED'

/** Autonomy domain failure. */
export class AutonomyError extends Error {
  /** Machine-readable failure classification. */
  readonly code: AutonomyErrorCode

  /**
   * @param message - Human-readable failure.
   * @param code - Stable failure classification.
   */
  constructor(message: string, code: AutonomyErrorCode) {
    super(message)
    this.name = 'AutonomyError'
    this.code = code
  }
}

/** Deployment configuration for the autonomy service. */
export interface AutonomyServiceConfig {
  /** Goal rounds used when `/autopilot start` omits a round budget. */
  defaultMaxGoalRounds?: number
  /** Maximum Goal rounds a user may authorize through this deployment. */
  maxGoalRounds?: number
  /** Active duration used when `/autopilot start` omits a duration. */
  defaultMaxActiveMs?: number
  /** Maximum active duration a user may authorize through this deployment. */
  maxActiveMs?: number
  /** Maximum verifier attempts in one process-local lease. */
  maxVerificationAttempts?: number
  /** Maximum successful dynamic Package definitions in one lease. */
  maxDynamicPackages?: number
  /** Dynamic Cordis capability exposed during an active lease. */
  selfModification?: SelfModificationMode
}

/** Fully validated deployment limits. */
export interface AutonomyLimits {
  readonly defaultMaxGoalRounds: number
  readonly maxGoalRounds: number
  readonly defaultMaxActiveMs: number
  readonly maxActiveMs: number
  readonly maxVerificationAttempts: number
  readonly maxDynamicPackages: number
  readonly selfModification: SelfModificationMode
}

/** Detached current lease view. */
export interface AutonomyLeaseView {
  readonly id: string
  readonly revision: number
  readonly goalId: GoalId
  readonly phase: AutonomyLeasePhase
  readonly grantedAt: number
  readonly expiresAt?: number
  readonly remainingActiveMs: number
  readonly maxActiveMs: number
  readonly verificationAttempts: number
  readonly dynamicPackages: number
  readonly selfModification: SelfModificationMode
  readonly reason?: string
}

/** Request to authorize one Goal. */
export interface AutonomyStartRequest {
  readonly goalId: GoalId
  readonly maxActiveMs?: number
}

interface MutableLease {
  id: string
  revision: number
  goalId: GoalId
  phase: AutonomyLeasePhase
  grantedAt: number
  expiresAt: number | undefined
  remainingActiveMs: number
  maxActiveMs: number
  verificationAttempts: number
  dynamicPackages: number
  selfModification: SelfModificationMode
  reason: string | undefined
  timer: NodeJS.Timeout | undefined
  activity: AbortController
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autonomy: AutonomyService
  }
}

/** Resolve and validate a positive safe integer. */
function positiveSafeInteger(value: number, field: string, code: AutonomyErrorCode): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AutonomyError(`${field} must be a positive safe integer`, code)
  }
  return value
}

/** Freeze deployment configuration into one resolved object. */
export function resolveAutonomyLimits(config: AutonomyServiceConfig): AutonomyLimits {
  const limits: AutonomyLimits = {
    defaultMaxGoalRounds: positiveSafeInteger(
      config.defaultMaxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
      'defaultMaxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    ),
    maxGoalRounds: positiveSafeInteger(
      config.maxGoalRounds ?? DEFAULT_GOAL_ROUNDS_CEILING,
      'maxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    ),
    defaultMaxActiveMs: positiveSafeInteger(
      config.defaultMaxActiveMs ?? DEFAULT_MAX_ACTIVE_MS,
      'defaultMaxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    ),
    maxActiveMs: positiveSafeInteger(
      config.maxActiveMs ?? DEFAULT_ACTIVE_MS_CEILING,
      'maxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    ),
    maxVerificationAttempts: positiveSafeInteger(
      config.maxVerificationAttempts ?? 3,
      'maxVerificationAttempts',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxDynamicPackages: positiveSafeInteger(
      config.maxDynamicPackages ?? 8,
      'maxDynamicPackages',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    selfModification: config.selfModification ?? 'host-only',
  }
  if (limits.defaultMaxGoalRounds > limits.maxGoalRounds) {
    throw new AutonomyError(
      'defaultMaxGoalRounds must not exceed maxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    )
  }
  if (limits.defaultMaxActiveMs > limits.maxActiveMs) {
    throw new AutonomyError(
      'defaultMaxActiveMs must not exceed maxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    )
  }
  return Object.freeze(limits)
}

/** Convert a Goal view to its compare-and-set reference. */
function goalRef(goal: GoalView): { id: GoalId; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

/** Process-local lease and policy service. Durable objectives and rounds remain owned by DSH Goal. */
export class AutonomyService extends Service {
  static inject = ['goals']

  static Config: z<AutonomyServiceConfig> = z.object({
    defaultMaxGoalRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_GOAL_ROUNDS),
    maxGoalRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_GOAL_ROUNDS_CEILING),
    defaultMaxActiveMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_ACTIVE_MS),
    maxActiveMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_ACTIVE_MS_CEILING),
    maxVerificationAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
    maxDynamicPackages: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    selfModification: z.union(['off', 'host-only', 'client-approved'] as const).default('host-only'),
  })

  /** Validated deployment policy. */
  readonly limits: AutonomyLimits

  private readonly leases = new Map<Agent, MutableLease>()

  /**
   * @param ctx - Cordis context that owns the service.
   * @param config - Deployment limits.
   */
  constructor(ctx: Context, config: AutonomyServiceConfig = {}) {
    super(ctx, 'autonomy')
    this.limits = resolveAutonomyLimits(config)

    ctx.on('agent/session-start', ({ agent }) => {
      const lease = this.leases.get(agent)
      if (lease !== undefined && (lease.phase === 'running' || lease.phase === 'verifying')) {
        this.pauseLease(lease, 'session lifecycle restarted; explicit human resume is required')
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const lease = this.leases.get(agent)
      if (lease !== undefined) this.clearLeaseTimer(lease)
      this.leases.delete(agent)
    })
    ctx.effect(() => () => {
      for (const [agent, lease] of this.leases) {
        this.clearLeaseTimer(lease)
        lease.activity.abort(new Error('autonomy service disposed'))
        const goal = this.ctx.goals.get(agent)
        if (goal?.id === lease.goalId && goal.activation === 'armed') {
          this.ctx.goals.disarm(agent)
        }
      }
      this.leases.clear()
    })
  }

  /**
   * Read a detached current lease.
   * @param agent - Exact live agent.
   * @returns Current lease, or `undefined` before authorization or after process restart.
   */
  get(agent: Agent): AutonomyLeaseView | undefined {
    const lease = this.leases.get(agent)
    if (lease === undefined) return undefined
    this.expireIfDue(agent, lease)
    return this.view(lease)
  }

  /**
   * Authorize one Goal within deployment ceilings.
   * @param agent - Exact live agent.
   * @param request - Goal identity and optional active duration.
   * @returns Newly active lease.
   */
  start(agent: Agent, request: AutonomyStartRequest): AutonomyLeaseView {
    const current = this.leases.get(agent)
    if (current !== undefined && !['completed', 'revoked'].includes(current.phase)) {
      throw new AutonomyError('an autonomy lease is already present; pause, resume, or stop it', 'AUTONOMY_ALREADY_ACTIVE')
    }
    if (current !== undefined) this.clearLeaseTimer(current)
    const duration = this.resolveDuration(request.maxActiveMs)
    const now = Date.now()
    const lease: MutableLease = {
      id: `lease-${randomUUID()}`,
      revision: 1,
      goalId: request.goalId,
      phase: 'running',
      grantedAt: now,
      expiresAt: now + duration,
      remainingActiveMs: duration,
      maxActiveMs: duration,
      verificationAttempts: 0,
      dynamicPackages: 0,
      selfModification: this.limits.selfModification,
      reason: undefined,
      timer: undefined,
      activity: new AbortController(),
    }
    this.leases.set(agent, lease)
    this.scheduleExpiry(agent, lease)
    return this.view(lease)
  }

  /**
   * Pause an active lease without consuming paused time.
   * @param agent - Exact live agent.
   * @param reason - Optional human-facing explanation.
   * @returns Paused lease.
   */
  pause(agent: Agent, reason?: string): AutonomyLeaseView {
    const lease = this.requireLease(agent)
    if (lease.phase !== 'running' && lease.phase !== 'verifying') {
      throw this.transitionError(lease, 'pause')
    }
    this.pauseLease(lease, reason)
    return this.view(lease)
  }

  /**
   * Resume a paused lease, or create a fresh lease for a durable Goal after process restart.
   * @param agent - Exact live agent.
   * @param goalId - Durable Goal being reauthorized.
   * @param maxActiveMs - Optional fresh duration when no process-local lease exists.
   * @returns Active lease.
   */
  resume(agent: Agent, goalId: GoalId, maxActiveMs?: number): AutonomyLeaseView {
    const lease = this.leases.get(agent)
    if (lease === undefined) {
      return this.start(agent, {
        goalId,
        ...(maxActiveMs === undefined ? {} : { maxActiveMs }),
      })
    }
    if (lease.goalId !== goalId) {
      throw new AutonomyError('the autonomy lease belongs to a different Goal', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (lease.phase !== 'paused') throw this.transitionError(lease, 'resume')
    lease.phase = 'running'
    lease.revision += 1
    lease.reason = undefined
    lease.expiresAt = Date.now() + lease.remainingActiveMs
    lease.activity = new AbortController()
    this.scheduleExpiry(agent, lease)
    return this.view(lease)
  }

  /**
   * Revoke a non-terminal lease.
   * @param agent - Exact live agent.
   * @param reason - Optional human-facing explanation.
   * @returns Revoked lease.
   */
  revoke(agent: Agent, reason?: string): AutonomyLeaseView {
    const lease = this.requireLease(agent)
    if (lease.phase === 'completed' || lease.phase === 'revoked') {
      throw this.transitionError(lease, 'revoke')
    }
    this.stopLease(lease, 'revoked', reason ?? 'revoked by user')
    return this.view(lease)
  }

  /**
   * Enter the verifier phase and consume one attempt.
   * @param agent - Exact live agent.
   * @returns Verifying lease.
   */
  beginVerification(agent: Agent): AutonomyLeaseView {
    const lease = this.requireLease(agent)
    this.expireIfDue(agent, lease)
    if (lease.phase !== 'running') throw this.transitionError(lease, 'begin verification')
    if (lease.verificationAttempts >= this.limits.maxVerificationAttempts) {
      throw new AutonomyError(
        `verification attempt budget exhausted (${this.limits.maxVerificationAttempts})`,
        'AUTONOMY_VERIFICATION_EXHAUSTED',
      )
    }
    lease.phase = 'verifying'
    lease.revision += 1
    lease.verificationAttempts += 1
    lease.reason = undefined
    return this.view(lease)
  }

  /**
   * Return a failed verification to normal work.
   * @param agent - Exact live agent.
   * @param reason - Verifier summary supplied to the next round.
   * @returns Running lease.
   */
  verificationFailed(agent: Agent, reason: string): AutonomyLeaseView {
    const lease = this.requireLease(agent)
    if (lease.phase !== 'verifying') throw this.transitionError(lease, 'settle failed verification')
    lease.phase = 'running'
    lease.revision += 1
    lease.reason = reason
    return this.view(lease)
  }

  /**
   * Mark a verified lease complete.
   * @param agent - Exact live agent.
   * @returns Completed lease.
   */
  complete(agent: Agent): AutonomyLeaseView {
    const lease = this.requireLease(agent)
    if (lease.phase !== 'verifying') throw this.transitionError(lease, 'complete')
    this.stopLease(lease, 'completed', undefined)
    return this.view(lease)
  }

  /**
   * Count a successful dynamic Package definition.
   * @param agent - Exact live agent.
   * @returns Updated lease.
   */
  recordDynamicPackage(agent: Agent): AutonomyLeaseView {
    const lease = this.requireLease(agent)
    if (lease.phase !== 'running') throw this.transitionError(lease, 'record dynamic Package')
    if (lease.dynamicPackages >= this.limits.maxDynamicPackages) {
      throw new AutonomyError('dynamic Package budget exhausted', 'AUTONOMY_INVALID_TRANSITION')
    }
    lease.dynamicPackages += 1
    lease.revision += 1
    return this.view(lease)
  }

  /**
   * Current lease cancellation signal, aborted by pause, expiry, revoke, or unload.
   * @param agent - Exact live agent.
   * @returns Activity signal.
   */
  signal(agent: Agent): AbortSignal {
    return this.requireLease(agent).activity.signal
  }

  /** Validate a user-requested Goal round cap. */
  resolveGoalRounds(value?: number): number {
    const rounds = positiveSafeInteger(
      value ?? this.limits.defaultMaxGoalRounds,
      'maxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    )
    if (rounds > this.limits.maxGoalRounds) {
      throw new AutonomyError(
        `maxGoalRounds ${rounds} exceeds deployment ceiling ${this.limits.maxGoalRounds}`,
        'AUTONOMY_INVALID_ROUNDS',
      )
    }
    return rounds
  }

  /** Validate a user-requested active duration. */
  resolveDuration(value?: number): number {
    const duration = positiveSafeInteger(
      value ?? this.limits.defaultMaxActiveMs,
      'maxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    )
    if (duration > this.limits.maxActiveMs) {
      throw new AutonomyError(
        `maxActiveMs ${duration} exceeds deployment ceiling ${this.limits.maxActiveMs}`,
        'AUTONOMY_INVALID_DURATION',
      )
    }
    return duration
  }

  private requireLease(agent: Agent): MutableLease {
    const lease = this.leases.get(agent)
    if (lease === undefined) {
      throw new AutonomyError('no process-local autonomy lease; use human `/autopilot resume`', 'AUTONOMY_LEASE_MISSING')
    }
    return lease
  }

  private view(lease: MutableLease): AutonomyLeaseView {
    const remainingActiveMs = lease.expiresAt === undefined
      ? lease.remainingActiveMs
      : Math.max(0, lease.expiresAt - Date.now())
    return {
      id: lease.id,
      revision: lease.revision,
      goalId: lease.goalId,
      phase: lease.phase,
      grantedAt: lease.grantedAt,
      ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt }),
      remainingActiveMs,
      maxActiveMs: lease.maxActiveMs,
      verificationAttempts: lease.verificationAttempts,
      dynamicPackages: lease.dynamicPackages,
      selfModification: lease.selfModification,
      ...(lease.reason === undefined ? {} : { reason: lease.reason }),
    }
  }

  private transitionError(lease: MutableLease, operation: string): AutonomyError {
    return new AutonomyError(
      `cannot ${operation} autonomy lease while phase is "${lease.phase}"`,
      'AUTONOMY_INVALID_TRANSITION',
    )
  }

  private pauseLease(lease: MutableLease, reason?: string): void {
    /* v8 ignore next -- callers admit only running/verifying leases, which always retain an expiry. */
    lease.remainingActiveMs = lease.expiresAt === undefined
      ? lease.remainingActiveMs
      : Math.max(0, lease.expiresAt - Date.now())
    this.clearLeaseTimer(lease)
    lease.expiresAt = undefined
    lease.phase = lease.remainingActiveMs > 0 ? 'paused' : 'exhausted'
    lease.revision += 1
    lease.reason = reason
    lease.activity.abort(new Error(reason ?? 'autonomy lease paused'))
  }

  private stopLease(
    lease: MutableLease,
    phase: 'completed' | 'revoked',
    reason: string | undefined,
  ): void {
    lease.remainingActiveMs = lease.expiresAt === undefined
      ? lease.remainingActiveMs
      : Math.max(0, lease.expiresAt - Date.now())
    this.clearLeaseTimer(lease)
    lease.expiresAt = undefined
    lease.phase = phase
    lease.revision += 1
    lease.reason = reason
    lease.activity.abort(new Error(reason ?? `autonomy lease ${phase}`))
  }

  private clearLeaseTimer(lease: MutableLease): void {
    if (lease.timer !== undefined) clearTimeout(lease.timer)
    lease.timer = undefined
  }

  private scheduleExpiry(agent: Agent, lease: MutableLease): void {
    this.clearLeaseTimer(lease)
    /* v8 ignore next -- start and resume assign expiresAt immediately before scheduling. */
    const remaining = Math.max(0, (lease.expiresAt ?? Date.now()) - Date.now())
    lease.timer = setTimeout(() => {
      lease.timer = undefined
      if (remaining > MAX_TIMER_DELAY_MS) {
        this.scheduleExpiry(agent, lease)
      } else {
        this.expireIfDue(agent, lease)
      }
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
    lease.timer.unref()
  }

  private expireIfDue(agent: Agent, lease: MutableLease): void {
    if ((lease.phase !== 'running' && lease.phase !== 'verifying')
      || lease.expiresAt === undefined || lease.expiresAt > Date.now()) return

    this.clearLeaseTimer(lease)
    lease.remainingActiveMs = 0
    lease.expiresAt = undefined
    lease.phase = 'exhausted'
    lease.revision += 1
    lease.reason = 'active duration exhausted'
    lease.activity.abort(new Error('autonomy active duration exhausted'))

    const goal = this.ctx.goals.get(agent)
    if (goal !== undefined && goal.id === lease.goalId && goal.phase === 'active') {
      try {
        this.ctx.goals.pause(agent, goalRef(goal))
      } catch (error: unknown) {
        this.ctx.logger.warn(`oh-my-dsh: could not pause expired Goal: ${String(error)}`)
        this.ctx.goals.disarm(agent)
      }
    }
    agent.cancel({ kind: 'hook', reason: 'oh-my-dsh lease expired' }, { keepInbox: true })
  }
}

export default AutonomyService
