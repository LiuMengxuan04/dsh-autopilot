import { agentEvents } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutonomyError, AutonomyService, resolveAutonomyLimits } from '../../src/service.ts'
import { createHarness, createTestAgent } from '../helpers.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('AutonomyService limits', () => {
  it.each([
    [{ defaultMaxGoalRounds: 0 }, 'AUTONOMY_INVALID_ROUNDS'],
    [{ maxGoalRounds: 1.5 }, 'AUTONOMY_INVALID_ROUNDS'],
    [{ defaultMaxGoalRounds: 3, maxGoalRounds: 2 }, 'AUTONOMY_INVALID_ROUNDS'],
    [{ defaultMaxActiveMs: 0 }, 'AUTONOMY_INVALID_DURATION'],
    [{ maxActiveMs: Number.MAX_SAFE_INTEGER + 1 }, 'AUTONOMY_INVALID_DURATION'],
    [{ defaultMaxActiveMs: 3, maxActiveMs: 2 }, 'AUTONOMY_INVALID_DURATION'],
    [{ maxVerificationAttempts: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxDynamicPackages: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
  ])('rejects invalid configuration %j', (autonomy, code) => {
    expect(() => resolveAutonomyLimits(autonomy)).toThrow(expect.objectContaining({ code }))
  })

  it('materializes defaults and enforces requested ceilings', async () => {
    const { ctx } = await createHarness({
      autonomy: {
        defaultMaxGoalRounds: 4,
        maxGoalRounds: 8,
        defaultMaxActiveMs: 1000,
        maxActiveMs: 2000,
        selfModification: 'off',
      },
    })
    expect(ctx.autonomy.limits).toMatchObject({
      defaultMaxGoalRounds: 4,
      maxGoalRounds: 8,
      defaultMaxActiveMs: 1000,
      maxActiveMs: 2000,
      selfModification: 'off',
    })
    expect(ctx.autonomy.resolveGoalRounds()).toBe(4)
    expect(ctx.autonomy.resolveDuration()).toBe(1000)
    expect(() => ctx.autonomy.resolveGoalRounds(9)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_ROUNDS',
    }))
    expect(() => ctx.autonomy.resolveGoalRounds(1.5)).toThrow(AutonomyError)
    expect(() => ctx.autonomy.resolveDuration(2001)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_DURATION',
    }))
    expect(() => ctx.autonomy.resolveDuration(-1)).toThrow(AutonomyError)
    await ctx.fiber.dispose()
  })
})

