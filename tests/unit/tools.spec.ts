import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { AutonomyError } from '../../src/service.ts'
import { apply as applyTools } from '../../src/tools.ts'
import { createHarness, createTestAgent, shellResult } from '../helpers.ts'

let callSequence = 0

/** Execute a model tool with a unique call identity. */
function executeTool(ctx: Context, agent: Agent, name: string, args: unknown = {}) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`dsh-autopilot-call-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

/** Register a JSON-valued stand-in for a DSH tool outside this package. */
function registerTool(
  ctx: Context,
  name: string,
  execute: (args: Record<string, JsonValue>) => JsonValue | Promise<JsonValue> = args => args,
): void {
  ctx.tools.register(defineTool({
    name,
    description: `test ${name}`,
    parameters: {
      action: { type: 'string' },
      pluginId: { type: 'string' },
      packageId: { type: 'string' },
      code: { type: 'json' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return execute(args)
    },
  }))
}

/** Create and authorize a Goal without going through the command UI. */
function startGoal(ctx: Context, agent: Agent): void {
  const goal = ctx.goals.create(agent, { objective: 'ship verified work', maxGoalRounds: 5 })
  ctx.autonomy.start(agent, { goalId: goal.id })
}

describe('model-facing autonomy context', () => {
  it('exposes status and logs only active policy text into prompt assembly', async () => {
    const { ctx, agent } = await createHarness()
    const subjectless = await ctx.systemPrompt.assemble()
    expect(subjectless.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text).toBe('')
    const before = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(before.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text).toBe('')
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false, value: { goal: null, lease: null },
    })
    expect(ctx.tools.executionMode({
      callId: CallId('status-mode'),
      name: 'get_autopilot',
      arguments: {},
      agent,
      signal: new AbortController().signal,
    })).toEqual({ kind: 'parallel' })

    startGoal(ctx, agent)
    const active = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(active.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text)
      .toContain('Dynamic Cordis policy: host-only')
    const status = await executeTool(ctx, agent, 'get_autopilot')
    expect(status).toMatchObject({
      isError: false,
      value: {
        goal: { objective: 'ship verified work', phase: 'active' },
        lease: { phase: 'running', selfModification: 'host-only' },
      },
    })

    ctx.goals.pause(agent, ctx.goals.get(agent)!)
    ctx.autonomy.pause(agent, 'waiting for a human')
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { lease: { phase: 'paused', reason: 'waiting for a human' } },
    })
    const paused = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(paused.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text).toBe('')
    await ctx.fiber.dispose()
  })

  it('requires an Agent-backed execution for status', async () => {
    const { ctx } = await createHarness()
    const result = await ctx.tools.execute({
      callId: CallId('status-without-agent'),
      name: 'get_autopilot',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ isError: true, error: { message: expect.stringContaining('Agent-backed') } })
    await ctx.fiber.dispose()
  })
})

describe('independent completion verifier', () => {
  it('completes the Goal only after every fixed check passes', async () => {
    const { ctx, agent, shell } = await createHarness({
      tools: {
        checks: [
          { name: 'tests', command: 'pnpm test', timeoutMs: 10_000 },
          { name: 'types', command: 'pnpm typecheck', timeoutMs: 20_000 },
        ],
      },
    })
    startGoal(ctx, agent)
    shell.outcomes.push(
      shellResult({ stdout: { text: 'tests passed', truncated: false } }),
      shellResult({ stdout: { text: 'types passed', truncated: false } }),
    )
    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'Everything is implemented.',
      evidence: ['test output', 'typecheck output'],
    })
    expect(result).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: { verdict: 'pass', checks: [{ passed: true }, { passed: true }], goal: { phase: 'complete' } },
    })
    expect(shell.requests.map(request => request.command)).toEqual(['pnpm test', 'pnpm typecheck'])
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'complete', activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)?.phase).toBe('completed')
    await ctx.fiber.dispose()
  })

  it('returns bounded findings, rearms the Goal, and concludes the failed turn', async () => {
    const { ctx, agent, shell } = await createHarness({
      tools: { maxOutputChars: 4, checks: [{ name: 'tests', command: 'test command' }] },
    })
    startGoal(ctx, agent)
    shell.outcomes.push(shellResult({
      exitCode: 1,
      stdout: { text: '12345678', truncated: false },
      stderr: { text: 'abcdefgh', truncated: true },
      sandbox: { mode: 'workspace-write', denied: true, enforcement: 'full', runnerFailed: true },
    }))
    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['artifact'],
    })
    expect(result).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: {
        verdict: 'fail',
        checks: [{
          name: 'tests',
          passed: false,
          stdout: { text: '5678', truncated: true },
          stderr: { text: 'efgh', truncated: true },
          sandbox: { mode: 'workspace-write', denied: true, enforcement: 'full', runnerFailed: true },
        }],
      },
    })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed', revision: 2 })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', reason: 'Verifier failed: tests' })
    await ctx.fiber.dispose()
  })

  it('passes the Agent workspace to checks and omits absent sandbox details', async () => {
    const { ctx, shell } = await createHarness()
    const agent = createTestAgent('workspace-agent', '/workspace/project')
    ctx.agents.register(agent)
    startGoal(ctx, agent)
    shell.outcomes.push(shellResult({
      sandbox: { mode: 'workspace-write', denied: false },
    }))
    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'workspace verified', evidence: ['quality output'],
    })
    expect(shell.requests[0]?.workdir).toBe('/workspace/project')
    expect(result).toMatchObject({
      isError: false,
      value: { checks: [{ sandbox: { mode: 'workspace-write', denied: false } }] },
    })
    await ctx.fiber.dispose()
  })

  it('does not rearm a Goal that changed while a failing check ran', async () => {
    const { ctx, agent, shell } = await createHarness()
    startGoal(ctx, agent)
    vi.spyOn(shell, 'run').mockImplementation(async () => {
      const current = ctx.goals.get(agent)
      ctx.goals.pause(agent, current!)
      return shellResult({ exitCode: 1 })
    })
    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['failed quality output'],
    })
    expect(result).toMatchObject({ isError: false, value: { verdict: 'fail' } })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('rejects a Goal that changes before passing verification settles', async () => {
    const { ctx, agent, shell } = await createHarness()
    startGoal(ctx, agent)
    vi.spyOn(shell, 'run').mockImplementation(async () => {
      const current = ctx.goals.get(agent)
      ctx.goals.pause(agent, current!)
      return shellResult()
    })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale pass', evidence: ['quality output'],
    })).toMatchObject({ isError: true, error: { message: 'Goal changed while verification was running' } })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused' })
    await ctx.fiber.dispose()
  })

  it('blocks on verifier infrastructure failure and rejects weak evidence before disarming', async () => {
    const { ctx, agent, shell } = await createHarness({
      tools: { minimumEvidenceItems: 2, checks: [{ name: 'quality', command: 'quality' }] },
    })
    startGoal(ctx, agent)
    const weak = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['one', '  '],
    })
    expect(weak).toMatchObject({ isError: true, error: { message: expect.stringContaining('at least 2') } })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })

    shell.outcomes.push(new Error('shell backend unavailable'))
    const failed = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['one', 'two'],
    })
    expect(failed).toMatchObject({ isError: true, error: { message: 'shell backend unavailable' } })
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked', blockedReason: { code: 'verifier-error', message: 'shell backend unavailable' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', reason: 'verifier infrastructure error' })
    await ctx.fiber.dispose()
  })

  it('rejects empty summaries and missing or disarmed Goal state', async () => {
    const { ctx, agent } = await createHarness()
    startGoal(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: '  ', evidence: ['proof'],
    })).toMatchObject({ isError: true, error: { message: 'verification summary must not be empty' } })
    ctx.goals.disarm(agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'ready', evidence: ['proof'],
    })).toMatchObject({ isError: true, error: { message: expect.stringContaining('armed Goal') } })
    await ctx.fiber.dispose()
  })

  it('classifies exhausted verification and non-Error infrastructure failures', async () => {
    const exhausted = await createHarness()
    startGoal(exhausted.ctx, exhausted.agent)
    exhausted.shell.outcomes.push(new AutonomyError(
      'attempts exhausted',
      'AUTONOMY_VERIFICATION_EXHAUSTED',
    ))
    expect(await executeTool(exhausted.ctx, exhausted.agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({ isError: true, error: { message: 'attempts exhausted' } })
    expect(exhausted.ctx.goals.get(exhausted.agent)).toMatchObject({
      phase: 'blocked', blockedReason: { code: 'verification-attempts-exhausted' },
    })
    expect(exhausted.ctx.autonomy.get(exhausted.agent)).toMatchObject({
      phase: 'paused', reason: 'attempts exhausted',
    })
    await exhausted.ctx.fiber.dispose()

    const primitive = await createHarness()
    startGoal(primitive.ctx, primitive.agent)
    vi.spyOn(primitive.shell, 'run').mockRejectedValue('primitive failure')
    vi.spyOn(primitive.ctx.goals, 'block').mockImplementation(() => {
      throw new Error('block storage failed')
    })
    expect(await executeTool(primitive.ctx, primitive.agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({ isError: true, error: { message: 'primitive failure' } })
    expect(primitive.ctx.goals.get(primitive.agent)).toMatchObject({ activation: 'disarmed' })
    await primitive.ctx.fiber.dispose()
  })

  it('blocks the Goal and cancels activity when the verification budget is naturally exhausted', async () => {
    const { ctx, agent, shell } = await createHarness({
      autonomy: { maxVerificationAttempts: 1 },
    })
    startGoal(ctx, agent)
    shell.outcomes.push(shellResult({ exitCode: 1 }))
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'first candidate', evidence: ['failing quality output'],
    })).toMatchObject({ isError: false, value: { verdict: 'fail' } })
    const activity = ctx.autonomy.signal(agent)

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'second candidate', evidence: ['unchanged quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'verification attempt budget exhausted (1)' },
    })
    expect(shell.requests).toHaveLength(1)
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked',
      activation: 'disarmed',
      blockedReason: {
        code: 'verification-attempts-exhausted',
        message: 'verification attempt budget exhausted (1)',
      },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused', reason: 'verification attempt budget exhausted (1)',
    })
    expect(activity.aborted).toBe(true)
    await ctx.fiber.dispose()
  })

  it('does not pause an already-paused lease after verifier infrastructure failure', async () => {
    const { ctx, agent, shell } = await createHarness()
    startGoal(ctx, agent)
    vi.spyOn(shell, 'run').mockImplementation(async () => {
      ctx.autonomy.pause(agent, 'backend preempted')
      throw new Error('backend preempted')
    })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({ isError: true, error: { message: 'backend preempted' } })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', reason: 'backend preempted' })
    await ctx.fiber.dispose()
  })
})

describe('autonomy tool guards and dynamic Cordis accounting', () => {
  it('owns completion and permits only lease-defined Host Packages', async () => {
    const { ctx, agent } = await createHarness({ autonomy: { maxDynamicPackages: 1 } })
    registerTool(ctx, 'update_goal')
    registerTool(ctx, 'cordis_define', args => ({
      pluginId: 'demo1', packageId: 'pkg1', hasClientHalf: false, ...args,
    }))
    registerTool(ctx, 'cordis_run')
    startGoal(ctx, agent)

    expect(await executeTool(ctx, agent, 'update_goal', { action: 'complete' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('verifier-owned') } })
    expect(await executeTool(ctx, agent, 'cordis_define', { code: { client: 'return plugin' } }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('Host-only') } })
    expect(await executeTool(ctx, agent, 'cordis_run', { pluginId: 'unknown', packageId: 'unknown' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('defined without Client code') } })

    expect(await executeTool(ctx, agent, 'cordis_define', { code: { host: 'return plugin' } }))
      .toMatchObject({ isError: false, value: { pluginId: 'demo1', packageId: 'pkg1' } })
    expect(ctx.autonomy.get(agent)?.dynamicPackages).toBe(1)
    expect((await executeTool(ctx, agent, 'cordis_run', { pluginId: 'demo1', packageId: 'pkg1' })).isError)
      .toBe(false)
    expect(await executeTool(ctx, agent, 'cordis_define', { code: { host: 'return newer' } }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('budget exhausted') } })

    ctx.autonomy.beginVerification(agent)
    expect(await executeTool(ctx, agent, 'cordis_run', { pluginId: 'demo1', packageId: 'pkg1' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('verification is in progress') } })
    await ctx.fiber.dispose()
  })

  it('supports policy modes off and client-approved without overriding DSH approval', async () => {
    const off = await createHarness({ autonomy: { selfModification: 'off' } })
    registerTool(off.ctx, 'cordis_define')
    registerTool(off.ctx, 'cordis_run')
    startGoal(off.ctx, off.agent)
    expect(await executeTool(off.ctx, off.agent, 'cordis_define', { code: { host: 'x' } }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('disables') } })
    expect(await executeTool(off.ctx, off.agent, 'cordis_run', { pluginId: 'x', packageId: 'y' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('disables') } })
    await off.ctx.fiber.dispose()

    const client = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    registerTool(client.ctx, 'cordis_define', () => ({
      pluginId: 'client1', packageId: 'client-pkg', hasClientHalf: true,
    }))
    registerTool(client.ctx, 'cordis_run')
    startGoal(client.ctx, client.agent)
    expect((await executeTool(client.ctx, client.agent, 'cordis_define', { code: { client: 'x' } })).isError)
      .toBe(false)
    expect((await executeTool(client.ctx, client.agent, 'cordis_run', {
      pluginId: 'client1', packageId: 'client-pkg',
    })).isError).toBe(false)
    await client.ctx.fiber.dispose()
  })

  it('ignores malformed, failed, inactive, and Client-bearing definition receipts', async () => {
    const { ctx, agent } = await createHarness()
    registerTool(ctx, 'cordis_run')
    registerTool(ctx, 'cordis_define', args => args['action'] === 'primitive'
      ? null
      : args['action'] === 'missing-id'
        ? { pluginId: 'partial' }
        : args['action'] === 'client'
          ? { pluginId: 'client', packageId: 'pkg', hasClientHalf: true }
          : { pluginId: 'paused', packageId: 'pkg', hasClientHalf: false })

    expect((await executeTool(ctx, agent, 'cordis_run', 'invalid-reference')).isError).toBe(true)
    startGoal(ctx, agent)
    expect((await executeTool(ctx, agent, 'cordis_run', 'invalid-reference')).isError).toBe(true)
    expect((await executeTool(ctx, agent, 'cordis_run', {
      pluginId: 3, packageId: 'invalid-reference',
    })).isError).toBe(true)
    expect((await executeTool(ctx, agent, 'cordis_define', { action: 'primitive' })).isError).toBe(false)
    expect((await executeTool(ctx, agent, 'cordis_define', { action: 'missing-id' })).isError).toBe(false)
    expect((await executeTool(ctx, agent, 'cordis_define', { action: 'client' })).isError).toBe(false)
    expect(ctx.autonomy.get(agent)?.dynamicPackages).toBe(1)

    ctx.goals.pause(agent, ctx.goals.get(agent)!)
    ctx.autonomy.pause(agent)
    expect((await executeTool(ctx, agent, 'cordis_define', { action: 'paused' })).isError).toBe(false)
    expect(ctx.autonomy.get(agent)?.dynamicPackages).toBe(1)
    await ctx.fiber.dispose()
  })

  it('contains dynamic Package accounting failures and malformed Host-only code', async () => {
    const { ctx, agent } = await createHarness()
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'contained', packageId: 'pkg', hasClientHalf: false,
    }))
    startGoal(ctx, agent)
    expect((await executeTool(ctx, agent, 'cordis_define', { code: 'not-an-object' })).isError).toBe(false)
    const account = vi.spyOn(ctx.autonomy, 'recordDynamicPackage').mockImplementation(() => {
      throw new Error('accounting unavailable')
    })
    expect((await executeTool(ctx, agent, 'cordis_define', { code: {} })).isError).toBe(false)
    expect(account).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['string', 'false'],
    ['client', true],
  ] as const)('fails closed when a definition reports hasClientHalf as %s', async (suffix, value) => {
    const { ctx, agent } = await createHarness()
    const pluginId = `malformed-${suffix}`
    registerTool(ctx, 'cordis_define', () => ({
      pluginId,
      packageId: 'pkg',
      ...(value === undefined ? {} : { hasClientHalf: value }),
    }))
    registerTool(ctx, 'cordis_run')
    startGoal(ctx, agent)

    expect((await executeTool(ctx, agent, 'cordis_define', { code: { host: 'x' } })).isError).toBe(false)
    expect(await executeTool(ctx, agent, 'cordis_run', { pluginId, packageId: 'pkg' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('during this lease') } })
    await ctx.fiber.dispose()
  })

  it('binds Host Package receipts to one lease and refuses reuse after reauthorization', async () => {
    const { ctx, agent } = await createHarness()
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'lease-scoped', packageId: 'pkg', hasClientHalf: false,
    }))
    registerTool(ctx, 'cordis_run')
    startGoal(ctx, agent)

    expect((await executeTool(ctx, agent, 'cordis_define', { code: { host: 'return plugin' } })).isError)
      .toBe(false)
    expect((await executeTool(ctx, agent, 'cordis_run', {
      pluginId: 'lease-scoped', packageId: 'pkg',
    })).isError).toBe(false)

    ctx.autonomy.revoke(agent)
    ctx.goals.complete(agent, ctx.goals.get(agent)!)
    const next = ctx.goals.create(agent, { objective: 'new authorization' })
    ctx.autonomy.start(agent, { goalId: next.id })
    expect(await executeTool(ctx, agent, 'cordis_run', {
      pluginId: 'lease-scoped', packageId: 'pkg',
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('during this lease') },
    })
    await ctx.fiber.dispose()
  })

  it('atomically reserves the dynamic Package budget across concurrent definitions', async () => {
    const { ctx, agent } = await createHarness({ autonomy: { maxDynamicPackages: 2 } })
    let enterFirst!: () => void
    let enterSecond!: () => void
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstEntered = new Promise<void>(resolve => { enterFirst = resolve })
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve })
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondRelease = new Promise<void>(resolve => { releaseSecond = resolve })
    registerTool(ctx, 'cordis_define', async (args) => {
      if (args['action'] === 'first') {
        enterFirst()
        await firstRelease
      } else if (args['action'] === 'second') {
        enterSecond()
        await secondRelease
      }
      return {
        pluginId: String(args['action']), packageId: 'pkg', hasClientHalf: false,
      }
    })
    startGoal(ctx, agent)

    const first = executeTool(ctx, agent, 'cordis_define', { action: 'first', code: { host: 'x' } })
    await firstEntered
    const second = executeTool(ctx, agent, 'cordis_define', { action: 'second', code: { host: 'y' } })
    await secondEntered
    expect(await executeTool(ctx, agent, 'cordis_define', { action: 'third', code: { host: 'z' } }))
      .toMatchObject({
        isError: true,
        error: {
          message: 'Autopilot dynamic Package budget exhausted (2).',
          info: { code: 'AUTONOMY_POLICY_DENIED' },
        },
      })
    releaseFirst()
    expect((await first).isError).toBe(false)
    releaseSecond()
    expect((await second).isError).toBe(false)
    expect(ctx.autonomy.get(agent)?.dynamicPackages).toBe(2)
    await ctx.fiber.dispose()
  })

  it('releases an in-flight definition reservation after its Agent is disposed', async () => {
    const { ctx, agent } = await createHarness({ autonomy: { maxDynamicPackages: 1 } })
    let entered!: () => void
    let release!: () => void
    const bodyEntered = new Promise<void>(resolve => { entered = resolve })
    const bodyRelease = new Promise<void>(resolve => { release = resolve })
    registerTool(ctx, 'cordis_define', async () => {
      entered()
      await bodyRelease
      return { pluginId: 'disposed', packageId: 'pkg', hasClientHalf: false }
    })
    startGoal(ctx, agent)

    const execution = executeTool(ctx, agent, 'cordis_define', { code: { host: 'x' } })
    await bodyEntered
    agentEvents(ctx, agent).emit('agent/disposed', {})
    release()
    expect((await execution).isError).toBe(false)
    expect(ctx.autonomy.get(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('verifier configuration', () => {
  it.each([
    [{ checks: [] }, 'at least one'],
    [{ checks: [{ name: ' ', command: 'test' }] }, 'name must not be empty'],
    [{ checks: [{ name: 'test', command: ' ' }] }, 'command must not be empty'],
    [{ checks: [{ name: 'same', command: 'a' }, { name: ' same ', command: 'b' }] }, 'duplicated'],
    [{ minimumEvidenceItems: -1, checks: [{ name: 'test', command: 'test' }] }, 'minimumEvidenceItems'],
    [{ maxOutputChars: 0, checks: [{ name: 'test', command: 'test' }] }, 'maxOutputChars'],
    [{ checks: [{ name: 'test', command: 'test', timeoutMs: 0 }] }, 'timeoutMs'],
  ])('fails load for invalid configuration %j', async (tools, message) => {
    await expect(createHarness({ tools: tools as never })).rejects.toThrow(message)
  })

  it('applies verifier defaults through the plugin schema', async () => {
    const { ctx, agent, shell } = await createHarness({
      tools: { checks: [{ name: ' quality ', command: ' test ' }] },
    })
    startGoal(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'defaults', evidence: ['quality output'],
    })
    expect(shell.requests[0]).toMatchObject({ command: 'test', timeoutMs: 120_000 })
    await ctx.fiber.dispose()
  })

  it('defends direct apply callers before Cordis schema normalization', async () => {
    const { ctx } = await createHarness()
    expect(() => applyTools(ctx, {
      checks: [{ name: 'direct', command: 'test' }],
    })).toThrow()
    expect(() => applyTools(ctx, {
      minimumEvidenceItems: Number.NaN,
      checks: [{ name: 'direct', command: 'test' }],
    })).toThrow('minimumEvidenceItems')
    expect(() => applyTools(ctx, {
      maxOutputChars: Number.NaN,
      checks: [{ name: 'direct', command: 'test' }],
    })).toThrow('maxOutputChars')
    expect(() => applyTools(ctx, {
      checks: [{ name: 'direct', command: 'test', timeoutMs: Number.NaN }],
    })).toThrow('timeoutMs')
    await ctx.fiber.dispose()
  })
})
