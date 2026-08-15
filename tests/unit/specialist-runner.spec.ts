import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import {
  consultSpecialist,
  specialistConsultationJson,
} from '../../src/specialist-runner.ts'
import type { SpecialistConsultRequest } from '../../src/specialist-runner.ts'
import type { TaskRoute } from '../../src/orchestrator.ts'
import { createHarness } from '../helpers.ts'

const CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

function completed(structured: unknown): SubagentResult {
  return { output: [], stopReason: 'completed', structured }
}

function validResult(verdict: 'advice' | 'concern' | 'blocked' = 'advice'): SubagentResult {
  return completed({
    verdict,
    summary: '  inspect the lifecycle  ',
    findings: ['  one finding  ', ''],
    recommendations: ['  add an exact guard  '],
  })
}

function child(
  id: string,
  result: SubagentResult | Promise<SubagentResult>,
  dispose: () => Promise<void> = () => Promise.resolve(),
): SubagentRun {
  return {
    id: SessionId(id),
    localAgent: undefined,
    result: Promise.resolve(result),
    dispose,
  }
}

function request(
  parent: Agent,
  startSubagent: SpecialistConsultRequest['startSubagent'],
  overrides: Partial<SpecialistConsultRequest> = {},
): SpecialistConsultRequest {
  return {
    parent,
    specialistId: 'oracle',
    prompt: 'Should this lifecycle change proceed?',
    routes: [],
    startSubagent,
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function activeHarness() {
  const harness = await createHarness({ autonomy: { maxSubagents: 12 } })
  const goal = harness.ctx.goals.create(harness.agent, { objective: 'make a sound decision' })
  await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
  return harness
}

describe('specialist consultation runner', () => {
  it('uses a managed fresh child, read-only tools, configured route, and normalized output', async () => {
    const { ctx, agent } = await activeHarness()
    const start = vi.fn(async (_provider: string, _input: SubagentStartRequest) => child(
      'oracle-child',
      validResult('concern'),
    ))
    const routes: TaskRoute[] = [{
      role: 'oracle',
      subagentProvider: 'spawn',
      provider: 'deepseek',
      model: 'reasoner',
      persona: 'Deployment Oracle.',
    }]

    const result = await consultSpecialist(ctx, request(agent, start, {
      prompt: '  Review the lifecycle.  ',
      context: '  The service publishes before rearming.  ',
      routes,
    }))

    expect(result).toEqual({
      specialistId: 'oracle',
      verdict: 'concern',
      summary: 'inspect the lifecycle',
      findings: ['one finding'],
      recommendations: ['add an exact guard'],
      childSessionId: 'oracle-child',
    })
    expect(ctx.autonomy.get(agent)?.subagentsStarted).toBe(1)
    expect(start).toHaveBeenCalledOnce()
    expect(start.mock.calls[0]?.[0]).toBe('spawn')
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      label: 'autopilot-specialist-oracle',
      maxDepth: 1,
      persona: 'Deployment Oracle.',
      agentOptions: { provider: 'deepseek', model: 'reasoner' },
      toolFilter: { allow: expect.not.arrayContaining(['bash', 'get_autopilot', 'get_goal']) },
    })
    const firstPrompt = start.mock.calls[0]?.[1].prompt[0]
    expect(firstPrompt?.type === 'text' ? firstPrompt.text : '').toContain('The service publishes before rearming.')
    expect(firstPrompt?.type === 'text' ? firstPrompt.text : '').toContain('Never infer parent state or tool availability from this child session')
    expect(specialistConsultationJson(result)).toEqual(result)
  })

  it('lists input validation errors before consuming budget', async () => {
    const { ctx, agent } = await activeHarness()
    const start = vi.fn(async () => child('unused', validResult()))
    await expect(consultSpecialist(ctx, request(agent, start, { specialistId: 'missing' })))
      .rejects.toThrow('unknown specialist')
    await expect(consultSpecialist(ctx, request(agent, start, { prompt: '   ' })))
      .rejects.toThrow('prompt must not be empty')
    await expect(consultSpecialist(ctx, request(agent, start, { context: '   ' })))
      .rejects.toThrow('context must not be empty')
    expect(ctx.autonomy.get(agent)?.subagentsStarted).toBe(0)
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects consultation without the exact armed Goal and lease', async () => {
    const { ctx, agent } = await createHarness()
    const start = vi.fn(async () => child('unused', validResult()))
    await expect(consultSpecialist(ctx, request(agent, start)))
      .rejects.toThrow('requires the exact armed Autopilot Goal and lease')
    expect(start).not.toHaveBeenCalled()
  })

  it('falls back only for infrastructure failures and charges each attempt', async () => {
    const { ctx, agent } = await activeHarness()
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('primary unavailable'))
      .mockResolvedValueOnce(child('fallback-child', validResult()))
    const result = await consultSpecialist(ctx, request(agent, start, {
      routes: [{
        role: 'oracle',
        subagentProvider: 'primary',
        fallbacks: [{ subagentProvider: 'spawn', model: 'backup' }],
      }],
    }))
    expect(result).toMatchObject({
      verdict: 'advice',
      summary: expect.stringContaining('previous route failures'),
      childSessionId: 'fallback-child',
    })
    expect(start.mock.calls.map(call => call[0])).toEqual(['primary', 'spawn'])
    expect(ctx.autonomy.get(agent)?.subagentsStarted).toBe(2)
  })

  it('does not retry a semantic result or refusal', async () => {
    const { ctx, agent } = await activeHarness()
    const start = vi.fn()
      .mockResolvedValueOnce(child('blocked', validResult('blocked')))
      .mockResolvedValueOnce(child('unused', validResult()))
    const result = await consultSpecialist(ctx, request(agent, start, {
      routes: [{ role: 'oracle', fallbacks: [{ subagentProvider: 'spawn' }] }],
    }))
    expect(result.verdict).toBe('blocked')
    expect(start).toHaveBeenCalledOnce()

    const refusal = vi.fn(async () => child('refusal', {
      output: [], stopReason: 'refusal', structured: undefined,
    }))
    const refused = await consultSpecialist(ctx, request(agent, refusal))
    expect(refused).toMatchObject({ verdict: 'blocked', summary: 'specialist ended with refusal' })
  })

  it('retries max-token and execution failures but reports final infrastructure state', async () => {
    const { ctx, agent } = await activeHarness()
    const start = vi.fn()
      .mockResolvedValueOnce(child('truncated', {
        output: [], stopReason: 'max-tokens', structured: undefined,
      }))
      .mockImplementationOnce(() => Promise.resolve(child(
        'failed',
        Promise.reject(new Error('result transport failed')),
      )))
    const result = await consultSpecialist(ctx, request(agent, start, {
      routes: [{ role: 'oracle', fallbacks: [{ subagentProvider: 'spawn' }] }],
    }))
    expect(result).toMatchObject({
      verdict: 'error',
      summary: expect.stringContaining('result transport failed'),
    })
    expect(result.summary).toContain('previous route failures')
  })

  it('normalizes malformed structured output and cleanup failure', async () => {
    const { ctx, agent } = await activeHarness()
    const malformed = await consultSpecialist(ctx, request(agent, vi.fn(async () => child(
      'malformed', completed({ verdict: 'advice', summary: '', findings: 'bad', recommendations: [] }),
    ))))
    expect(malformed).toMatchObject({ verdict: 'error', summary: 'specialist returned an invalid structured result' })

    const cleanup = await consultSpecialist(ctx, request(agent, vi.fn(async () => child(
      'cleanup', validResult(), () => Promise.reject(new Error('dispose failed')),
    ))))
    expect(cleanup).toMatchObject({ verdict: 'error', summary: expect.stringContaining('dispose failed') })

    const nonRecord = await consultSpecialist(ctx, request(agent, vi.fn(async () => child(
      'non-record', completed(undefined),
    ))))
    expect(nonRecord).toMatchObject({ verdict: 'error', summary: 'specialist returned an invalid structured result' })
  })

  it('honors cancellation during start and execution without retrying', async () => {
    const { ctx, agent } = await activeHarness()
    const beforeStart = new AbortController()
    beforeStart.abort('stop')
    const startFailure = await consultSpecialist(ctx, request(
      agent,
      vi.fn(() => Promise.reject(new Error('cancelled start'))),
      { signal: beforeStart.signal },
    ))
    expect(startFailure).toMatchObject({ verdict: 'blocked', summary: expect.stringContaining('cancelled start') })

    const duringResult = new AbortController()
    const executionFailure = await consultSpecialist(ctx, request(
      agent,
      vi.fn(() => {
        duringResult.abort('stop')
        return Promise.resolve(child('cancelled-result', Promise.reject(new Error('cancelled result'))))
      }),
      { signal: duringResult.signal },
    ))
    expect(executionFailure).toMatchObject({ verdict: 'blocked', summary: expect.stringContaining('cancelled result') })
  })

  it('supports provider-only routing and an already-verifying lease checkpoint', async () => {
    const { ctx, agent } = await activeHarness()
    const originalGet = ctx.autonomy.get.bind(ctx.autonomy)
    const running = originalGet(agent)
    if (running === undefined) throw new Error('fixture has no active lease')
    vi.spyOn(ctx.autonomy, 'get')
      .mockReturnValueOnce({ ...running, phase: 'verifying' })
      .mockImplementation(originalGet)
    const start = vi.fn(async (_provider: string, _input: SubagentStartRequest) => child(
      'provider-only',
      validResult(),
    ))
    const result = await consultSpecialist(ctx, request(agent, start, {
      routes: [{ role: 'oracle', provider: 'deepseek' }],
    }))
    expect(result.verdict).toBe('advice')
    expect(start.mock.calls[0]?.[1]).toMatchObject({ agentOptions: { provider: 'deepseek' } })
  })

  it('rejects inherited-context providers and run drift after durable charging', async () => {
    const { ctx, agent } = await activeHarness()
    const provider: SubagentProvider = {
      name: 'inherited',
      capabilities: CAPABILITIES,
      inheritsParentContext: true,
      start: () => Promise.resolve(child('unused', validResult())),
    }
    ctx.subagents.registerProvider(provider)
    await expect(consultSpecialist(ctx, request(agent, ctx.subagents.start.bind(ctx.subagents), {
      routes: [{ role: 'oracle', subagentProvider: 'inherited' }],
    }))).rejects.toThrow('is not fresh-context')

    const original = ctx.autonomy.recordSubagentStarts.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'recordSubagentStarts').mockImplementation(async (...args) => {
      const view = await original(...args)
      ctx.goals.disarm(agent)
      return view
    })
    await expect(consultSpecialist(ctx, request(agent, vi.fn(async () => child('unused', validResult())))))
      .rejects.toThrow('changed before specialist dispatch')
  })

  it('renders uncoercible thrown values and omits absent child ids in JSON', async () => {
    const { ctx, agent } = await activeHarness()
    const thrown = { [Symbol.toPrimitive]() { throw new Error('cannot coerce') } }
    const result = await consultSpecialist(ctx, request(agent, vi.fn(() => Promise.reject(thrown))))
    expect(result).toMatchObject({ verdict: 'error', summary: expect.stringContaining('<unrenderable thrown value>') })
    expect(specialistConsultationJson({
      specialistId: 'oracle', verdict: 'error', summary: 'no child', findings: [], recommendations: [],
    })).toEqual({
      specialistId: 'oracle', verdict: 'error', summary: 'no child', findings: [], recommendations: [],
    })
  })
})
