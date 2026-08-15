import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AutonomyError } from '../../src/service.ts'
import { parseAutopilotCommand, parseDuration, parseMissionCommand } from '../../src/commands.ts'
import { createHarness, createTestAgent, prepareTestPlan } from '../helpers.ts'

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
    expect(parseAutopilotCommand('audit')).toEqual({ kind: 'audit', limit: 20, format: 'text' })
    expect(parseAutopilotCommand('dashboard')).toEqual({ kind: 'dashboard' })
    expect(parseAutopilotCommand('audit --json --limit=7')).toEqual({
      kind: 'audit', limit: 7, format: 'json',
    })
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
    ['audit --limit 0', '--limit requires'],
    ['audit --limit', '--limit requires'],
    ['audit --limit 201', '--limit requires'],
    ['audit --limit 999999999999999999999', '--limit requires'],
    ['audit --limit 3 --limit 4', '--limit may be supplied'],
    ['audit --json --json', '--json may be supplied'],
    ['audit trailing', 'Invalid audit option'],
    ['dance', 'Unknown autopilot operation'],
  ])('returns an actionable error for %j', (input, message) => {
    expect(parseAutopilotCommand(input)).toMatchObject({ kind: 'invalid', message: expect.stringContaining(message) })
  })
})

describe('mission command parsing', () => {
  it('parses quoted plans and every operator lifecycle action', () => {
    expect(parseMissionCommand('plan --continue-on-error "ops/release queue.md"')).toEqual({
      kind: 'plan', path: 'ops/release queue.md', continueOnError: true,
    })
    expect(parseMissionCommand('plan ops/release\\ queue.md')).toEqual({
      kind: 'plan', path: 'ops/release queue.md', continueOnError: false,
    })
    expect(parseMissionCommand("plan 'ops/release\\queue.md'")).toEqual({
      kind: 'plan', path: 'ops/release\\queue.md', continueOnError: false,
    })
    expect(parseMissionCommand('')).toEqual({ kind: 'status' })
    expect(parseMissionCommand('status   release-123')).toEqual({ kind: 'status', missionId: 'release-123' })
    expect(parseMissionCommand('status release-123')).toEqual({ kind: 'status', missionId: 'release-123' })
    expect(parseMissionCommand('resume release-123')).toEqual({ kind: 'resume', missionId: 'release-123' })
    expect(parseMissionCommand('rerun release-123 --task task-002')).toEqual({
      kind: 'rerun', missionId: 'release-123', taskId: 'task-002',
    })
    expect(parseMissionCommand("mark release-123 --task task-002 --status blocked --reason 'owner approval'"))
      .toEqual({
        kind: 'mark', missionId: 'release-123', taskId: 'task-002', status: 'blocked', reason: 'owner approval',
      })
    expect(parseMissionCommand('audit')).toEqual({ kind: 'audit', limit: 20 })
    expect(parseMissionCommand('audit --limit 8')).toEqual({ kind: 'audit', limit: 8 })
  })

  it.each([
    ['plan', 'exactly one'],
    ['status a b', 'at most one'],
    ['resume', 'exactly one'],
    ['rerun x', 'requires one mission'],
    ['mark x --task task-1', 'requires a mission'],
    ['audit --limit 0', 'integer from 1'],
    ['audit extra', 'integer from 1'],
    ['plan "unterminated', 'unclosed quote'],
    ['dance', 'Unknown mission'],
  ])('rejects invalid mission command %j', (input, message) => {
    expect(parseMissionCommand(input)).toMatchObject({ kind: 'invalid', message: expect.stringContaining(message) })
  })
})

