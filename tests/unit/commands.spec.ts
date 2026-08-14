import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutonomyError } from '../../src/service.ts'
import { parseAutopilotCommand, parseDuration } from '../../src/commands.ts'
import { createHarness, createTestAgent } from '../helpers.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('autopilot command parsing', () => {
  it.each([
    ['1ms', 1],
    ['2s', 2000],
    ['3m', 180_000],
    ['4h', 14_400_000],
    ['5d', 432_000_000],
    ['2w', 1_209_600_000],
  ])('parses duration %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each([
    '',
    '0h',
    '1',
    '1H',
    '-1h',
    '1.5h',
    '999999999999999999999w',
    '9007199254740991w',
  ])('rejects duration %j', (input) => {
    expect(parseDuration(input)).toBeUndefined()
  })

  it('parses status, lifecycle controls, and bounded starts', () => {
    expect(parseAutopilotCommand('')).toEqual({ kind: 'status' })
    expect(parseAutopilotCommand(' STATUS ')).toEqual({ kind: 'status' })
    expect(parseAutopilotCommand('pause')).toEqual({ kind: 'pause' })
    expect(parseAutopilotCommand('stop')).toEqual({ kind: 'stop' })
    expect(parseAutopilotCommand('resume --duration=2d')).toEqual({
      kind: 'resume', maxActiveMs: 172_800_000,
    })
    expect(parseAutopilotCommand('resume')).toEqual({ kind: 'resume' })
    expect(parseAutopilotCommand('start ship it')).toEqual({ kind: 'start', objective: 'ship it' })
    expect(parseAutopilotCommand('start --duration 7d --rounds=400 ship it')).toEqual({
      kind: 'start', objective: 'ship it', maxGoalRounds: 400, maxActiveMs: 604_800_000,
    })
  })

  it.each([
    ['start', '`start` requires'],
    ['resume trailing', '`resume` accepts'],
    ['resume --rounds 3', '--rounds is accepted'],
    ['start --rounds 0 objective', '--rounds requires'],
    ['start --rounds 2 --rounds 3 objective', '--rounds may be supplied'],
    ['start --duration 1x objective', '--duration requires'],
    ['start --duration 1d --duration 2d objective', '--duration may be supplied'],
    ['start --unknown 2 objective', 'Invalid option'],
    ['dance', 'Unknown autopilot operation'],
  ])('returns an actionable error for %j', (input, message) => {
    expect(parseAutopilotCommand(input)).toMatchObject({ kind: 'invalid', message: expect.stringContaining(message) })
  })
})