describe('AutonomyService lifecycle', () => {
  it('pauses active time, resumes with a fresh signal, and revokes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 5000, maxActiveMs: 10_000 },
    })
    const goal = ctx.goals.create(agent, { objective: 'exercise lease' })
    expect(ctx.autonomy.start(agent, { goalId: goal.id })).toMatchObject({
      revision: 1, phase: 'running', remainingActiveMs: 5000,
    })
    const firstSignal = ctx.autonomy.signal(agent)
    await vi.advanceTimersByTimeAsync(1200)
    expect(ctx.autonomy.pause(agent, 'manual pause')).toMatchObject({
      revision: 2, phase: 'paused', remainingActiveMs: 3800, reason: 'manual pause',
    })
    expect(firstSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ctx.autonomy.get(agent)?.remainingActiveMs).toBe(3800)
    expect(ctx.autonomy.resume(agent, goal.id)).toMatchObject({ revision: 3, phase: 'running' })
    expect(ctx.autonomy.signal(agent)).not.toBe(firstSignal)
    expect(ctx.autonomy.revoke(agent)).toMatchObject({ phase: 'revoked', reason: 'revoked by user' })
    expect(() => ctx.autonomy.revoke(agent)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_TRANSITION',
    }))
    await ctx.fiber.dispose()
  })

  it('expires, pauses the Goal, preserves queued work, and supports segmented long timers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 1000, maxActiveMs: 3_000_000_000 },
    })
    const goal = ctx.goals.create(agent, { objective: 'expire safely' })
    ctx.autonomy.start(agent, { goalId: goal.id, maxActiveMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'exhausted', remainingActiveMs: 0 })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot lease expired' },
      { keepInbox: true },
    )

    const completed = ctx.goals.complete(agent, ctx.goals.get(agent)!)
    const next = ctx.goals.create(agent, { objective: 'long lease' })
    expect(completed.phase).toBe('complete')
    ctx.autonomy.revoke(agent, 'replace exhausted lease')
    ctx.autonomy.start(agent, { goalId: next.id, maxActiveMs: 3_000_000_000 })
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(ctx.autonomy.get(agent)?.phase).toBe('running')
    await ctx.fiber.dispose()
  })

  it('tracks verification and dynamic Package budgets with strict transitions', async () => {
    const { ctx, agent } = await createHarness({
      autonomy: { maxVerificationAttempts: 1, maxDynamicPackages: 1 },
    })
    const goal = ctx.goals.create(agent, { objective: 'budget state' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    expect(ctx.autonomy.recordDynamicPackage(agent)).toMatchObject({ dynamicPackages: 1 })
    expect(() => ctx.autonomy.recordDynamicPackage(agent)).toThrow('dynamic Package budget exhausted')
    expect(ctx.autonomy.beginVerification(agent)).toMatchObject({
      phase: 'verifying', verificationAttempts: 1,
    })
    expect(() => ctx.autonomy.recordDynamicPackage(agent)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_TRANSITION',
    }))
    expect(() => ctx.autonomy.beginVerification(agent)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_TRANSITION',
    }))
    expect(ctx.autonomy.verificationFailed(agent, 'fix tests')).toMatchObject({
      phase: 'running', reason: 'fix tests',
    })
    expect(() => ctx.autonomy.beginVerification(agent)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_VERIFICATION_EXHAUSTED',
    }))
    expect(() => ctx.autonomy.complete(agent)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_TRANSITION',
    }))
    await ctx.fiber.dispose()
  })

  it('completes only from verification and rejects mismatched or exhausted resumes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 1, maxActiveMs: 100 },
    })
    const goal = ctx.goals.create(agent, { objective: 'finish' })
    expect(() => ctx.autonomy.signal(agent)).toThrow(expect.objectContaining({ code: 'AUTONOMY_LEASE_MISSING' }))
    ctx.autonomy.start(agent, { goalId: goal.id })
    expect(() => ctx.autonomy.start(agent, { goalId: goal.id })).toThrow(expect.objectContaining({
      code: 'AUTONOMY_ALREADY_ACTIVE',
    }))
    ctx.autonomy.beginVerification(agent)
    expect(ctx.autonomy.complete(agent).phase).toBe('completed')
    expect(() => ctx.autonomy.pause(agent)).toThrow(expect.objectContaining({ code: 'AUTONOMY_INVALID_TRANSITION' }))

    const replacement = ctx.goals.complete(agent, goal)
    const next = ctx.goals.create(agent, { objective: 'next' })
    expect(replacement.phase).toBe('complete')
    ctx.autonomy.start(agent, { goalId: next.id })
    expect(() => ctx.autonomy.resume(agent, next.id)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_TRANSITION',
    }))
    expect(() => ctx.autonomy.verificationFailed(agent, 'not verifying')).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_TRANSITION',
    }))
    ctx.autonomy.pause(agent)
    expect(() => ctx.autonomy.resume(agent, goal.id)).toThrow('different Goal')
    await vi.advanceTimersByTimeAsync(10)
    const internal = ctx.autonomy.get(agent)
    expect(internal?.phase).toBe('paused')
    await ctx.fiber.dispose()
  })

  it('handles lifecycle notifications with and without active leases and releases disposed Agents', async () => {
    const { ctx, agent } = await createHarness()
    const outsider = createTestAgent('lifecycle-outsider')
    agentEvents(ctx, outsider).emit('agent/session-start', { source: 'startup' })
    agentEvents(ctx, outsider).emit('agent/disposed', {})

    const goal = ctx.goals.create(agent, { objective: 'lifecycle coverage' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.autonomy.beginVerification(agent)
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused' })
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    agentEvents(ctx, agent).emit('agent/disposed', {})
    expect(ctx.autonomy.get(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('exhausts synchronously when a lifecycle restart observes an elapsed lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
    })
    const goal = ctx.goals.create(agent, { objective: 'elapsed before notification' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    vi.setSystemTime(1010)
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'exhausted', remainingActiveMs: 0 })
    await ctx.fiber.dispose()
  })

  it('disarms an active Goal when the service is unloaded directly', async () => {
    const { ctx, agent, autonomyFiber } = await createHarness()
    const goal = ctx.goals.create(agent, { objective: 'unload active lease' })
    const signal = ctx.autonomy.start(agent, { goalId: goal.id })
    expect(signal.phase).toBe('running')
    await autonomyFiber.dispose()
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('contains Goal pause failures during expiry and still cancels autonomous work', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
    })
    const goal = ctx.goals.create(agent, { objective: 'expiry fallback' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    vi.spyOn(ctx.goals, 'pause').mockImplementation(() => {
      throw new Error('pause storage failed')
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'exhausted' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(agent.cancel).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('expires without mutating a Goal that is already paused', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
    })
    const goal = ctx.goals.create(agent, { objective: 'already paused' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.goals.pause(agent, goal)
    await vi.advanceTimersByTimeAsync(10)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'exhausted' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused' })
    await ctx.fiber.dispose()
  })

  it('creates a fresh post-restart lease with an explicit duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createHarness({
      autonomy: { defaultMaxActiveMs: 1000, maxActiveMs: 5000 },
    })
    const goal = ctx.goals.create(agent, { objective: 'fresh explicit lease' })
    expect(ctx.autonomy.resume(agent, goal.id, 2500)).toMatchObject({
      phase: 'running', maxActiveMs: 2500, remainingActiveMs: 2500,
    })
    await ctx.fiber.dispose()
  })

  it('disarms on service unload and requires a fresh lease after a lifecycle restart', async () => {
    const { ctx, agent, autonomyFiber } = await createHarness()
    const goal = ctx.goals.create(agent, { objective: 'survive reload' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused' })
    expect(ctx.goals.get(agent)?.activation).toBe('disarmed')

    await autonomyFiber.dispose()
    expect(ctx.get('autonomy')).toBeUndefined()
    expect(ctx.goals.get(agent)?.activation).toBe('disarmed')
    await ctx.plugin(AutonomyService)
    expect(ctx.autonomy.get(agent)).toBeUndefined()
    expect(ctx.autonomy.resume(agent, goal.id)).toMatchObject({ phase: 'running', goalId: goal.id })
    expect(ctx.goals.resume(agent, ctx.goals.get(agent)!)).toMatchObject({ activation: 'armed' })
    await ctx.fiber.dispose()
  })
})