describe('/autopilot lifecycle', () => {
  it('registers the direct-human mission operator and renders model-safe results', async () => {
    const harness = await createHarness()
    expect(harness.ctx.commands.list(harness.agent).map(command => command.name)).toContain('mission')
    const status = await harness.ctx.commands.execute(
      harness.agent,
      '/mission status',
      new AbortController().signal,
    )
    expect(status?.result).toEqual({ kind: 'success', text: '[]' })
    const invalid = await harness.ctx.commands.execute(
      harness.agent,
      '/mission rerun missing',
      new AbortController().signal,
    )
    expect(invalid?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('/mission rerun <mission-id> --task <task-id>'),
    })
    const missing = await harness.ctx.commands.execute(
      harness.agent,
      '/mission resume missing-12345678',
      new AbortController().signal,
    )
    expect(missing?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('requires') })
  })

  it('projects every parsed mission command into the model-safe tool call', async () => {
    const harness = await createHarness()
    const execute = vi.spyOn(harness.ctx.tools, 'execute').mockResolvedValue({
      isError: false,
      value: { accepted: true },
      content: [],
    } as never)
    for (const input of [
      '/mission plan --continue-on-error "ops/release queue.md"',
      '/mission status queue-12345678',
      '/mission resume queue-12345678',
      '/mission mark queue-12345678 --task task-001 --status blocked --reason hold',
      '/mission rerun queue-12345678 --task task-001',
      '/mission audit --limit 7',
    ]) {
      await expect(harness.ctx.commands.execute(
        harness.agent, input, new AbortController().signal,
      )).resolves.toMatchObject({ result: { kind: 'success' } })
    }
    expect(execute.mock.calls.map(call => call[0].arguments)).toEqual([
      { action: 'plan', path: 'ops/release queue.md', continueOnError: true },
      { action: 'status', missionId: 'queue-12345678' },
      { action: 'resume', missionId: 'queue-12345678' },
      { action: 'mark', missionId: 'queue-12345678', taskId: 'task-001', status: 'blocked', reason: 'hold' },
      { action: 'rerun', missionId: 'queue-12345678', taskId: 'task-001' },
      { action: 'audit', limit: 7 },
    ])
  })

  it('fails loud before start or resume when the additive bundle is incomplete', async () => {
    const incomplete = await createHarness({ missingRecoveryContribution: 'visual-qa' })
    const start = await incomplete.ctx.commands.execute(
      incomplete.agent,
      '/autopilot start must not degrade to a bare Goal',
      new AbortController().signal,
    )
    expect(start?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('missing contributions: visual-qa'),
    })
    expect(incomplete.ctx.goals.get(incomplete.agent)).toBeUndefined()
    expect(incomplete.ctx.autonomy.get(incomplete.agent)).toBeUndefined()
    await incomplete.ctx.fiber.dispose()

    const ready = await createHarness()
    const signal = new AbortController().signal
    await ready.ctx.commands.execute(ready.agent, '/autopilot start resumable work', signal)
    await ready.ctx.commands.execute(ready.agent, '/autopilot pause', signal)
    ready.recoveryContributionDisposers.get('visual-qa')?.()
    const resume = await ready.ctx.commands.execute(ready.agent, '/autopilot resume', signal)
    expect(resume?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('missing contributions: visual-qa'),
    })
    expect(ready.ctx.goals.get(ready.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(ready.ctx.autonomy.get(ready.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    await ready.ctx.fiber.dispose()
  })

  it('fails a start closed when gapless HMR changes readiness after sidecar commit', async () => {
    const harness = await createHarness()
    const originalStart = harness.ctx.autonomy.start.bind(harness.ctx.autonomy)
    const originalContribution = harness.recoveryContributionDisposers.get('visual-qa')
    if (originalContribution === undefined) throw new Error('fixture contribution is missing')
    let replacement: (() => void) | undefined
    vi.spyOn(harness.ctx.autonomy, 'start').mockImplementation(async (...args) => {
      const view = await originalStart(...args)
      replacement = harness.ctx.autopilotRecoveryReadiness.register('visual-qa')
      originalContribution()
      return view
    })

    const result = await harness.ctx.commands.execute(
      harness.agent,
      '/autopilot start reject readiness ABA',
      new AbortController().signal,
    )

    expect(result?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('changed during lifecycle activation'),
    })
    expect(harness.ctx.autopilotRecoveryReadiness.missing()).toEqual([])
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ activation: 'disarmed' })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      phase: 'needs-attention',
      reason: expect.stringContaining('Autopilot Goal activation failed'),
    })
    replacement?.()
    await harness.ctx.fiber.dispose()
  })

  it('disarms both halves when the final contribution unloads during Goal resume', async () => {
    const harness = await createHarness()
    const signal = new AbortController().signal
    await harness.ctx.commands.execute(harness.agent, '/autopilot start resumable readiness race', signal)
    await harness.ctx.commands.execute(harness.agent, '/autopilot pause', signal)
    const originalResume = harness.ctx.goals.resume.bind(harness.ctx.goals)
    const contribution = harness.recoveryContributionDisposers.get('visual-qa')
    if (contribution === undefined) throw new Error('fixture contribution is missing')
    vi.spyOn(harness.ctx.goals, 'resume').mockImplementation((...args) => {
      const view = originalResume(...args)
      contribution()
      return view
    })

    const result = await harness.ctx.commands.execute(harness.agent, '/autopilot resume', signal)

    expect(result?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('missing contributions: visual-qa'),
    })
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ activation: 'disarmed' })
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
      })
    })
    expect(harness.agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot bundle readiness lost' },
      { keepInbox: true },
    )
    await harness.ctx.fiber.dispose()
  })

  it('disarms a rearmed Goal when gapless HMR changes the post-resume epoch', async () => {
    const harness = await createHarness()
    const signal = new AbortController().signal
    await harness.ctx.commands.execute(harness.agent, '/autopilot start resume across HMR', signal)
    await harness.ctx.commands.execute(harness.agent, '/autopilot pause', signal)
    const originalGoalResume = harness.ctx.goals.resume.bind(harness.ctx.goals)
    const originalContribution = harness.recoveryContributionDisposers.get('visual-qa')
    if (originalContribution === undefined) throw new Error('fixture contribution is missing')
    let replacement: (() => void) | undefined
    vi.spyOn(harness.ctx.goals, 'resume').mockImplementation((...args) => {
      const view = originalGoalResume(...args)
      replacement = harness.ctx.autopilotRecoveryReadiness.register('visual-qa')
      originalContribution()
      return view
    })
    const originalAttention = harness.ctx.autonomy.markNeedsAttention.bind(harness.ctx.autonomy)
    vi.spyOn(harness.ctx.autonomy, 'markNeedsAttention').mockImplementation(async (...args) => {
      await originalAttention(...args)
      throw new Error('post-commit attention observer failed')
    })

    const result = await harness.ctx.commands.execute(harness.agent, '/autopilot resume', signal)

    expect(result?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('changed during lifecycle activation'),
    })
    expect(harness.ctx.autopilotRecoveryReadiness.missing()).toEqual([])
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ activation: 'disarmed' })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      phase: 'needs-attention', activation: 'disarmed',
    })
    replacement?.()
    await harness.ctx.fiber.dispose()
  })

  it('checkpoints human intent before side effects and stops on a missing checkpoint', async () => {
    const harness = await createHarness()
    const order: string[] = []
    vi.spyOn(harness.ctx.sessions, 'flush').mockImplementation(async () => {
      order.push('flush')
      return true
    })
    vi.spyOn(harness.ctx.subagents, 'listDescendants').mockImplementation(async () => {
      order.push('descendants')
      return []
    })
    await harness.ctx.commands.execute(
      harness.agent,
      '/autopilot start checkpoint intent',
      new AbortController().signal,
    )
    expect(order).toEqual(['flush', 'descendants'])
    await harness.ctx.fiber.dispose()

    const missing = await createHarness()
    vi.spyOn(missing.ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(missing.ctx.commands.execute(
      missing.agent,
      '/autopilot start must stay inert',
      new AbortController().signal,
    )).rejects.toThrow(/require configured session persistence/)
    expect(missing.ctx.goals.get(missing.agent)).toBeUndefined()
    expect(missing.ctx.autonomy.get(missing.agent)).toBeUndefined()
    await missing.ctx.fiber.dispose()

    const canceled = await createHarness()
    const controller = new AbortController()
    vi.spyOn(canceled.ctx.sessions, 'flush').mockImplementation(async () => {
      controller.abort(new Error('operator canceled'))
      return true
    })
    const descendants = vi.spyOn(canceled.ctx.subagents, 'listDescendants')
    const definition = canceled.ctx.commands.find(canceled.agent, 'autopilot')
    await expect(definition?.handler({
      agent: canceled.agent,
      rawInput: 'start canceled after checkpoint',
      signal: controller.signal,
      commandId: 'cancel-after-checkpoint' as never,
    })).rejects.toThrow(/operator canceled/)
    expect(descendants).not.toHaveBeenCalled()
    expect(canceled.ctx.goals.get(canceled.agent)).toBeUndefined()
    await canceled.ctx.fiber.dispose()
  })

  it('does not start while descendant activity is running or unknowable', async () => {
    const running = await createHarness()
    vi.spyOn(running.ctx.subagents, 'listDescendants').mockResolvedValue([{
      kind: 'child',
      id: SessionId('running-child'),
      parentId: running.agent.id,
      depth: 1,
      activity: 'running',
      hasChildren: false,
      mode: 'one-shot',
    }])
    const blocked = await running.ctx.commands.execute(
      running.agent,
      '/autopilot start avoid overlapping authority',
      new AbortController().signal,
    )
    expect(blocked?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('still running') })
    expect(running.ctx.goals.get(running.agent)).toBeUndefined()
    await running.ctx.fiber.dispose()

    const unknown = await createHarness()
    vi.spyOn(unknown.ctx.subagents, 'listDescendants').mockResolvedValue([{
      kind: 'diagnostic',
      id: SessionId('unavailable-child'),
      parentId: unknown.agent.id,
      depth: 1,
      reason: 'unavailable',
    }])
    await expect(unknown.ctx.commands.execute(
      unknown.agent,
      '/autopilot start require complete descendant visibility',
      new AbortController().signal,
    )).rejects.toThrow(/cannot inspect existing subagents: unavailable/)
    expect(unknown.ctx.goals.get(unknown.agent)).toBeUndefined()
    await unknown.ctx.fiber.dispose()
  })

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
    const pausedAgain = await ctx.commands.execute(agent, '/autopilot pause', signal)
    expect(pausedAgain?.result.text).toContain('Autopilot: paused')

    const resumed = await ctx.commands.execute(agent, '/autopilot resume', signal)
    expect(resumed?.result.text).toContain('Goal: active (armed)')
    expect(ctx.autonomy.get(agent)?.phase).toBe('running')

    const stopped = await ctx.commands.execute(agent, '/autopilot stop', signal)
    expect(stopped?.result.text).toContain('Autopilot: revoked')
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect(agent.cancel).toHaveBeenLastCalledWith({ kind: 'user' })
    expect(agent.session.events.filter(event => event.type === 'command/run')).toHaveLength(5)
    const stoppedAgain = await ctx.commands.execute(agent, '/autopilot stop', signal)
    expect(stoppedAgain?.result).toMatchObject({
      kind: 'success', text: expect.stringContaining('Goal: absent'),
    })
    const restarted = await ctx.commands.execute(agent, '/autopilot start start a fresh run', signal)
    expect(restarted?.result).toMatchObject({ kind: 'success' })
    expect(ctx.goals.get(agent)).toMatchObject({ objective: 'start a fresh run', phase: 'active' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ generation: 2 })
    await ctx.fiber.dispose()
  })

  it('requires a top-level Agent and reports missing or invalid state', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    expect((await ctx.commands.execute(agent, '/autopilot status', signal))?.result)
      .toEqual({ kind: 'success', text: 'No current Goal or Autopilot lease.' })
    expect((await ctx.commands.execute(agent, '/autopilot pause', signal))?.result)
      .toMatchObject({ kind: 'error', text: expect.stringContaining('No Autopilot run') })
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

  it('rejects a missing or replaced Goal without mutating the replacement', async () => {
    const signal = new AbortController().signal
    const missing = await createHarness()
    await missing.ctx.commands.execute(missing.agent, '/autopilot start lose Goal', signal)
    const missingGoal = missing.ctx.goals.get(missing.agent)
    if (missingGoal === undefined) throw new Error('fixture Goal is missing')
    missing.ctx.goals.disarm(missing.agent)
    missing.ctx.goals.clear(missing.agent, missingGoal)
    expect((await missing.ctx.commands.execute(missing.agent, '/autopilot pause', signal))?.result)
      .toMatchObject({ kind: 'error', text: expect.stringContaining('Goal is unavailable') })
    await missing.ctx.fiber.dispose()

    const replaced = await createHarness()
    await replaced.ctx.commands.execute(replaced.agent, '/autopilot start replace Goal', signal)
    const owned = replaced.ctx.goals.get(replaced.agent)
    if (owned === undefined) throw new Error('fixture Goal is missing')
    replaced.ctx.goals.disarm(replaced.agent)
    replaced.ctx.goals.clear(replaced.agent, owned)
    replaced.ctx.goals.create(replaced.agent, { objective: 'ordinary replacement' })
    expect((await replaced.ctx.commands.execute(replaced.agent, '/autopilot stop', signal))?.result)
      .toMatchObject({ kind: 'error', text: expect.stringContaining('does not belong') })
    expect(replaced.ctx.goals.get(replaced.agent)).toMatchObject({
      objective: 'ordinary replacement', phase: 'active', activation: 'armed',
    })
    await replaced.ctx.fiber.dispose()
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

  it('exports a bounded human or JSON audit tail', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal

    const empty = await ctx.commands.execute(agent, '/autopilot audit', signal)
    expect(empty?.result).toEqual({ kind: 'success', text: 'No Autopilot audit records.' })
    await ctx.commands.execute(agent, '/autopilot start audit this run', signal)
    await ctx.commands.execute(agent, '/autopilot pause', signal)

    const textResult = await ctx.commands.execute(agent, '/autopilot audit --limit 1', signal)
    expect(textResult?.result).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(/rev=2 operation=pause phase=paused run=run-/u),
    })

    const jsonResult = await ctx.commands.execute(agent, '/autopilot audit --json', signal)
    expect(JSON.parse(jsonResult?.result.text ?? '[]')).toMatchObject([
      { operation: 'start', snapshot: { revision: 1, phase: 'running' } },
      { operation: 'pause', snapshot: { revision: 2, phase: 'paused' } },
    ])
    await ctx.fiber.dispose()
  })

  it('renders a read-only durable dashboard for the current session', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start dashboard this run', signal)

    const result = await ctx.commands.execute(agent, '/autopilot dashboard', signal)

    expect(result?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('DSH Autopilot Dashboard'),
    })
    expect(result?.result.text).toContain(String(agent.id))
    expect(result?.result.text).not.toContain('dashboard this run')
    await ctx.fiber.dispose()
  })

  it('reports blocked task counts in status', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start report blocked work', signal)
    await prepareTestPlan(ctx, agent, ['surface blockers'], [{
      id: 'blocked-work',
      title: 'Blocked work',
      description: 'Exercise status rendering.',
      acceptanceCriteria: ['blocker is visible'],
    }])
    await ctx.autonomy.updateTask(agent, 'blocked-work', 'start')
    await ctx.autonomy.updateTask(agent, 'blocked-work', 'fail', { reason: 'dependency unavailable' })
    const status = await ctx.commands.execute(agent, '/autopilot status', signal)
    expect(status?.result.text).toContain('1 blocked/failed')
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
    expect(ctx.goals.get(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('accepts an authorization failure that already removed its uncommitted Goal', async () => {
    const { ctx, agent } = await createHarness()
    vi.spyOn(ctx.autonomy, 'start').mockImplementation(async () => {
      const goal = ctx.goals.get(agent)
      if (goal !== undefined) ctx.goals.clear(agent, { id: goal.id, revision: goal.revision })
      throw new AutonomyError('authorization failed after Goal cleanup', 'AUTONOMY_INVALID_TRANSITION')
    })
    const result = await ctx.commands.execute(
      agent,
      '/autopilot start already rolled back',
      new AbortController().signal,
    )
    expect(result?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('authorization failed') })
    expect(ctx.goals.get(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails closed when authorization commits but start activation cannot finish', async () => {
    const { ctx, agent } = await createHarness()
    const originalStart = ctx.autonomy.start.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'start').mockImplementation(async (...args) => {
      await originalStart(...args)
      throw new AutonomyError('observer failed after authorization', 'AUTONOMY_INVALID_TRANSITION')
    })

    const result = await ctx.commands.execute(
      agent,
      '/autopilot start committed authorization',
      new AbortController().signal,
    )

    expect(result?.result).toMatchObject({
      kind: 'error', text: expect.stringContaining('observer failed after authorization'),
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention', reason: expect.stringContaining('Autopilot start did not finish'),
    })
    await ctx.fiber.dispose()
  })

  it('aggregates a failed start with a failed fail-closed marker', async () => {
    const { ctx, agent } = await createHarness()
    const originalStart = ctx.autonomy.start.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'start').mockImplementation(async (...args) => {
      await originalStart(...args)
      throw new Error('activation observer failed')
    })
    vi.spyOn(ctx.autonomy, 'markNeedsAttention').mockRejectedValueOnce(new Error('marker unavailable'))

    await expect(ctx.commands.execute(
      agent,
      '/autopilot start aggregate start failure',
      new AbortController().signal,
    )).rejects.toThrow('Autopilot start did not finish')
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('fails closed when the new Goal disappears before activation', async () => {
    const { ctx, agent } = await createHarness()
    const originalStart = ctx.autonomy.start.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'start').mockImplementation(async (...args) => {
      const view = await originalStart(...args)
      const goal = ctx.goals.get(agent)
      if (goal !== undefined) ctx.goals.clear(agent, { id: goal.id, revision: goal.revision })
      return view
    })

    const execution = ctx.commands.execute(
      agent,
      '/autopilot start disappearing goal',
      new AbortController().signal,
    )

    await expect(execution).rejects.toThrow('Goal disappeared before Autopilot activation')
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention' })
    await ctx.fiber.dispose()
  })

  it('surfaces a failed Goal rollback when authorization itself fails', async () => {
    const { ctx, agent } = await createHarness()
    vi.spyOn(ctx.autonomy, 'start').mockRejectedValueOnce(
      new AutonomyError('authorization unavailable', 'AUTONOMY_INVALID_TRANSITION'),
    )
    vi.spyOn(ctx.goals, 'clear').mockImplementation(() => {
      throw new Error('Goal rollback unavailable')
    })

    await expect(ctx.commands.execute(
      agent,
      '/autopilot start rollback failure',
      new AbortController().signal,
    )).rejects.toThrow('Autopilot start and Goal rollback both failed')
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('pauses a resumed lease when durable Goal resume fails', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start resume atomically', signal)
    await ctx.commands.execute(agent, '/autopilot pause', signal)
    const resume = vi.spyOn(ctx.goals, 'resume').mockImplementation(() => {
      throw new AutonomyError('goal resume failed', 'AUTONOMY_INVALID_TRANSITION')
    })
    const result = await ctx.commands.execute(
      agent,
      '/autopilot resume --duration 1h',
      signal,
    )
    expect(resume).toHaveBeenCalledOnce()
    expect(result?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('goal resume failed') })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      reason: expect.stringContaining('Autopilot Goal resume failed'),
    })
    await ctx.fiber.dispose()
  })

  it('fails closed when the Goal disappears after durable resume', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start resume disappearing goal', signal)
    await ctx.commands.execute(agent, '/autopilot pause', signal)
    const originalResume = ctx.autonomy.resume.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'resume').mockImplementation(async (...args) => {
      const view = await originalResume(...args)
      const goal = ctx.goals.get(agent)
      if (goal !== undefined) ctx.goals.clear(agent, { id: goal.id, revision: goal.revision })
      return view
    })

    await expect(ctx.commands.execute(
      agent,
      '/autopilot resume',
      signal,
    )).rejects.toThrow('Goal disappeared before Autopilot resume')
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention' })
    await ctx.fiber.dispose()
  })

  it('keeps a failed resume disarmed when the sidecar view becomes unavailable', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start hide resume state', signal)
    await ctx.commands.execute(agent, '/autopilot pause', signal)
    const originalGet = ctx.autonomy.get.bind(ctx.autonomy)
    let hidden = false
    vi.spyOn(ctx.autonomy, 'get').mockImplementation(subject => hidden ? undefined : originalGet(subject))
    vi.spyOn(ctx.goals, 'resume').mockImplementation(() => {
      hidden = true
      throw new AutonomyError('goal resume unavailable', 'AUTONOMY_INVALID_TRANSITION')
    })
    const result = await ctx.commands.execute(agent, '/autopilot resume', signal)
    expect(result?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('goal resume unavailable') })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('fails closed when durable Goal pause fails after the sidecar is paused', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start pause atomically', signal)
    vi.spyOn(ctx.goals, 'pause').mockImplementation(() => {
      throw new AutonomyError('goal pause failed', 'AUTONOMY_INVALID_TRANSITION')
    })

    const result = await ctx.commands.execute(agent, '/autopilot pause', signal)

    expect(result?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('goal pause failed') })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention', reason: expect.stringContaining('Autopilot Goal pause failed'),
    })
    await ctx.fiber.dispose()
  })

  it('clears the exact Goal after durable stop', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start stop cleanup', signal)
    const result = await ctx.commands.execute(agent, '/autopilot stop', signal)

    expect(result?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('Autopilot: revoked') })
    expect(ctx.goals.get(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('surfaces a failure to clear the stopped Goal', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start stop failure', signal)
    vi.spyOn(ctx.goals, 'clear').mockImplementation(() => {
      throw new Error('goal clear unavailable')
    })

    await expect(ctx.commands.execute(agent, '/autopilot stop', signal))
      .rejects.toThrow('Autopilot stopped but Goal cleanup failed')
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'revoked' })
    await ctx.fiber.dispose()
  })

  it('uses the captured Goal ref when clear reports a concurrent removal', async () => {
    const { ctx, agent } = await createHarness()
    const signal = new AbortController().signal
    await ctx.commands.execute(agent, '/autopilot start concurrent stop cleanup', signal)
    const clear = ctx.goals.clear.bind(ctx.goals)
    vi.spyOn(ctx.goals, 'clear').mockImplementation((subject, ref) => {
      clear(subject, ref)
      throw new Error('goal vanished during clear')
    })
    await expect(ctx.commands.execute(agent, '/autopilot stop', signal))
      .rejects.toThrow('Autopilot stopped but Goal cleanup failed')
    expect(ctx.goals.get(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('does not mutate an ordinary Goal without an exact Autopilot lease', async () => {
    const signal = new AbortController().signal
    const noLease = await createHarness()
    noLease.ctx.goals.create(noLease.agent, { objective: 'manual only' })
    const paused = await noLease.ctx.commands.execute(noLease.agent, '/autopilot pause', signal)
    expect(paused?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('No Autopilot run') })
    const stopped = await noLease.ctx.commands.execute(noLease.agent, '/autopilot stop', signal)
    expect(stopped?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('No Autopilot run') })
    expect(noLease.ctx.goals.get(noLease.agent)).toMatchObject({ objective: 'manual only', phase: 'active' })
    await noLease.ctx.fiber.dispose()

    const terminal = await createHarness()
    const goal = terminal.ctx.goals.create(terminal.agent, { objective: 'already verified' })
    await terminal.ctx.autonomy.start(terminal.agent, { goalId: goal.id })
    await prepareTestPlan(terminal.ctx, terminal.agent, ['proof exists'], [{
      id: 'proof',
      title: 'Create proof',
      description: 'Create durable completion proof.',
      acceptanceCriteria: ['proof exists'],
    }])
    await terminal.ctx.autonomy.updateTask(terminal.agent, 'proof', 'start')
    await terminal.ctx.autonomy.updateTask(terminal.agent, 'proof', 'complete', {
      evidence: [{ kind: 'test', ref: 'commands.spec.ts', summary: 'command proof passed' }],
    })
    await terminal.ctx.autonomy.beginVerification(terminal.agent, {
      summary: 'verified terminal command state',
      evidence: ['commands.spec.ts'],
    })
    await terminal.ctx.autonomy.beginFinalization(terminal.agent, {
      attempt: 1,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      verdict: 'pass',
      summary: 'terminal command state passed',
      findings: [],
      checks: [],
      reviewers: [],
    })
    const terminalResume = await terminal.ctx.commands.execute(terminal.agent, '/autopilot resume', signal)
    expect(terminalResume?.result.text).toContain('Autopilot: completed')
    const terminalStop = await terminal.ctx.commands.execute(terminal.agent, '/autopilot stop', signal)
    expect(terminalStop?.result.text).toContain('Autopilot: completed')
    await terminal.ctx.fiber.dispose()
  })

  it('pauses a lease while independent verification is active', async () => {
    const { ctx, agent } = await createHarness()
    const goal = ctx.goals.create(agent, { objective: 'interrupt verification' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await prepareTestPlan(ctx, agent, ['proof exists'], [{
      id: 'proof',
      title: 'Create proof',
      description: 'Create durable completion proof.',
      acceptanceCriteria: ['proof exists'],
    }])
    await ctx.autonomy.updateTask(agent, 'proof', 'start')
    await ctx.autonomy.updateTask(agent, 'proof', 'complete', {
      evidence: [{ kind: 'test', ref: 'commands.spec.ts', summary: 'command proof passed' }],
    })
    await ctx.autonomy.beginVerification(agent, {
      summary: 'verification is active',
      evidence: ['commands.spec.ts'],
    })
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
