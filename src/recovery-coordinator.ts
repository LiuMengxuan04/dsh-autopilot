/** Host-bundle readiness barrier for explicitly started Autopilot cold recovery. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { RecoveryReadinessAdmission } from './recovery.ts'

// FiberState is a public const enum, so transpile-only consumers cannot read it at runtime.
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Function-plugin contributions that must exist before autonomous work resumes. */
export const RECOVERY_CRITICAL_CONTRIBUTIONS = Object.freeze([
  'commands',
  'tools',
  'skills',
  'skill-mcp',
  'tool-team',
  'tool-ralph',
  'tool-workflow',
  'tool-mission',
  'visual-qa',
  'code-intelligence',
  'tool-memory',
  'tool-delivery',
] as const)

/** One recovery-critical function-plugin contribution. */
export type RecoveryCriticalContribution = typeof RECOVERY_CRITICAL_CONTRIBUTIONS[number]

/** Opaque readiness generation captured before a lifecycle command yields. */
export interface RecoveryReadinessCheckpoint {
  readonly epoch: symbol
}

/** Lifecycle admission failure caused by an incomplete or changing Host bundle. */
export class RecoveryReadinessError extends Error {
  readonly code = 'AUTOPILOT_BUNDLE_NOT_READY'
  readonly missing: readonly RecoveryCriticalContribution[]

  /**
   * @param missing - Contributions absent at the rejected observation.
   * @param changed - Whether a formerly complete generation was invalidated.
   */
  constructor(missing: readonly RecoveryCriticalContribution[], changed: boolean) {
    const detail = missing.length === 0
      ? 'retry after plugin reload settles'
      : `missing contributions: ${missing.join(', ')}`
    super(`Autopilot bundle ${changed ? 'changed during lifecycle activation' : 'is not ready'}; ${detail}.`)
    this.name = 'RecoveryReadinessError'
    this.missing = Object.freeze([...missing])
  }
}

/**
 * Publish one function-plugin readiness contribution across arbitrary Loader order.
 * @param ctx - The contributing plugin's owning context.
 * @param contribution - Stable bundle contribution identifier.
 */
export function registerRecoveryContribution(
  ctx: Context,
  contribution: RecoveryCriticalContribution,
): void {
  ctx.inject(['autopilotRecoveryReadiness'], (readyCtx) => {
    readyCtx.effect(
      () => readyCtx.autopilotRecoveryReadiness.register(contribution),
      `dsh-autopilot.recoveryReady(${contribution})`,
    )
  })
}

/**
 * Services whose initialized seats prove the additive Host bundle is ready to
 * rearm durable work. Disabled or inert service configurations still publish
 * their seats after initialization.
 */
export const RECOVERY_COORDINATOR_INJECT = Object.freeze([
  'autonomy',
  'autopilotRecoveryReadiness',
  'sessionPersistence',
  'fs',
  'shell',
  'subagents',
  'systemPrompt',
  'tools',
  'skills',
  'autopilotWorkflows',
  'autopilotLifecycleHooks',
  'autopilotTeam',
  'autopilotRalph',
  'autopilotMissions',
  'autopilotDelivery',
  'autopilotMemory',
  'autopilotPromptRules',
] as const)

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotRecoveryReadiness: AutopilotRecoveryReadiness
    autopilotRecoveryCoordinator: AutopilotRecoveryCoordinator
  }
}

/** Aggregate exact function-plugin readiness without relying on Loader row order. */
export class AutopilotRecoveryReadiness extends Service {
  private readonly counts = new Map<RecoveryCriticalContribution, number>()
  private readonly waiters = new Set<() => void>()
  private epoch = Symbol('dsh-autopilot-readiness')

  /** @param ctx - Host context that owns the readiness registry. */
  constructor(ctx: Context) {
    super(ctx, 'autopilotRecoveryReadiness')
  }

  /**
   * Register one contribution for its owning plugin fiber.
   * @param contribution - Stable bundle contribution identifier.
   * @returns Idempotent disposer for HMR and plugin unload.
   */
  register(contribution: RecoveryCriticalContribution): () => void {
    this.counts.set(contribution, (this.counts.get(contribution) ?? 0) + 1)
    this.advanceEpoch()
    this.settleIfReady()
    let active = true
    return () => {
      if (!active) return
      active = false
      const count = this.counts.get(contribution)
      /* v8 ignore next -- this disposer owns one previously registered count. */
      if (count === undefined) return
      this.advanceEpoch()
      if (count !== 1) {
        this.counts.set(contribution, count - 1)
        return
      }
      this.counts.delete(contribution)
      if (this.ctx.root.fiber.state !== FIBER_UNLOADING
        && this.ctx.root.fiber.state !== FIBER_DISPOSED) {
        this.failActiveRuns(contribution)
      }
    }
  }

