import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import recoveryCoordinatorPlugin, {
  AutopilotRecoveryCoordinator,
  AutopilotRecoveryReadiness,
  RECOVERY_CRITICAL_CONTRIBUTIONS,
  RECOVERY_COORDINATOR_INJECT,
  registerRecoveryContribution,
} from '../../src/recovery-coordinator.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((settle) => { resolve = settle })
  return {
    promise,
    /* v8 ignore next -- the Promise executor initializes this synchronously. */
    resolve: value => resolve?.(value),
  }
}

function provideSeat(
  ctx: Context,
  seat: string,
  startRecovery: ReturnType<typeof vi.fn>,
  failRecoveryReadiness: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve()),
): void {
  if (seat !== 'autopilotRecoveryReadiness') {
    ctx.provide(seat, seat === 'autonomy' ? { startRecovery, failRecoveryReadiness } : {})
  }
}

async function readyContributions(ctx: Context): Promise<void> {
  await ctx.plugin(AutopilotRecoveryReadiness)
  registerContributions(ctx)
}

function registerContributions(ctx: Context): void {
  for (const contribution of RECOVERY_CRITICAL_CONTRIBUTIONS) {
    ctx.effect(() => ctx.autopilotRecoveryReadiness.register(contribution))
  }
}

describe('AutopilotRecoveryCoordinator', () => {
  it('waits for every delayed bundle service seat before starting once', async () => {
    const ctx = new Context()
    const startRecovery = vi.fn(() => Promise.resolve([]))
    await ctx.plugin(recoveryCoordinatorPlugin)
    registerContributions(ctx)
    provideSeat(ctx, RECOVERY_COORDINATOR_INJECT[0], startRecovery)

    for (const seat of RECOVERY_COORDINATOR_INJECT.slice(1, -1)) {
      provideSeat(ctx, seat, startRecovery)
      await Promise.resolve()
      expect(startRecovery).not.toHaveBeenCalled()
    }
    const finalSeat = RECOVERY_COORDINATOR_INJECT.at(-1)
    if (finalSeat === undefined) throw new Error('fixture readiness list is empty')
    provideSeat(ctx, finalSeat, startRecovery)
    await vi.waitFor(() => { expect(startRecovery).toHaveBeenCalledOnce() })
    await ctx.fiber.dispose()
  })

  it('does not tie an already-started recovery task to coordinator unload', async () => {
    const ctx = new Context()
    const scan = deferred<readonly []>()
    const startRecovery = vi.fn(() => scan.promise)
    await readyContributions(ctx)
    for (const seat of RECOVERY_COORDINATOR_INJECT) provideSeat(ctx, seat, startRecovery)
    const fiber = await ctx.plugin(AutopilotRecoveryCoordinator)
    expect(startRecovery).toHaveBeenCalledOnce()

    let settled = false
    void scan.promise.then(() => { settled = true })
    await fiber.dispose()
    expect(settled).toBe(false)
    scan.resolve([])
    await scan.promise
    expect(settled).toBe(true)
    await ctx.fiber.dispose()
  })

  it('does not start while one function-plugin contribution is still missing', async () => {
    const ctx = new Context()
    const startRecovery = vi.fn(() => Promise.resolve([]))
    await ctx.plugin(AutopilotRecoveryReadiness)
    for (const seat of RECOVERY_COORDINATOR_INJECT) provideSeat(ctx, seat, startRecovery)
    for (const contribution of RECOVERY_CRITICAL_CONTRIBUTIONS.slice(0, -1)) {
      ctx.effect(() => ctx.autopilotRecoveryReadiness.register(contribution))
    }
    const loading = ctx.plugin(AutopilotRecoveryCoordinator)
    await Promise.resolve()
    expect(startRecovery).not.toHaveBeenCalled()

    const finalContribution = RECOVERY_CRITICAL_CONTRIBUTIONS.at(-1)
    if (finalContribution === undefined) throw new Error('fixture contribution list is empty')
    ctx.effect(() => ctx.autopilotRecoveryReadiness.register(finalContribution))
    await loading
    await vi.waitFor(() => { expect(startRecovery).toHaveBeenCalledOnce() })
    await ctx.fiber.dispose()
  })

  it('fails durable recovery closed when the final contribution unloads after the barrier resolves', async () => {
    const ctx = new Context()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    const startRecovery = vi.fn(() => Promise.resolve([]))
    const failRecoveryReadiness = vi.fn(() => Promise.reject(new Error('readiness store unavailable')))
    await ctx.plugin(AutopilotRecoveryReadiness)
    for (const seat of RECOVERY_COORDINATOR_INJECT) {
      provideSeat(ctx, seat, startRecovery, failRecoveryReadiness)
    }
    for (const contribution of RECOVERY_CRITICAL_CONTRIBUTIONS.slice(0, -1)) {
      ctx.autopilotRecoveryReadiness.register(contribution)
    }
    const loading = ctx.plugin(AutopilotRecoveryCoordinator)
    await Promise.resolve()
    const finalContribution = RECOVERY_CRITICAL_CONTRIBUTIONS.at(-1)
    if (finalContribution === undefined) throw new Error('fixture contribution list is empty')
    const unload = ctx.autopilotRecoveryReadiness.register(finalContribution)
    unload()

    await loading
    expect(startRecovery).not.toHaveBeenCalled()
    expect(failRecoveryReadiness).toHaveBeenCalledWith(expect.stringContaining(
      `contribution unloaded: ${finalContribution}`,
    ))
    expect(failRecoveryReadiness).toHaveBeenCalledWith(expect.stringContaining(
      'cold recovery admission failed',
    ))
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(
        /could not persist needs-attention.*readiness store unavailable/,
      ))
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(
        /cold recovery admission failed.*fail-close failed.*readiness store unavailable/,
      ))
    })
    await ctx.fiber.dispose()
  })

  it('contains and reports a start failure', async () => {
    const ctx = new Context()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    const startRecovery = vi.fn(() => Promise.reject(new Error('start unavailable')))
    await readyContributions(ctx)
    for (const seat of RECOVERY_COORDINATOR_INJECT) provideSeat(ctx, seat, startRecovery)
    await ctx.plugin(AutopilotRecoveryCoordinator)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(
        /recovery coordinator failed to start.*start unavailable/,
      ))
    })
    await ctx.fiber.dispose()
  })

  it('tracks overlapping HMR contributions and settles only with the complete set', async () => {
    const ctx = new Context()
    await ctx.plugin(AutopilotRecoveryReadiness)
    const readiness = ctx.autopilotRecoveryReadiness
    const firstContribution = RECOVERY_CRITICAL_CONTRIBUTIONS[0]
    const first = readiness.register(firstContribution)
    const replacement = readiness.register(firstContribution)
    first()
    first()
    expect(readiness.missing()).not.toContain(firstContribution)

    let ready = false
    const barrier = readiness.whenReady().then(() => { ready = true })
    for (const contribution of RECOVERY_CRITICAL_CONTRIBUTIONS.slice(1)) {
      readiness.register(contribution)
    }
    await barrier
    expect(ready).toBe(true)
    expect(readiness.missing()).toEqual([])
    await expect(readiness.whenReady()).resolves.toBeUndefined()
    replacement()
    expect(readiness.missing()).toEqual([firstContribution])
    await ctx.fiber.dispose()
  })

  it('invalidates a complete checkpoint across gapless HMR replacement', async () => {
    const ctx = new Context()
    await ctx.plugin(AutopilotRecoveryReadiness)
    const disposers = new Map(RECOVERY_CRITICAL_CONTRIBUTIONS.map(contribution => [
      contribution,
      ctx.autopilotRecoveryReadiness.register(contribution),
    ]))
    const checkpoint = ctx.autopilotRecoveryReadiness.checkpoint()
    expect(() => ctx.autopilotRecoveryReadiness.assertCurrent(checkpoint)).not.toThrow()

    const contribution = RECOVERY_CRITICAL_CONTRIBUTIONS[0]
    const replacement = ctx.autopilotRecoveryReadiness.register(contribution)
    disposers.get(contribution)?.()
    expect(ctx.autopilotRecoveryReadiness.missing()).toEqual([])
    expect(() => ctx.autopilotRecoveryReadiness.assertCurrent(checkpoint)).toThrow(expect.objectContaining({
      code: 'AUTOPILOT_BUNDLE_NOT_READY',
      message: expect.stringContaining('changed during lifecycle activation'),
      missing: [],
    }))
    expect(() => ctx.autopilotRecoveryReadiness.assertCurrent(
      ctx.autopilotRecoveryReadiness.checkpoint(),
    )).not.toThrow()

    replacement()
    await ctx.fiber.dispose()
  })

  it('registers a function contribution across Loader order and removes it on HMR unload', async () => {
    const ctx = new Context()
    const contribution = RECOVERY_CRITICAL_CONTRIBUTIONS[0]
    const fiber = await ctx.plugin((pluginCtx) => {
      registerRecoveryContribution(pluginCtx, contribution)
    })
    await ctx.plugin(AutopilotRecoveryReadiness)
    await vi.waitFor(() => {
      expect(ctx.autopilotRecoveryReadiness.missing()).not.toContain(contribution)
    })

    await fiber.dispose()
    expect(ctx.autopilotRecoveryReadiness.missing()).toContain(contribution)
    await ctx.fiber.dispose()
  })
})