describe('/autopilot lifecycle', () => {
  it('starts, reports, pauses, resumes, and stops one durable Goal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal

    const started = await ctx.commands.execute(
      agent,
      '/autopilot start --rounds 3 --duration 2h complete the integration',
      signal,
    )
    expect(started?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('Rounds: 0/3') })
    expect(ctx.goals.get(agent)).toMatchObject({ objective: 'complete the integration', maxGoalRounds: 3 })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', remainingActiveMs: 7_200_000 })

    const paused = await ctx.commands.execute(agent, '/autopilot pause', signal)
    expect(paused?.result.text).toContain('Autopilot: paused')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

    const resumed = await ctx.commands.execute(agent, '/autopilot resume', signal)
    expect(resumed?.result.text).toContain('Goal: active (armed)')
    expect(ctx.autonomy.get(agent)?.phase).toBe('running')

    const stopped = await ctx.commands.execute(agent, '/autopilot stop', signal)
    expect(stopped?.result.text).toContain('Autopilot: revoked')
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    expect(agent.cancel).toHaveBeenLastCalledWith({ kind: 'user' })
    expect(agent.session.events.filter(event => event.type === 'command/run')).toHaveLength(4)
    await ctx.fiber.dispose()
  })

  it('requires a top-level Agent and reports missing or invalid state', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    expect((await ctx.commands.execute(agent, '/autopilot status', signal))?.result)
      .toEqual({ kind: 'success', text: 'No current Goal or Autopilot lease.' })
    expect((await ctx.commands.execute(agent, '/autopilot pause', signal))?.result)
      .toMatchObject({ kind: 'error', text: expect.stringContaining('No current Goal') })
    expect((await ctx.commands.execute(agent, '/autopilot nonsense', signal))?.result)
      .toMatchObject({ kind: 'error', text: expect.stringContaining('Unknown autopilot operation') })

    const outsider = createTestAgent('outsider')
    const definition = ctx.commands.find(outsider, 'autopilot')
    expect(await definition?.handler({
      agent: outsider,
      rawInput: 'status',
      signal,
      commandId: 'test-command' as never,
    })).toMatchObject({ kind: 'error', text: expect.stringContaining('top-level') })
    await ctx.fiber.dispose()
  })

  it.each([
    ['1d', 'Active time remaining: 1d'],
    ['36h', 'Active time remaining: 1.5d'],
    ['1h', 'Active time remaining: 1h'],
    ['90m', 'Active time remaining: 1.5h'],
    ['1m', 'Active time remaining: 1m'],
    ['90s', 'Active time remaining: 1.5m'],
    ['1s', 'Active time remaining: 1s'],
  ])('renders a %s lease compactly', async (duration, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { ctx, agent } = await createHarness()
    const result = await ctx.commands.execute(
      agent,
      `/autopilot start --duration ${duration} render duration`,
      new AbortController().signal,
    )
    expect(result?.result.text).toContain(expected)
    await ctx.fiber.dispose()
  })

  it('reports a durable Goal without a process-local lease', async () => {
    const { ctx, agent } = await createHarness()
    ctx.goals.create(agent, { objective: 'await authorization' })
    const result = await ctx.commands.execute(
      agent,
      '/autopilot status',
      new AbortController().signal,
    )
    expect(result?.result.text).toContain('Autopilot: disarmed (no process-local lease')
    await ctx.fiber.dispose()
  })

  it('rejects deployment ceilings and duplicate active Goals without leaving an armed replacement', async () => {
    const { ctx, agent } = await createHarness({
      autonomy: { maxGoalRounds: 10, defaultMaxGoalRounds: 5, maxActiveMs: 10_000, defaultMaxActiveMs: 1000 },
    })
    const signal = new AbortController().signal
    expect((await ctx.commands.execute(
      agent,
      '/autopilot start --rounds 11 objective',
      signal,
    ))?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('AUTONOMY_INVALID_ROUNDS') })
    expect((await ctx.commands.execute(
      agent,
      '/autopilot start --duration 11s objective',
      signal,
    ))?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('AUTONOMY_INVALID_DURATION') })
    expect((await ctx.commands.execute(agent, '/autopilot start first', signal))?.result.kind).toBe('success')
    expect((await ctx.commands.execute(agent, '/autopilot start second', signal))?.result)
      .toMatchObject({ kind: 'error', text: expect.stringContaining('GOAL_ALREADY_EXISTS') })
    await ctx.fiber.dispose()
  })

  it('rolls back a Goal when lease authorization fails', async () => {
    const { ctx, agent } = await createHarness()
    vi.spyOn(ctx.autonomy, 'start').mockImplementation(() => {
      throw new AutonomyError('authorization failed', 'AUTONOMY_INVALID_TRANSITION')
    })
    const result = await ctx.commands.execute(
      agent,
      '/autopilot start rollback objective',
      new AbortController().signal,
    )
    expect(result?.result).toMatchObject({
      kind: 'error', text: expect.stringContaining('AUTONOMY_INVALID_TRANSITION'),
    })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('pauses a resumed lease when durable Goal resume fails', async () => {
    const { ctx, agent } = await createHarness()
    const goal = ctx.goals.create(agent, { objective: 'resume atomically' })
    ctx.goals.pause(agent, goal)
    const resume = vi.spyOn(ctx.goals, 'resume').mockImplementation(() => {
      throw new AutonomyError('goal resume failed', 'AUTONOMY_INVALID_TRANSITION')
    })
    const result = await ctx.commands.execute(
      agent,
      '/autopilot resume --duration 1h',
      new AbortController().signal,
    )
    expect(resume).toHaveBeenCalledOnce()
    expect(result?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('goal resume failed') })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', reason: 'Goal resume failed' })
    await ctx.fiber.dispose()
  })

  it('handles idempotent pause and stop states without inventing a lease', async () => {
    const signal = new AbortController().signal
    const noLease = await createHarness()
    noLease.ctx.goals.create(noLease.agent, { objective: 'manual only' })
    const paused = await noLease.ctx.commands.execute(noLease.agent, '/autopilot pause', signal)
    expect(paused?.result.text).toContain('Autopilot: disarmed')
    const stopped = await noLease.ctx.commands.execute(noLease.agent, '/autopilot stop', signal)
    expect(stopped?.result.text).toContain('Autopilot: disarmed')
    await noLease.ctx.fiber.dispose()

    const terminal = await createHarness()
    const goal = terminal.ctx.goals.create(terminal.agent, { objective: 'already verified' })
    terminal.ctx.autonomy.start(terminal.agent, { goalId: goal.id })
    terminal.ctx.autonomy.beginVerification(terminal.agent)
    terminal.ctx.autonomy.complete(terminal.agent)
    const terminalStop = await terminal.ctx.commands.execute(terminal.agent, '/autopilot stop', signal)
    expect(terminalStop?.result.text).toContain('Autopilot: completed')
    await terminal.ctx.fiber.dispose()
  })

  it('pauses a lease while independent verification is active', async () => {
    const { ctx, agent } = await createHarness()
    const goal = ctx.goals.create(agent, { objective: 'interrupt verification' })
    ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.autonomy.beginVerification(agent)
    const result = await ctx.commands.execute(
      agent,
      '/autopilot pause',
      new AbortController().signal,
    )
    expect(result?.result.text).toContain('Autopilot: paused')
    await ctx.fiber.dispose()
  })

  it('preserves unexpected command failures for the host runtime', async () => {
    const { ctx, agent } = await createHarness()
    vi.spyOn(ctx.autonomy, 'resolveDuration').mockImplementation(() => {
      throw new Error('unexpected host failure')
    })
    await expect(ctx.commands.execute(
      agent,
      '/autopilot start preserve failure',
      new AbortController().signal,
    )).rejects.toThrow('unexpected host failure')
    await ctx.fiber.dispose()
  })
})
