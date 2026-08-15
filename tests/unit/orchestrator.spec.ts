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
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TASK_WORKER_TOOL_ALLOWLIST,
  delegateTaskBatch,
  delegationJson,
} from '../../src/orchestrator.ts'
import type {
  TaskAssignment,
  TaskDelegationRequest,
  TaskRoute,
} from '../../src/orchestrator.ts'
import { createRunPlan } from '../../src/run-state.ts'
import type { RunPlan } from '../../src/run-state.ts'
import { createTestAgent } from '../helpers.ts'

const ALL_CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

/** Public-seam provider whose test controls every returned task run. */
class StubTaskProvider implements SubagentProvider {
  readonly capabilities = ALL_CAPABILITIES
  readonly inheritsParentContext = false
  readonly requests: ResolvedSubagentStartRequest[] = []

  constructor(
    readonly name: string,
    private readonly starter: (
      request: ResolvedSubagentStartRequest,
      index: number,
    ) => SubagentRun | Promise<SubagentRun>,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    return this.starter(request, this.requests.length - 1)
  }
}

/** Deferred worker provider used to prove fan-out and ordered durable fan-in. */
class DeferredTaskProvider implements SubagentProvider {
  readonly name = 'spawn'
  readonly capabilities = ALL_CAPABILITIES
  readonly inheritsParentContext = false
  readonly requests: ResolvedSubagentStartRequest[] = []
  readonly disposed: ReturnType<typeof vi.fn>[] = []
  private readonly deferred: PromiseWithResolvers<SubagentResult>[] = []

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const result = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(async () => {})
    const index = this.requests.length
    this.requests.push(request)
    this.deferred.push(result)
    this.disposed.push(dispose)
    return Promise.resolve({
      id: SessionId(`task-child-${index}`),
      localAgent: undefined,
      result: result.promise,
      dispose,
    })
  }

  resolve(index: number, result: SubagentResult): void {
    const deferred = this.deferred[index]
    if (deferred === undefined) throw new Error(`missing deferred task ${index}`)
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

/** Build a dependency-free task plan for delegation tests. */
function plan(ids: readonly string[]): RunPlan {
  return createRunPlan(['finish every task'], ids.map(id => ({
    id,
    title: `Task ${id}`,
    description: `Complete ${id}`,
    acceptanceCriteria: [`${id} has evidence`],
  })), 1)
}

function assignment(taskId: string, role = 'developer'): TaskAssignment {
  return { taskId, role, prompt: `complete ${taskId}` }
}

/** Install only the public Autonomy methods consumed by the orchestrator. */
function installAutonomy(
  ctx: Context,
  runPlan: RunPlan | undefined,
  options: {
    readonly claimError?: unknown
    readonly settlementErrorTask?: string
    readonly settlementError?: unknown
  } = {},
) {
  const claimTasks = vi.fn(async (_parent: Agent, _taskIds: readonly string[]) => {
    if (options.claimError !== undefined) throw options.claimError
    return { plan: runPlan }
  })
  const updateTask = vi.fn(async (
    _parent: Agent,
    taskId: string,
    _action: string,
    _details: unknown,
  ) => {
    if (taskId === options.settlementErrorTask) throw options.settlementError
    return { plan: runPlan }
  })
  const recordSubagentStarts = vi.fn(async () => ({ plan: runPlan }))
  Object.defineProperty(ctx, 'autonomy', {
    configurable: true,
    value: { claimTasks, updateTask, recordSubagentStarts },
  })
  return { claimTasks, updateTask, recordSubagentStarts }
}

async function orchestratorContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  return ctx
}

function completed(
  status: 'completed' | 'failed' | 'blocked' = 'completed',
  summary = 'done',
  evidence: unknown = [{ kind: 'test', ref: ' pnpm test ', summary: ' tests passed ' }],
): SubagentResult {
  return {
    output: [],
    stopReason: 'completed',
    structured: { status, summary, evidence },
  }
}

