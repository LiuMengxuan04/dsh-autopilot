import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REVIEWERS,
  runReviewerQuorum,
} from '../../src/evaluator.ts'
import type { ReviewerConfig, ReviewerQuorumRequest } from '../../src/evaluator.ts'
import { createRunPlan } from '../../src/run-state.ts'
import { createTestAgent } from '../helpers.ts'

const ALL_CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

/** Public-seam provider whose test controls every returned run. */
class StubProvider implements SubagentProvider {
  readonly capabilities = ALL_CAPABILITIES
  readonly requests: ResolvedSubagentStartRequest[] = []

  constructor(
    readonly name: string,
    private readonly starter: (
      request: ResolvedSubagentStartRequest,
      index: number,
    ) => SubagentRun | Promise<SubagentRun>,
    readonly inheritsParentContext = false,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    return this.starter(request, this.requests.length - 1)
  }
}

/** Deferred provider used to prove bounded concurrency independently of completion order. */
class DeferredProvider implements SubagentProvider {
  readonly name = 'spawn'
  readonly capabilities = ALL_CAPABILITIES
  readonly inheritsParentContext = false
  readonly requests: ResolvedSubagentStartRequest[] = []
  readonly disposed: ReturnType<typeof vi.fn>[] = []
  private readonly deferred: PromiseWithResolvers<SubagentResult>[] = []
  private active = 0
  maxActive = 0

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const result = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(async () => {})
    const index = this.requests.length
    this.requests.push(request)
    this.deferred.push(result)
    this.disposed.push(dispose)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    return Promise.resolve({
      id: SessionId(`review-child-${index}`),
      localAgent: undefined,
      result: result.promise,
      dispose,
    })
  }

  resolve(index: number, result: SubagentResult): void {
    const deferred = this.deferred[index]
    if (deferred === undefined) throw new Error(`missing deferred reviewer ${index}`)
    this.active -= 1
    deferred.resolve(result)
  }
}

/** Construct a one-shot public subagent run. */
function run(
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

/** Create a quorum request with one complete, JSON-safe fixture graph. */
function request(
  parent: Agent,
  reviewers: readonly ReviewerConfig[] = DEFAULT_REVIEWERS,
  overrides: Partial<Pick<ReviewerQuorumRequest, 'maxConcurrency' | 'signal' | 'startSubagent'>> = {},
): ReviewerQuorumRequest {
  return {
    objective: 'ship the feature',
    parentGoalId: 'goal-review-parent',
    plan: createRunPlan(['all requirements pass'], [{
      id: 'implement',
      title: 'Implement',
      description: 'Implement the requested behavior',
      acceptanceCriteria: ['focused tests pass'],
    }], 1),
    candidate: { summary: 'implemented', evidence: ['pnpm test'], submittedAt: 2 },
    checks: [{ name: 'unit', passed: true, summary: 'passed' }],
    reviewers,
    maxConcurrency: overrides.maxConcurrency ?? 2,
    parent,
    ...(overrides.startSubagent === undefined ? {} : { startSubagent: overrides.startSubagent }),
    signal: overrides.signal ?? new AbortController().signal,
  }
}

/** Build the DSH public subagent service, optionally with a visible tool catalog. */
async function evaluatorContext(toolNames?: readonly string[]): Promise<Context> {
  const ctx = new Context()
  if (toolNames !== undefined) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    for (const name of toolNames) {
      ctx.tools.register(defineTool({
        name,
        description: `fixture ${name}`,
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: () => Promise.resolve({}),
      }))
    }
  }
  await ctx.plugin(SubagentRuntime)
  return ctx
}

function completed(
  verdict: 'pass' | 'fail' | 'inconclusive' = 'pass',
  summary = 'accepted',
  findings: unknown = [],
): SubagentResult {
  return {
    output: [],
    stopReason: 'completed',
    structured: { verdict, summary, findings },
  }
}