  /**
   * Wait until every recovery-critical function plugin has registered.
   * @returns A one-shot readiness barrier for cold recovery admission.
   */
  whenReady(): Promise<void> {
    if (this.missing().length === 0) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.add(resolve) })
  }

  /** Return recovery-critical contributions not currently registered. */
  missing(): readonly RecoveryCriticalContribution[] {
    return Object.freeze(RECOVERY_CRITICAL_CONTRIBUTIONS.filter(name => !this.counts.has(name)))
  }

  /**
   * Capture the exact complete contribution generation before an asynchronous lifecycle operation.
   * @returns Opaque generation token accepted only while every registration remains unchanged.
   */
  checkpoint(): RecoveryReadinessCheckpoint {
    const missing = this.missing()
    if (missing.length > 0) throw new RecoveryReadinessError(missing, false)
    return Object.freeze({ epoch: this.epoch })
  }

  /**
   * Reject a lifecycle operation if any contribution registered or unloaded after admission.
   * @param checkpoint - Token returned by {@link checkpoint} before the operation yielded.
   */
  assertCurrent(checkpoint: RecoveryReadinessCheckpoint): void {
    const missing = this.missing()
    if (checkpoint.epoch !== this.epoch || missing.length > 0) {
      throw new RecoveryReadinessError(missing, true)
    }
  }

  private advanceEpoch(): void {
    this.epoch = Symbol('dsh-autopilot-readiness')
  }

  private settleIfReady(): void {
    if (this.waiters.size === 0 || this.missing().length > 0) return
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }

  /** Fail closed every live or detached active row before a partial bundle can continue. */
  private failActiveRuns(contribution: RecoveryCriticalContribution): void {
    const autonomy = this.ctx.get('autonomy')
    if (autonomy === undefined) return
    const reason = `recovery-critical bundle contribution unloaded: ${contribution}`
    void autonomy.failRecoveryReadiness(reason).catch((error: unknown) => {
      this.ctx.logger.error(
        `dsh-autopilot: ${reason}; could not persist needs-attention: ${String(error)}`,
      )
    })
  }
}

/** Start cold recovery only after every required Host service has initialized. */
export class AutopilotRecoveryCoordinator extends Service {
  static inject = [...RECOVERY_COORDINATOR_INJECT]

  /** @param ctx - Fully assembled Host context. */
  constructor(ctx: Context) {
    super(ctx, 'autopilotRecoveryCoordinator')
  }

  /** Yield past synchronous sibling plugin activation, then start the owned scan. */
  protected async [Service.init](): Promise<void> {
    await this.ctx.autopilotRecoveryReadiness.whenReady()
    await Promise.resolve()
    const readiness: RecoveryReadinessAdmission = Object.freeze({
      checkpoint: () => {
        const checkpoint = this.ctx.autopilotRecoveryReadiness.checkpoint()
        return Object.freeze({
          assertCurrent: () => this.ctx.autopilotRecoveryReadiness.assertCurrent(checkpoint),
        })
      },
    })
    try {
      readiness.checkpoint().assertCurrent()
    } catch (error: unknown) {
      const reason = `cold recovery admission failed: ${String(error)}`
      await this.ctx.autonomy.failRecoveryReadiness(reason).catch((failure: unknown) => {
        this.ctx.logger.error(`dsh-autopilot: ${reason}; fail-close failed: ${String(failure)}`)
      })
      this.ctx.logger.error(`dsh-autopilot: ${reason}`)
      return
    }
    void this.ctx.autonomy.startRecovery(readiness).catch((error: unknown) => {
      this.ctx.logger.error(`dsh-autopilot: recovery coordinator failed to start: ${String(error)}`)
    })
  }
}

/** Stable Cordis plugin name for the composite readiness/coordinator runtime. */
export const name = 'dsh-autopilot-recovery-coordinator'

/** Install the readiness registry before the dependency-gated coordinator. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(AutopilotRecoveryReadiness)
  await ctx.plugin(AutopilotRecoveryCoordinator)
}

export default { name, apply }