function delegationRequest(
  parent: Agent,
  assignments: readonly TaskAssignment[],
  routes: readonly TaskRoute[] = [],
  signal = new AbortController().signal,
  startSubagent?: TaskDelegationRequest['startSubagent'],
): TaskDelegationRequest {
  return {
    parent,
    assignments,
    routes,
    toolAllowlist: DEFAULT_TASK_WORKER_TOOL_ALLOWLIST,
    ...(startSubagent === undefined ? {} : { startSubagent }),
    signal,
  }
}

describe('task delegation orchestration', () => {
  it('claims once, fans out concurrently, preserves assignment order, and settles sequentially', async () => {
    const ctx = await orchestratorContext()
    const runPlan = plan(['code', 'docs'])
    const autonomy = installAutonomy(ctx, runPlan)
    const provider = new DeferredTaskProvider()
    ctx.subagents.registerProvider(provider)
    const assignments = [assignment('code'), assignment('docs', 'writer')]
    const delegating = delegateTaskBatch(ctx, delegationRequest(createTestAgent(), assignments))

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(2) })
    expect(autonomy.updateTask).not.toHaveBeenCalled()
    provider.resolve(1, completed('blocked', 'needs product decision', []))
    await Promise.resolve()
    expect(autonomy.updateTask).not.toHaveBeenCalled()
    provider.resolve(0, completed('completed', '  code done  '))

    const results = await delegating
    expect(autonomy.claimTasks).toHaveBeenCalledOnce()
    expect(autonomy.claimTasks.mock.calls[0]?.[1]).toEqual(['code', 'docs'])
    expect(results).toEqual([
      {
        taskId: 'code',
        role: 'developer',
        childSessionId: 'task-child-0',
        status: 'completed',
        summary: 'code done',
        evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'tests passed' }],
      },
      {
        taskId: 'docs',
        role: 'writer',
        childSessionId: 'task-child-1',
        status: 'blocked',
        summary: 'needs product decision',
        evidence: [],
      },
    ])
    expect(autonomy.updateTask.mock.calls).toEqual([
      [expect.anything(), 'code', 'complete', {
        evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'tests passed' }],
      }],
      [expect.anything(), 'docs', 'block', { reason: 'needs product decision' }],
    ])
    expect(provider.disposed.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
    expect(provider.requests[0]).toMatchObject({
      label: 'autopilot-code',
      maxDepth: 1,
      persona: expect.stringContaining('Autopilot developer worker'),
      outputSchema: { type: 'object', additionalProperties: false },
      toolFilter: { allow: [] },
    })
    const prompt = provider.requests[0]?.prompt[0]
    expect(prompt?.type === 'text' ? prompt.text : '').toContain('<task_data>')
    expect(delegationJson(results)).toEqual(results.map(result => ({
      taskId: result.taskId,
      role: result.role,
      childSessionId: result.childSessionId,
      status: result.status,
      summary: result.summary,
      evidence: result.evidence.map(item => ({ ...item })),
    })))
  })

  it('dispatches through the host-owned managed start wrapper when provided', async () => {
    const ctx = await orchestratorContext()
    const autonomy = installAutonomy(ctx, plan(['code']))
    const provider = new StubTaskProvider('spawn', () => run('managed-child', completed()))
    ctx.subagents.registerProvider(provider)
    const managedStart = vi.fn(ctx.subagents.start.bind(ctx.subagents))

    const [result] = await delegateTaskBatch(ctx, delegationRequest(
      createTestAgent(),
      [assignment('code')],
      [],
      new AbortController().signal,
      managedStart,
    ))

    expect(managedStart).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ taskId: 'code', childSessionId: 'managed-child', status: 'completed' })
    expect(autonomy.updateTask).toHaveBeenCalledOnce()
  })

  it('routes subagent transport separately from LLM provider/model and supports partial model routes', async () => {
    const ctx = await orchestratorContext()
    installAutonomy(ctx, plan(['remote', 'provider-only', 'model-only']))
    const spawn = new StubTaskProvider('spawn', request => run(
      `spawn-${request.label ?? 'child'}`,
      completed(),
    ))
    const remote = new StubTaskProvider('remote-transport', () => run('remote-child', completed()))
    ctx.subagents.registerProvider(spawn)
    ctx.subagents.registerProvider(remote)
    const routes: TaskRoute[] = [
      {
        role: ' remote-role ',
        subagentProvider: ' remote-transport ',
        provider: ' deepseek ',
        model: ' v4 ',
        persona: ' custom worker ',
      },
      { role: 'provider-role', provider: 'other-provider' },
      { role: 'model-role', model: 'other-model' },
    ]
    await delegateTaskBatch(ctx, delegationRequest(createTestAgent(), [
      assignment('remote', 'remote-role'),
      assignment('provider-only', 'provider-role'),
      assignment('model-only', 'model-role'),
    ], routes))

    expect(remote.requests).toHaveLength(1)
    expect(remote.requests[0]).toMatchObject({
      agentOptions: { provider: 'deepseek', model: 'v4' },
      persona: 'custom worker',
    })
    expect(spawn.requests).toHaveLength(2)
    expect(spawn.requests[0]?.agentOptions).toEqual({ provider: 'other-provider' })
    expect(spawn.requests[1]?.agentOptions).toEqual({ model: 'other-model' })
  })

  it('passes only deployment-allowed live tools to managed workers', async () => {
    const ctx = await orchestratorContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    for (const name of ['bash', 'custom_orchestrator']) {
      ctx.tools.register(defineContentToolFixture({
        name,
        description: name,
        parameters: {},
        async execute() { return [{ type: 'text', text: 'ok' }] },
      }))
    }
    installAutonomy(ctx, plan(['safe']))
    const provider = new StubTaskProvider('spawn', () => run('safe-child', completed()))
    ctx.subagents.registerProvider(provider)

    await delegateTaskBatch(ctx, {
      ...delegationRequest(createTestAgent(), [assignment('safe')]),
      toolAllowlist: ['bash'],
    })

    expect(provider.requests[0]?.toolFilter).toEqual({ allow: ['bash'] })
  })

  it('falls back only after infrastructure failure and charges every additional child attempt', async () => {
    const ctx = await orchestratorContext()
    const autonomy = installAutonomy(ctx, plan(['recover']))
    const primary = new StubTaskProvider('primary', () => { throw new Error('adapter unavailable') })
    const secondary = new StubTaskProvider('secondary', () => run('secondary-child', completed()))
    ctx.subagents.registerProvider(primary)
    ctx.subagents.registerProvider(secondary)

    const results = await delegateTaskBatch(ctx, delegationRequest(createTestAgent(), [
      assignment('recover', 'builder'),
    ], [{
      role: 'builder',
      subagentProvider: 'primary',
      provider: 'primary-llm',
      fallbacks: [{ subagentProvider: 'secondary', provider: 'secondary-llm', model: 'fallback-v1' }],
    }]))

    expect(primary.requests).toHaveLength(1)
    expect(secondary.requests).toHaveLength(1)
    expect(secondary.requests[0]?.agentOptions).toEqual({ provider: 'secondary-llm', model: 'fallback-v1' })
    expect(autonomy.recordSubagentStarts).toHaveBeenCalledOnce()
    expect(autonomy.recordSubagentStarts).toHaveBeenCalledWith(expect.anything(), 1)
    expect(results).toMatchObject([{
      status: 'completed',
      childSessionId: 'secondary-child',
      summary: expect.stringContaining('previous route failures: worker failed to start: adapter unavailable'),
    }])
  })

  it('orders equivalent deployment routes by cost only in economy mode', async () => {
    const economy = await orchestratorContext()
    const economyAutonomy = installAutonomy(economy, plan(['economy']))
    const provider = new StubTaskProvider('spawn', request => run(
      `child-${request.agentOptions?.model ?? 'inherited'}`,
      completed(),
    ))
    economy.subagents.registerProvider(provider)
    const routes: TaskRoute[] = [{
      role: 'builder',
      subagentProvider: 'spawn',
      model: 'quality-model',
      costWeight: 100,
      fallbacks: [{ subagentProvider: 'spawn', model: 'economy-model', costWeight: 10 }],
    }]

    await delegateTaskBatch(economy, {
      ...delegationRequest(createTestAgent(), [assignment('economy', 'builder')], routes),
      routingPreference: 'economy',
    })
    expect(provider.requests[0]?.agentOptions).toEqual({ model: 'economy-model' })
    expect(economyAutonomy.recordSubagentStarts).not.toHaveBeenCalled()

    const declared = await orchestratorContext()
    installAutonomy(declared, plan(['declared']))
    const declaredProvider = new StubTaskProvider('spawn', request => run(
      `child-${request.agentOptions?.model ?? 'inherited'}`,
      completed(),
    ))
    declared.subagents.registerProvider(declaredProvider)
    await delegateTaskBatch(declared, delegationRequest(
      createTestAgent(),
      [assignment('declared', 'builder')],
      routes,
    ))
    expect(declaredProvider.requests[0]?.agentOptions).toEqual({ model: 'quality-model' })

    const unweighted = await orchestratorContext()
    installAutonomy(unweighted, plan(['unweighted']))
    const unweightedProvider = new StubTaskProvider('spawn', request => run(
      `child-${request.agentOptions?.model ?? 'inherited'}`,
      completed(),
    ))
    unweighted.subagents.registerProvider(unweightedProvider)
    await delegateTaskBatch(unweighted, {
      ...delegationRequest(createTestAgent(), [assignment('unweighted', 'builder')], [{
        role: 'builder', model: 'first', fallbacks: [{ model: 'second' }],
      }]),
      routingPreference: 'economy',
    })
    expect(unweightedProvider.requests[0]?.agentOptions).toEqual({ model: 'first' })
  })

  it('does not route around semantic failure, refusal, abort, or fallback budget denial', async () => {
    const semantic = await orchestratorContext()
    const semanticAutonomy = installAutonomy(semantic, plan(['semantic']))
    const primary = new StubTaskProvider('primary', () => run('semantic-child', completed('failed', 'implementation defect', [])))
    const secondary = new StubTaskProvider('secondary', () => run('unused', completed()))
    semantic.subagents.registerProvider(primary)
    semantic.subagents.registerProvider(secondary)
    await expect(delegateTaskBatch(semantic, delegationRequest(createTestAgent(), [
      assignment('semantic', 'builder'),
    ], [{ role: 'builder', subagentProvider: 'primary', fallbacks: [{ subagentProvider: 'secondary' }] }])))
      .resolves.toMatchObject([{ status: 'failed', summary: 'implementation defect' }])
    expect(secondary.requests).toHaveLength(0)
    expect(semanticAutonomy.recordSubagentStarts).not.toHaveBeenCalled()

    const denied = await orchestratorContext()
    const deniedAutonomy = installAutonomy(denied, plan(['denied']))
    deniedAutonomy.recordSubagentStarts.mockRejectedValueOnce(new Error('subagent budget exhausted'))
    const unavailable = new StubTaskProvider('unavailable', () => { throw new Error('provider offline') })
    const forbidden = new StubTaskProvider('forbidden', () => run('unused', completed()))
    denied.subagents.registerProvider(unavailable)
    denied.subagents.registerProvider(forbidden)
    await expect(delegateTaskBatch(denied, delegationRequest(createTestAgent(), [
      assignment('denied', 'builder'),
    ], [{ role: 'builder', subagentProvider: 'unavailable', fallbacks: [{ subagentProvider: 'forbidden' }] }])))
      .resolves.toMatchObject([{
        status: 'failed',
        summary: expect.stringContaining('fallback budget denied'),
      }])
    expect(forbidden.requests).toHaveLength(0)

    const aborted = await orchestratorContext()
    installAutonomy(aborted, plan(['aborted']))
    const controller = new AbortController()
    controller.abort()
    const abortedPrimary = new StubTaskProvider('aborted-primary', () => { throw new Error('cancelled') })
    const abortedSecondary = new StubTaskProvider('aborted-secondary', () => run('unused', completed()))
    aborted.subagents.registerProvider(abortedPrimary)
    aborted.subagents.registerProvider(abortedSecondary)
    await expect(delegateTaskBatch(aborted, delegationRequest(createTestAgent(), [
      assignment('aborted', 'builder'),
    ], [{
      role: 'builder',
      subagentProvider: 'aborted-primary',
      fallbacks: [{ subagentProvider: 'aborted-secondary' }],
    }], controller.signal))).resolves.toMatchObject([{ status: 'blocked' }])
    expect(abortedSecondary.requests).toHaveLength(0)
  })

  it('contains startup, stop, result, structured-output, and cleanup failures and settles every claimed task', async () => {
    const ctx = await orchestratorContext()
    const ids = ['start', 'refusal', 'stop-error', 'result', 'missing', 'evidence-free', 'cleanup']
    const autonomy = installAutonomy(ctx, plan(ids))
    const cleanup = vi.fn(async () => { throw new Error('cleanup boom') })
    const provider = new StubTaskProvider('spawn', (_request, index) => {
      switch (index) {
        case 0:
          throw new Error('start boom')
        case 1:
          return run('refusal-child', { output: [], stopReason: 'refusal' })
        case 2:
          return run('stop-error-child', { output: [], stopReason: 'error' })
        case 3:
          return run('result-child', Promise.reject(new Error('result boom')))
        case 4:
          return run('missing-child', { output: [], stopReason: 'completed' })
        case 5:
          return run('evidence-free-child', completed('completed', 'claimed done', []))
        default:
          return run('cleanup-child', completed(), cleanup)
      }
    })
    ctx.subagents.registerProvider(provider)
    const results = await delegateTaskBatch(ctx, delegationRequest(
      createTestAgent(),
      ids.map(id => assignment(id)),
    ))

    expect(results.map(result => result.status)).toEqual([
      'failed',
      'blocked',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
    ])
    expect(results.map(result => result.summary)).toEqual([
      'worker failed to start: start boom',
      'worker ended with refusal',
      'worker ended with error',
      'worker execution failed: result boom',
      'worker returned no structured result',
      'worker returned an invalid or evidence-free structured result',
      'done; worker cleanup failed: cleanup boom',
    ])
    expect(autonomy.updateTask).toHaveBeenCalledTimes(ids.length)
    expect(autonomy.updateTask.mock.calls.map(call => call[2])).toEqual([
      'fail', 'block', 'fail', 'fail', 'fail', 'fail', 'fail',
    ])
    expect(cleanup).toHaveBeenCalledOnce()
    const projected = delegationJson(results)
    if (!Array.isArray(projected)) throw new Error('delegation projection must be an array')
    expect(projected[0]).not.toHaveProperty('childSessionId')
  })

  it.each([
    [{ status: 'unknown', summary: 'x', evidence: [] }],
    [{ status: 'failed', summary: '', evidence: [] }],
    [{ status: 'failed', summary: 'x', evidence: null }],
    [{ status: 'failed', summary: 'x', evidence: [null] }],
    [{ status: 'failed', summary: 'x', evidence: [{ kind: 'unknown', ref: 'x', summary: 'x' }] }],
    [{ status: 'failed', summary: 'x', evidence: [{ kind: 'file', ref: '', summary: 'x' }] }],
    [{ status: 'failed', summary: 'x', evidence: [{ kind: 'file', ref: 'x', summary: '' }] }],
  ])('rejects malformed worker structured output %#', async (structured) => {
    const ctx = await orchestratorContext()
    installAutonomy(ctx, plan(['bad']))
    ctx.subagents.registerProvider(new StubTaskProvider('spawn', () => run('bad-child', {
      output: [], stopReason: 'completed', structured,
    })))
    await expect(delegateTaskBatch(ctx, delegationRequest(createTestAgent(), [assignment('bad')])))
      .resolves.toMatchObject([{
        status: 'failed', summary: 'worker returned an invalid or evidence-free structured result',
      }])
  })

  it('maps aborted startup and result failures to blockers and safely renders hostile thrown values', async () => {
    const ctx = await orchestratorContext()
    installAutonomy(ctx, plan(['start', 'result']))
    const controller = new AbortController()
    controller.abort()
    ctx.subagents.registerProvider(new StubTaskProvider('spawn', (_request, index) => {
      if (index === 0) throw 42
      return run('result-child', Promise.reject({ toString: () => { throw new Error('coercion') } }))
    }))
    const results = await delegateTaskBatch(ctx, delegationRequest(
      createTestAgent(),
      [assignment('start'), assignment('result')],
      [],
      controller.signal,
    ))
    expect(results).toMatchObject([
      { status: 'blocked', summary: 'worker failed to start: 42' },
      { status: 'blocked', summary: 'worker execution failed: <unrenderable thrown value>' },
    ])
  })

  it('continues ordered settlement after one durable write fails', async () => {
    const ctx = await orchestratorContext()
    const autonomy = installAutonomy(ctx, plan(['bad-settle', 'good-settle']), {
      settlementErrorTask: 'bad-settle',
      settlementError: { toString: () => { throw new Error('coercion') } },
    })
    ctx.subagents.registerProvider(new StubTaskProvider('spawn', (_request, index) => run(
      `settle-${index}`,
      completed(),
    )))
    const results = await delegateTaskBatch(ctx, delegationRequest(createTestAgent(), [
      assignment('bad-settle'),
      assignment('good-settle'),
    ]))
    expect(results[0]).toMatchObject({
      status: 'failed',
      summary: 'done; durable task settlement failed: <unrenderable thrown value>',
    })
    expect(results[1]).toMatchObject({ status: 'completed' })
    expect(autonomy.updateTask).toHaveBeenCalledTimes(2)
  })

  it('lets the durable claim enforce the concurrency budget before any child starts', async () => {
    const ctx = await orchestratorContext()
    const autonomy = installAutonomy(ctx, plan(['one', 'two', 'three']), {
      claimError: new Error('task batch 3 exceeds concurrency ceiling 2'),
    })
    const provider = new StubTaskProvider('spawn', () => run('unused', completed()))
    ctx.subagents.registerProvider(provider)
    await expect(delegateTaskBatch(ctx, delegationRequest(createTestAgent(), [
      assignment('one'), assignment('two'), assignment('three'),
    ]))).rejects.toThrow('concurrency ceiling 2')
    expect(autonomy.claimTasks).toHaveBeenCalledOnce()
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects invalid assignments and routes before claiming tasks', async () => {
    const ctx = await orchestratorContext()
    const autonomy = installAutonomy(ctx, plan(['one']))
    ctx.subagents.registerProvider(new StubTaskProvider('spawn', () => run('unused', completed())))
    const parent = createTestAgent()

    await expect(delegateTaskBatch(ctx, delegationRequest(parent, [])))
      .rejects.toThrow('at least one task assignment')
    await expect(delegateTaskBatch(ctx, delegationRequest(parent, [assignment('one'), assignment('one')])))
      .rejects.toThrow('only once')
    for (const invalid of [
      { taskId: '', role: 'developer', prompt: 'x' },
      { taskId: 'one', role: '', prompt: 'x' },
      { taskId: 'one', role: 'developer', prompt: '' },
    ]) {
      await expect(delegateTaskBatch(ctx, delegationRequest(parent, [invalid])))
        .rejects.toThrow('must not be empty')
    }
    await expect(delegateTaskBatch(ctx, delegationRequest(parent, [assignment('one')], [
      { role: 'same' }, { role: ' same ' },
    ]))).rejects.toThrow('empty or duplicated')
    await expect(delegateTaskBatch(ctx, delegationRequest(parent, [assignment('one')], [{ role: '' }])))
      .rejects.toThrow('empty or duplicated')
    for (const route of [
      { role: 'developer', subagentProvider: ' ' },
      { role: 'developer', provider: ' ' },
      { role: 'developer', model: ' ' },
      { role: 'developer', persona: ' ' },
      { role: 'developer', fallbacks: [{ subagentProvider: ' ' }] },
      { role: 'developer', fallbacks: [{ provider: ' ' }] },
      { role: 'developer', fallbacks: [{ model: ' ' }] },
      { role: 'developer', fallbacks: [{ persona: ' ' }] },
    ]) {
      await expect(delegateTaskBatch(ctx, delegationRequest(parent, [assignment('one')], [route])))
        .rejects.toThrow('must not be empty when provided')
    }
    for (const route of [
      { role: 'developer', costWeight: 0 },
      { role: 'developer', fallbacks: [{ costWeight: Number.NaN }] },
    ]) {
      await expect(delegateTaskBatch(ctx, delegationRequest(parent, [assignment('one')], [route])))
        .rejects.toThrow('costWeight must be a positive safe integer')
    }
    expect(autonomy.claimTasks).toHaveBeenCalledTimes(0)
  })
})