describe('reviewer quorum', () => {
  it('defines the five independent default lanes', () => {
    expect(DEFAULT_REVIEWERS.map(reviewer => reviewer.role)).toEqual([
      'requirements',
      'code-quality',
      'security',
      'testing',
      'architecture',
    ])
    expect(Object.isFrozen(DEFAULT_REVIEWERS)).toBe(true)
    expect(DEFAULT_REVIEWERS.every(Object.isFrozen)).toBe(true)
    expect(DEFAULT_REVIEWERS.find(reviewer => reviewer.role === 'code-quality')?.description)
      .toMatch(/comments.*redundant narration.*slop/u)
  })

  it('keeps stable role order under a strict concurrency ceiling and denies visible mutation tools', async () => {
    const ctx = await evaluatorContext([
      'read',
      'write',
      'autopilot_plan',
      'cordis_define',
      'subagent_worker',
      'workflow_start',
    ])
    const provider = new DeferredProvider()
    ctx.subagents.registerProvider(provider)
    const evaluating = runReviewerQuorum(ctx, request(createTestAgent(), DEFAULT_REVIEWERS, { maxConcurrency: 2 }))

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(2) })
    provider.resolve(1, completed('pass', 'quality passed'))
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(3) })
    provider.resolve(2, completed('pass', 'security passed'))
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(4) })
    provider.resolve(3, completed('pass', 'testing passed'))
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(5) })
    provider.resolve(4, completed('pass', 'architecture passed'))
    provider.resolve(0, completed('pass', 'requirements passed'))

    const outcomes = await evaluating
    expect(outcomes.map(outcome => outcome.role)).toEqual(DEFAULT_REVIEWERS.map(reviewer => reviewer.role))
    expect(outcomes.map(outcome => outcome.childSessionId)).toEqual([
      'review-child-0',
      'review-child-1',
      'review-child-2',
      'review-child-3',
      'review-child-4',
    ])
    expect(provider.maxActive).toBe(2)
    expect(provider.disposed.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
    for (const childRequest of provider.requests) {
      expect(childRequest.maxDepth).toBe(1)
      expect(childRequest.outputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(childRequest.toolFilter).toEqual({ allow: ['read'] })
      expect(childRequest.persona).toContain('read-only')
      expect(childRequest.prompt[0]).toMatchObject({ type: 'text' })
      const prompt = childRequest.prompt[0]?.type === 'text' ? childRequest.prompt[0].text : ''
      expect(prompt).toContain('<candidate_data>')
      expect(prompt).toContain('<parent_execution_snapshot>')
      expect(prompt).toContain('host-supplied-parent-snapshot')
      expect(prompt).toContain('goal-review-parent')
      expect(prompt).toContain('child-local Goal or Autopilot state')
    }
  })

  it('dispatches reviewers through the host-owned managed start wrapper', async () => {
    const ctx = await evaluatorContext()
    const provider = new StubProvider('spawn', () => run('managed-review', completed()))
    ctx.subagents.registerProvider(provider)
    const managedStart = vi.fn(ctx.subagents.start.bind(ctx.subagents))

    const [outcome] = await runReviewerQuorum(ctx, request(createTestAgent(), [{
      role: 'managed',
      description: 'Audit managed child provenance.',
    }], { maxConcurrency: 1, startSubagent: managedStart }))

    expect(managedStart).toHaveBeenCalledOnce()
    expect(outcome).toMatchObject({ role: 'managed', childSessionId: 'managed-review', verdict: 'pass' })
  })

  it('routes subagent transport separately from LLM provider/model and normalizes structured findings', async () => {
    const ctx = await evaluatorContext()
    const spawn = new StubProvider('spawn', () => run('unused', completed()))
    const remote = new StubProvider('remote', () => run(
      'remote-review',
      completed('fail', '  defect found  ', ['  first finding ', '', 'second finding']),
    ))
    ctx.subagents.registerProvider(spawn)
    ctx.subagents.registerProvider(remote)
    const outcomes = await runReviewerQuorum(ctx, request(createTestAgent(), [{
      role: ' security ',
      description: 'audit security',
      subagentProvider: ' remote ',
      provider: ' deepseek ',
      model: ' v4 ',
    }]))

    expect(spawn.requests).toHaveLength(0)
    expect(remote.requests).toHaveLength(1)
    expect(remote.requests[0]?.agentOptions).toEqual({ provider: 'deepseek', model: 'v4' })
    expect(outcomes).toEqual([{
      role: 'security',
      verdict: 'fail',
      summary: 'defect found',
      findings: ['first finding', 'second finding'],
      childSessionId: 'remote-review',
    }])
  })

  it('falls back only after reviewer infrastructure failure and charges the additional attempt', async () => {
    const ctx = await evaluatorContext()
    const recordSubagentStarts = vi.fn(async () => ({}))
    Object.defineProperty(ctx, 'autonomy', {
      configurable: true,
      value: { recordSubagentStarts },
    })
    const primary = new StubProvider('primary', () => { throw new Error('review adapter unavailable') })
    const secondary = new StubProvider('secondary', () => run('secondary-review', completed()))
    ctx.subagents.registerProvider(primary)
    ctx.subagents.registerProvider(secondary)

    const outcomes = await runReviewerQuorum(ctx, request(createTestAgent(), [{
      role: 'requirements',
      description: 'audit requirements',
      subagentProvider: 'primary',
      provider: 'primary-llm',
      fallbacks: [{ subagentProvider: 'secondary', provider: 'backup-llm', model: 'backup-v1' }],
    }]))

    expect(primary.requests).toHaveLength(1)
    expect(secondary.requests).toHaveLength(1)
    expect(secondary.requests[0]?.agentOptions).toEqual({ provider: 'backup-llm', model: 'backup-v1' })
    expect(recordSubagentStarts).toHaveBeenCalledOnce()
    expect(outcomes).toMatchObject([{
      verdict: 'pass',
      childSessionId: 'secondary-review',
      summary: expect.stringContaining('previous route failures: reviewer failed to start: review adapter unavailable'),
    }])
  })

  it('does not route around semantic review failure, abort, or fallback budget denial', async () => {
    const semantic = await evaluatorContext()
    const semanticBudget = vi.fn(async () => ({}))
    Object.defineProperty(semantic, 'autonomy', { configurable: true, value: { recordSubagentStarts: semanticBudget } })
    const primary = new StubProvider('primary', () => run('failed-review', completed('fail', 'real defect', ['fix it'])))
    const secondary = new StubProvider('secondary', () => run('unused', completed()))
    semantic.subagents.registerProvider(primary)
    semantic.subagents.registerProvider(secondary)
    await expect(runReviewerQuorum(semantic, request(createTestAgent(), [{
      role: 'security', description: 'audit security', subagentProvider: 'primary',
      fallbacks: [{ subagentProvider: 'secondary' }],
    }]))).resolves.toMatchObject([{ verdict: 'fail', summary: 'real defect' }])
    expect(secondary.requests).toHaveLength(0)
    expect(semanticBudget).not.toHaveBeenCalled()

    const denied = await evaluatorContext()
    const deniedBudget = vi.fn(async () => { throw new Error('subagent budget exhausted') })
    Object.defineProperty(denied, 'autonomy', { configurable: true, value: { recordSubagentStarts: deniedBudget } })
    const unavailable = new StubProvider('unavailable', () => { throw new Error('provider offline') })
    const forbidden = new StubProvider('forbidden', () => run('unused', completed()))
    denied.subagents.registerProvider(unavailable)
    denied.subagents.registerProvider(forbidden)
    await expect(runReviewerQuorum(denied, request(createTestAgent(), [{
      role: 'testing', description: 'audit tests', subagentProvider: 'unavailable',
      fallbacks: [{ subagentProvider: 'forbidden' }],
    }]))).resolves.toMatchObject([{
      verdict: 'error', summary: expect.stringContaining('fallback budget denied'),
    }])
    expect(forbidden.requests).toHaveLength(0)

    const aborted = await evaluatorContext()
    Object.defineProperty(aborted, 'autonomy', { configurable: true, value: { recordSubagentStarts: vi.fn() } })
    const controller = new AbortController()
    controller.abort()
    const abortedPrimary = new StubProvider('aborted-primary', () => { throw new Error('cancelled') })
    const abortedSecondary = new StubProvider('aborted-secondary', () => run('unused', completed()))
    aborted.subagents.registerProvider(abortedPrimary)
    aborted.subagents.registerProvider(abortedSecondary)
    await expect(runReviewerQuorum(aborted, request(createTestAgent(), [{
      role: 'architecture', description: 'audit architecture', subagentProvider: 'aborted-primary',
      fallbacks: [{ subagentProvider: 'aborted-secondary' }],
    }], { signal: controller.signal }))).resolves.toMatchObject([{ verdict: 'inconclusive' }])
    expect(abortedSecondary.requests).toHaveLength(0)
  })

  it('maps refusal, invalid structured output, result failure, and cleanup failure without rejecting the quorum', async () => {
    const ctx = await evaluatorContext()
    const cleanup = vi.fn(async () => { throw new Error('dispose boom') })
    const provider = new StubProvider('spawn', (_request, index) => {
      switch (index) {
        case 0:
          return run('refused', { output: [], stopReason: 'refusal' })
        case 1:
          return run('invalid', completed('pass', '', ['finding']))
        case 2:
          return run('rejected', Promise.reject(new Error('transport boom')))
        case 3:
          return run('cleanup', completed(), cleanup)
        default:
          return run('errored', { output: [], stopReason: 'error' })
      }
    })
    ctx.subagents.registerProvider(provider)
    const reviewers = ['refused', 'invalid', 'rejected', 'cleanup', 'errored'].map(role => ({
      role,
      description: `review ${role}`,
    }))
    const outcomes = await runReviewerQuorum(ctx, request(createTestAgent(), reviewers, { maxConcurrency: 5 }))

    expect(outcomes.map(outcome => outcome.verdict)).toEqual([
      'inconclusive',
      'error',
      'error',
      'error',
      'error',
    ])
    expect(outcomes[1]?.summary).toContain('invalid structured result')
    expect(outcomes[2]?.summary).toContain('transport boom')
    expect(outcomes[3]?.summary).toContain('cleanup failed: dispose boom')
    expect(outcomes[4]?.summary).toBe('reviewer ended with error')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('handles a read-only catalog, partial model routes, and every malformed structured-result class', async () => {
    const ctx = await evaluatorContext(['read'])
    const provider = new StubProvider('spawn', (_request, index) => {
      switch (index) {
        case 0:
          return run('not-record', { output: [], stopReason: 'completed' })
        case 1:
          return run('not-array', completed('pass', 'x', null))
        case 2:
          return run('not-strings', completed('pass', 'x', [1]))
        case 3:
          return run('bad-verdict', {
            output: [],
            stopReason: 'completed',
            structured: { verdict: 'unknown', summary: 'x', findings: [] },
          })
        case 4:
          return run('empty-fail', completed('fail', 'defect without details'))
        default:
          return run(`partial-route-${index}`, completed())
      }
    })
    ctx.subagents.registerProvider(provider)
    const outcomes = await runReviewerQuorum(ctx, request(createTestAgent(), [
      { role: 'not-record', description: 'not record' },
      { role: 'not-array', description: 'not array' },
      { role: 'not-strings', description: 'not strings' },
      { role: 'bad-verdict', description: 'bad verdict' },
      { role: 'empty-fail', description: 'empty fail' },
      { role: 'provider-only', description: 'provider route', provider: 'deepseek' },
      { role: 'model-only', description: 'model route', model: 'v4' },
    ], { maxConcurrency: 7 }))

    expect(outcomes.slice(0, 5).map(outcome => outcome.verdict)).toEqual([
      'error', 'error', 'error', 'error', 'error',
    ])
    expect(outcomes.slice(5).map(outcome => outcome.verdict)).toEqual(['pass', 'pass'])
    for (const childRequest of provider.requests) {
      expect(childRequest.toolFilter).toEqual({ allow: ['read'] })
    }
    expect(provider.requests[5]?.agentOptions).toEqual({ provider: 'deepseek' })
    expect(provider.requests[6]?.agentOptions).toEqual({ model: 'v4' })
  })

  it('distinguishes ordinary and aborted startup/result failures', async () => {
    const ordinary = await evaluatorContext()
    ordinary.subagents.registerProvider(new StubProvider('spawn', () => { throw new Error('start boom') }))
    await expect(runReviewerQuorum(ordinary, request(createTestAgent(), [{
      role: 'ordinary', description: 'ordinary failure',
    }]))).resolves.toMatchObject([{ verdict: 'error', summary: 'reviewer failed to start: start boom' }])

    const controller = new AbortController()
    controller.abort()
    const abortedStart = await evaluatorContext()
    abortedStart.subagents.registerProvider(new StubProvider('spawn', () => { throw 42 }))
    await expect(runReviewerQuorum(abortedStart, request(createTestAgent(), [{
      role: 'aborted-start', description: 'aborted start',
    }], { signal: controller.signal }))).resolves.toMatchObject([{
      verdict: 'inconclusive', summary: 'reviewer failed to start: 42',
    }])

    const abortedResult = await evaluatorContext()
    abortedResult.subagents.registerProvider(new StubProvider('spawn', () => run(
      'aborted-result',
      Promise.reject({ toString: () => { throw new Error('coercion') } }),
    )))
    await expect(runReviewerQuorum(abortedResult, request(createTestAgent(), [{
      role: 'aborted-result', description: 'aborted result',
    }], { signal: controller.signal }))).resolves.toMatchObject([{
      verdict: 'inconclusive', summary: 'reviewer execution failed: <unrenderable thrown value>',
    }])
  })

  it('rejects inherited-context and missing reviewer transports as contained lane errors', async () => {
    const inherited = await evaluatorContext()
    const fork = new StubProvider('fork', () => run('unused', completed()), true)
    inherited.subagents.registerProvider(fork)
    await expect(runReviewerQuorum(inherited, request(createTestAgent(), [{
      role: 'freshness',
      description: 'must be fresh',
      subagentProvider: 'fork',
    }]))).resolves.toMatchObject([{
      verdict: 'error',
      summary: 'reviewer failed to start: reviewer subagent provider "fork" is not fresh-context',
    }])
    expect(fork.requests).toHaveLength(0)

    const missing = await evaluatorContext()
    await expect(runReviewerQuorum(missing, request(createTestAgent(), [{
      role: 'missing', description: 'missing transport', subagentProvider: 'absent',
    }]))).resolves.toMatchObject([{
      verdict: 'error', summary: expect.stringContaining('no subagent provider registered for "absent"'),
    }])
  })

  it('rejects invalid quorum and reviewer configuration before starting children', async () => {
    const ctx = await evaluatorContext()
    const provider = new StubProvider('spawn', () => run('child', completed()))
    ctx.subagents.registerProvider(provider)
    const parent = createTestAgent()

    await expect(runReviewerQuorum(ctx, request(parent, [], { maxConcurrency: 1 })))
      .rejects.toThrow('at least one independent reviewer')
    await expect(runReviewerQuorum(ctx, request(parent, DEFAULT_REVIEWERS, { maxConcurrency: 0 })))
      .rejects.toThrow('positive safe integer')
    await expect(runReviewerQuorum(ctx, request(parent, DEFAULT_REVIEWERS, { maxConcurrency: 1.5 })))
      .rejects.toThrow('positive safe integer')
    await expect(runReviewerQuorum(ctx, request(parent, [
      { role: 'same', description: 'one' },
      { role: ' same ', description: 'two' },
    ]))).rejects.toThrow('duplicated')
    await expect(runReviewerQuorum(ctx, request(parent, [{ role: '', description: 'x' }])))
      .rejects.toThrow('must not be empty')
    await expect(runReviewerQuorum(ctx, request(parent, [{ role: 'x', description: '' }])))
      .rejects.toThrow('must not be empty')
    for (const reviewer of [
      { role: 'x', description: 'x', subagentProvider: ' ' },
      { role: 'x', description: 'x', provider: ' ' },
      { role: 'x', description: 'x', model: ' ' },
      { role: 'x', description: 'x', fallbacks: [{ subagentProvider: ' ' }] },
      { role: 'x', description: 'x', fallbacks: [{ provider: ' ' }] },
      { role: 'x', description: 'x', fallbacks: [{ model: ' ' }] },
    ]) {
      await expect(runReviewerQuorum(ctx, request(parent, [reviewer])))
        .rejects.toThrow('must not be empty when provided')
    }
    expect(provider.requests).toHaveLength(0)
  })
})
