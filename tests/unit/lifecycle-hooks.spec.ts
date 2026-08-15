import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import AutopilotLifecycleHookService, {
  DEFAULT_LIFECYCLE_HANDLER_TIMEOUT_MS,
  DEFAULT_MAX_LIFECYCLE_HANDLERS,
  MAX_LIFECYCLE_HANDLER_TIMEOUT_MS,
  MAX_LIFECYCLE_HANDLERS,
  resolveAutopilotLifecycleHookConfig,
} from '../../src/lifecycle-hooks.ts'
import type {
  AutopilotAfterToolHookEvent,
  AutopilotLifecycleHookConfig,
  AutopilotLifecycleHookName,
} from '../../src/lifecycle-hooks.ts'
import { createServiceHarness } from '../helpers.ts'

let callSequence = 0

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function setup(config: AutopilotLifecycleHookConfig = {}) {
  const base = await createServiceHarness()
  await base.ctx.plugin(SystemPrompt)
  await base.ctx.plugin(ToolRuntime)
  const fiber = await base.ctx.plugin(AutopilotLifecycleHookService, config)
  await vi.waitFor(() => expect(base.ctx.autopilotLifecycleHooks).toBeDefined())
  return { ...base, fiber, service: base.ctx.autopilotLifecycleHooks }
}

async function activate(harness: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const goal = harness.ctx.goals.create(harness.agent, { objective: 'exercise lifecycle hooks' })
  await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
}

function registerTool(
  ctx: Context,
  name: string,
  execute: (args: unknown, exec: ToolRunContext) => JsonValue | Promise<JsonValue> = args => args as JsonValue,
): void {
  ctx.tools.register(defineTool({
    name,
    description: `test ${name}`,
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return execute(args, exec)
    },
  }))
}

function executeTool(ctx: Context, agent: Agent, name: string, args: unknown = {}) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`lifecycle-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

function enterStep(ctx: Context, agent: Agent, turn = 1, step = 1) {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [],
    turn,
    step,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

async function stopTurn(ctx: Context, agent: Agent, turn = 1): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/turn-stopping', {
    turn,
    signal: new AbortController().signal,
  })
}

describe('lifecycle hook configuration', () => {
  it('materializes defaults and accepts deployment-owned limits', () => {
    expect(resolveAutopilotLifecycleHookConfig({})).toEqual({
      maxHandlers: DEFAULT_MAX_LIFECYCLE_HANDLERS,
      handlerTimeoutMs: DEFAULT_LIFECYCLE_HANDLER_TIMEOUT_MS,
      beforeToolFailurePolicy: 'deny',
    })
    expect(resolveAutopilotLifecycleHookConfig({
      maxHandlers: MAX_LIFECYCLE_HANDLERS,
      handlerTimeoutMs: MAX_LIFECYCLE_HANDLER_TIMEOUT_MS,
      beforeToolFailurePolicy: 'continue',
    })).toEqual({
      maxHandlers: MAX_LIFECYCLE_HANDLERS,
      handlerTimeoutMs: MAX_LIFECYCLE_HANDLER_TIMEOUT_MS,
      beforeToolFailurePolicy: 'continue',
    })
  })

  it.each([
    [{ maxHandlers: 0 }, 'maxHandlers'],
    [{ maxHandlers: 1.5 }, 'maxHandlers'],
    [{ maxHandlers: MAX_LIFECYCLE_HANDLERS + 1 }, 'maxHandlers'],
    [{ handlerTimeoutMs: 0 }, 'handlerTimeoutMs'],
    [{ handlerTimeoutMs: Number.MAX_SAFE_INTEGER + 1 }, 'handlerTimeoutMs'],
    [{ handlerTimeoutMs: MAX_LIFECYCLE_HANDLER_TIMEOUT_MS + 1 }, 'handlerTimeoutMs'],
  ] as const)('rejects invalid limits %j', (config, field) => {
    expect(() => resolveAutopilotLifecycleHookConfig(config)).toThrow(field)
  })
})

describe('typed lifecycle bridges', () => {
  it('observes every supported point with authority-free immutable summaries', async () => {
    const harness = await setup()
    const seen: Array<{ hook: AutopilotLifecycleHookName; event: object; aborted: boolean }> = []
    const hooks: readonly AutopilotLifecycleHookName[] = [
      'run-mutation',
      'session-start',
      'pre-step',
      'before-tool',
      'after-tool',
      'turn-stopping',
      'agent-error',
    ]
    for (const hook of hooks) {
      harness.service.register(hook, `observe:${hook}`, ((event: object, context: { signal: AbortSignal }) => {
        seen.push({ hook, event, aborted: context.signal.aborted })
      }) as never)
    }
    registerTool(harness.ctx, 'summary', (_args, exec) => {
      exec.concludeTurn()
      return { ok: true }
    })

    await activate(harness)
    await enterStep(harness.ctx, harness.agent, 2, 3)
    const result = await executeTool(harness.ctx, harness.agent, 'summary', { nested: { value: 1 } })
    expect(result.isError).toBe(false)
    await stopTurn(harness.ctx, harness.agent, 2)
    agentEvents(harness.ctx, harness.agent).emit('agent/session-start', { source: 'compact' })
    await harness.service.whenIdle()

    expect(seen.map(item => item.hook)).toEqual(expect.arrayContaining(
      hooks.filter(hook => hook !== 'agent-error'),
    ))
    expect(seen.every(item => Object.isFrozen(item.event))).toBe(true)
    expect(seen.every(item => !('agent' in item.event))).toBe(true)
    expect(seen.every(item => item.aborted === false)).toBe(true)
    expect(seen.find(item => item.hook === 'session-start')?.event).toMatchObject({ source: 'compact' })
    expect(seen.find(item => item.hook === 'pre-step')?.event).toMatchObject({ turn: 2, step: 3, messageCount: 0 })
    expect(seen.find(item => item.hook === 'before-tool')?.event).toMatchObject({
      name: 'summary', nested: false, arguments: { nested: { value: 1 } },
    })
    expect(seen.find(item => item.hook === 'after-tool')?.event).toMatchObject({
      name: 'summary', nested: false, isError: false, contentBlocks: 1, concludesTurn: true,
    })
  })

  it('skips Agent and tool points outside an armed running or verifying lease', async () => {
    const harness = await setup()
    const observed = vi.fn()
    for (const hook of [
      'session-start', 'pre-step', 'before-tool', 'after-tool', 'turn-stopping', 'agent-error',
    ] as const) {
      harness.service.register(hook, `inactive:${hook}`, observed)
    }
    registerTool(harness.ctx, 'inactive', () => ({ ok: true }))

    agentEvents(harness.ctx, harness.agent).emit('agent/session-start', { source: 'startup' })
    await enterStep(harness.ctx, harness.agent)
    await executeTool(harness.ctx, harness.agent, 'inactive')
    callSequence += 1
    await harness.ctx.tools.execute({
      callId: CallId(`lifecycle-subjectless-${callSequence}`),
      name: 'inactive',
      arguments: {},
      signal: new AbortController().signal,
    })
    await stopTurn(harness.ctx, harness.agent)
    agentEvents(harness.ctx, harness.agent).emit('agent/error', { turn: 1, step: 1, error: 'idle' })
    await harness.service.whenIdle()
    expect(observed).not.toHaveBeenCalled()

    await activate(harness)
    await harness.ctx.autonomy.pause(harness.agent, 'operator pause')
    await enterStep(harness.ctx, harness.agent)
    await executeTool(harness.ctx, harness.agent, 'inactive')
    await stopTurn(harness.ctx, harness.agent)
    await harness.service.whenIdle()
    expect(observed).not.toHaveBeenCalled()
  })

  it('accepts verifying leases and rejects an armed non-active phase', async () => {
    const harness = await setup()
    await activate(harness)
    const current = harness.ctx.autonomy.get(harness.agent)
    if (current === undefined) throw new Error('active test lease unavailable')
    const observed = vi.fn()
    harness.service.register('pre-step', 'phase-filter', observed)
    const get = vi.spyOn(harness.ctx.autonomy, 'get')
    get.mockReturnValue({ ...current, phase: 'verifying', activation: 'armed' })
    await enterStep(harness.ctx, harness.agent)
    expect(observed).toHaveBeenCalledOnce()
    get.mockReturnValue({ ...current, phase: 'paused', activation: 'armed' })
    await enterStep(harness.ctx, harness.agent)
    expect(observed).toHaveBeenCalledOnce()
    get.mockRestore()
  })

  it('reports terminal run mutations and normalizes non-Error failures', async () => {
    const harness = await setup()
    const mutations: object[] = []
    const errors: object[] = []
    harness.service.register('run-mutation', 'mutation', event => void mutations.push(event))
    harness.service.register('agent-error', 'error', event => void errors.push(event))
    await activate(harness)
    agentEvents(harness.ctx, harness.agent).emit('agent/error', { turn: 4, step: 5, error: 'plain failure' })
    await harness.service.whenIdle()
    expect(errors).toContainEqual(expect.objectContaining({ errorName: 'Error', errorMessage: 'plain failure' }))

    await vi.waitFor(() => {
      expect(mutations.some(event => (event as { reason?: string }).reason !== undefined)).toBe(true)
    })
    expect(mutations[0]).toMatchObject({ operation: 'start', phase: 'running', activation: 'disarmed' })
    expect(mutations.at(-1)).toMatchObject({ phase: 'needs-attention' })
  })

  it('preserves Error names and messages in the authority-free failure summary', async () => {
    const harness = await setup()
    const errors: object[] = []
    harness.service.register('agent-error', 'typed-error', event => void errors.push(event))
    await activate(harness)
    agentEvents(harness.ctx, harness.agent).emit('agent/error', {
      turn: 2,
      step: 3,
      error: new TypeError('model failed'),
    })
    await harness.service.whenIdle()
    expect(errors).toEqual([expect.objectContaining({
      turn: 2, step: 3, errorName: 'TypeError', errorMessage: 'model failed',
    })])
  })

  it('summarizes nested and failed tool outcomes without exposing result values', async () => {
    const harness = await setup()
    await activate(harness)
    const after: AutopilotAfterToolHookEvent[] = []
    harness.service.register('after-tool', 'after-summary', event => void after.push(event))
    registerTool(harness.ctx, 'inner-failure', () => { throw new Error('inner failed') })
    registerTool(harness.ctx, 'outer', async (_args, exec) => {
      const inner = await harness.ctx.tools.execute({
        callId: CallId('nested-inner'),
        rootCallId: exec.rootCallId,
        name: 'inner-failure',
        arguments: {},
        agent: harness.agent,
        parent: exec.token,
        signal: exec.signal,
      })
      return { innerFailed: inner.isError }
    })

    await executeTool(harness.ctx, harness.agent, 'outer')
    await harness.service.whenIdle()
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'inner-failure', nested: true, isError: true, concludesTurn: false }),
      expect.objectContaining({ name: 'outer', nested: false, isError: false, concludesTurn: false }),
    ]))
    expect(after.every(event => !('content' in event) && !('value' in event))).toBe(true)
  })
})

describe('registration lifecycle and ordering', () => {
  it('enforces global unique ids, a bounded registry, normalized ids, and stable priority', async () => {
    const harness = await setup({ maxHandlers: 3 })
    await activate(harness)
    const order: string[] = []
    const first = harness.service.register('pre-step', ' first ', () => void order.push('first'), { priority: 1 })
    harness.service.register('pre-step', 'second', () => void order.push('second'), { priority: 1 })
    harness.service.register('pre-step', 'high', () => void order.push('high'), { priority: 2 })
    expect(() => harness.service.register('after-tool', 'first', () => {})).toThrow('already registered')
    expect(() => harness.service.register('pre-step', 'overflow', () => {})).toThrow('3-handler limit')

    await enterStep(harness.ctx, harness.agent)
    expect(order).toEqual(['high', 'first', 'second'])
    await first()
    expect(() => harness.service.register('pre-step', 'priority', () => {}, { priority: 1.5 })).toThrow('safe integer')
    harness.service.register('pre-step', 'replacement', () => void order.push('replacement'), { priority: -1 })
    order.length = 0
    await enterStep(harness.ctx, harness.agent)
    expect(order).toEqual(['high', 'second', 'replacement'])

    expect(() => harness.service.register('pre-step', ' ', () => {})).toThrow('visible characters')
    expect(() => harness.service.register('pre-step', 'x'.repeat(129), () => {})).toThrow('visible characters')
    expect(() => harness.service.register('pre-step', 'bad\nline', () => {})).toThrow('visible characters')
  })

  it('binds registration cleanup to the calling Cordis plugin fiber', async () => {
    const harness = await setup()
    await activate(harness)
    const observed = vi.fn()
    const plugin = Object.assign((ctx: Context) => {
      ctx.autopilotLifecycleHooks.register('pre-step', 'hmr-owned', observed)
    }, { inject: ['autopilotLifecycleHooks'] })
    const fiber = await harness.ctx.plugin(plugin)
    await enterStep(harness.ctx, harness.agent)
    expect(observed).toHaveBeenCalledOnce()

    await fiber.dispose()
    await enterStep(harness.ctx, harness.agent)
    expect(observed).toHaveBeenCalledOnce()
    harness.service.register('pre-step', 'hmr-owned', observed)
  })

  it('aborts and drains one registration before its disposer resolves', async () => {
    const harness = await setup({ handlerTimeoutMs: 60_000 })
    await activate(harness)
    const entered = deferred<AbortSignal>()
    const release = deferred()
    const dispose = harness.service.register('pre-step', 'draining-registration', async (_event, context) => {
      entered.resolve(context.signal)
      await release.promise
    })
    const dispatch = enterStep(harness.ctx, harness.agent)
    const signal = await entered.promise
    const disposed = vi.fn()
    const disposal = dispose().then(disposed)
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(disposed).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([dispatch, disposal])
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('does not start an observational handler removed from an in-flight priority snapshot', async () => {
    const harness = await setup({ handlerTimeoutMs: 60_000 })
    await activate(harness)
    const entered = deferred()
    const release = deferred()
    const skipped = vi.fn()
    harness.service.register('pre-step', 'snapshot-first', async () => {
      entered.resolve()
      await release.promise
    }, { priority: 10 })
    const removeSkipped = harness.service.register('pre-step', 'snapshot-skipped', skipped)
    const dispatch = enterStep(harness.ctx, harness.agent)
    await entered.promise
    await removeSkipped()
    release.resolve()
    await dispatch
    expect(skipped).not.toHaveBeenCalled()
  })

  it('removes bridges, aborts handlers, and drains them during service shutdown', async () => {
    const harness = await setup({ handlerTimeoutMs: 60_000 })
    await activate(harness)
    const entered = deferred<AbortSignal>()
    const release = deferred()
    harness.service.register('turn-stopping', 'shutdown-drain', async (_event, context) => {
      entered.resolve(context.signal)
      await release.promise
    })
    const dispatch = stopTurn(harness.ctx, harness.agent)
    const signal = await entered.promise
    const settled = vi.fn()
    const disposal = harness.fiber.dispose().then(settled)
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(settled).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([dispatch, disposal])
    expect(settled).toHaveBeenCalledOnce()
    expect(() => harness.service.register('pre-step', 'late', () => {})).toThrow('stopping')
  })
})

describe('before-tool policy and failure containment', () => {
  it('folds the first stable denial through the native monotonic tool guard', async () => {
    const harness = await setup()
    await activate(harness)
    const body = vi.fn(() => ({ ok: true }))
    registerTool(harness.ctx, 'dangerous', body)
    harness.ctx.on('tools/pre-execute', async (_exec, next) => {
      await next()
      return { kind: 'allow' }
    })
    const visited: string[] = []
    harness.service.register('before-tool', 'later-denial', () => {
      visited.push('later')
      return { kind: 'deny', reason: 'later reason' }
    })
    harness.service.register('before-tool', 'first-denial', () => {
      visited.push('first')
      return { kind: 'deny', reason: 'policy denied' }
    }, { priority: 10 })

    const result = await executeTool(harness.ctx, harness.agent, 'dangerous')
    expect(result).toMatchObject({ isError: true, error: { message: 'policy denied' } })
    expect(body).not.toHaveBeenCalled()
    expect(visited).toEqual(['first', 'later'])
  })

  it('uses a bounded fallback for an empty denial reason', async () => {
    const harness = await setup()
    await activate(harness)
    registerTool(harness.ctx, 'blank-reason')
    harness.service.register('before-tool', 'blank', () => ({ kind: 'deny', reason: ' ' }))
    const result = await executeTool(harness.ctx, harness.agent, 'blank-reason')
    expect(result).toMatchObject({
      isError: true,
      error: { message: 'Autopilot lifecycle hook "blank" denied this tool call' },
    })
  })

  it('does not start a before-tool handler removed from an in-flight priority snapshot', async () => {
    const harness = await setup({ handlerTimeoutMs: 60_000 })
    await activate(harness)
    registerTool(harness.ctx, 'policy-snapshot', () => ({ ok: true }))
    const entered = deferred()
    const release = deferred()
    const skipped = vi.fn()
    harness.service.register('before-tool', 'policy-first', async () => {
      entered.resolve()
      await release.promise
    }, { priority: 10 })
    const removeSkipped = harness.service.register('before-tool', 'policy-skipped', skipped)
    const execution = executeTool(harness.ctx, harness.agent, 'policy-snapshot')
    await entered.promise
    await removeSkipped()
    release.resolve()
    await expect(execution).resolves.toMatchObject({ isError: false })
    expect(skipped).not.toHaveBeenCalled()
  })

  it('fails closed on a thrown handler and contains the failure', async () => {
    const harness = await setup()
    await activate(harness)
    const warning = vi.spyOn(harness.ctx.logger, 'warn')
    const body = vi.fn()
    registerTool(harness.ctx, 'closed', body)
    harness.service.register('before-tool', 'broken-policy', () => { throw new Error('policy crashed') })
    const result = await executeTool(harness.ctx, harness.agent, 'closed')
    expect(result).toMatchObject({
      isError: true,
      error: { message: 'Autopilot lifecycle hook "broken-policy" failed closed' },
    })
    expect(body).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('policy crashed'))
  })

  it('can continue after handler errors and timeouts without abandoning quiescence', async () => {
    const harness = await setup({ beforeToolFailurePolicy: 'continue', handlerTimeoutMs: 1 })
    await activate(harness)
    const warning = vi.spyOn(harness.ctx.logger, 'warn')
    const body = vi.fn(() => ({ ok: true }))
    const release = deferred()
    registerTool(harness.ctx, 'open', body)
    harness.service.register('before-tool', 'throw-open', () => { throw new Error('open failure') }, { priority: 2 })
    harness.service.register('before-tool', 'timeout-open', () => release.promise, { priority: 1 })

    const result = await executeTool(harness.ctx, harness.agent, 'open')
    expect(result.isError).toBe(false)
    expect(body).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('open failure'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    release.resolve()
    await harness.service.whenIdle()
  })

  it('contains observational errors and timeouts while always delegating pre-step', async () => {
    const harness = await setup({ handlerTimeoutMs: 1 })
    await activate(harness)
    const warning = vi.spyOn(harness.ctx.logger, 'warn')
    const release = deferred()
    const after = vi.fn()
    const hostile = { [Symbol.toPrimitive]() { throw new Error('cannot stringify') } }
    harness.service.register('pre-step', 'hostile-error', () => Promise.reject(hostile), { priority: 3 })
    harness.service.register('pre-step', 'slow-observer', () => release.promise, { priority: 2 })
    harness.service.register('pre-step', 'after-observer', after)

    await expect(enterStep(harness.ctx, harness.agent)).resolves.toMatchObject({ kind: 'enter' })
    expect(after).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('<unprintable thrown value>'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    release.resolve()
    await harness.service.whenIdle()
  })

  it('quarantines a handler that never settles after its timeout', async () => {
    const harness = await setup({ handlerTimeoutMs: 1 })
    await activate(harness)
    const warning = vi.spyOn(harness.ctx.logger, 'warn')
    const calls = vi.fn(() => new Promise<void>(() => {}))
    const dispose = harness.service.register('pre-step', 'never-settles', calls)

    await expect(enterStep(harness.ctx, harness.agent)).resolves.toMatchObject({ kind: 'enter' })
    await expect(harness.service.whenIdle()).resolves.toBeUndefined()
    await expect(dispose()).resolves.toBeUndefined()
    await expect(enterStep(harness.ctx, harness.agent)).resolves.toMatchObject({ kind: 'enter' })
    expect(calls).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    await expect(harness.fiber.dispose()).resolves.toBeUndefined()
  })

  it('does not delete a replacement registration when the disposed predecessor times out', async () => {
    const harness = await setup({ handlerTimeoutMs: 1 })
    await activate(harness)
    const entered = deferred()
    const release = deferred()
    const disposePredecessor = harness.service.register('pre-step', 'replacement-after-timeout', async () => {
      entered.resolve()
      await release.promise
    })
    const dispatch = enterStep(harness.ctx, harness.agent)
    await entered.promise

    const disposal = disposePredecessor()
    const replacement = vi.fn()
    harness.service.register('pre-step', 'replacement-after-timeout', replacement)
    await dispatch
    release.resolve()
    await disposal

    await enterStep(harness.ctx, harness.agent)
    expect(replacement).toHaveBeenCalledOnce()
    await harness.fiber.dispose()
  })

  it('normalizes an unprintable Agent error without breaking the observer bridge', async () => {
    const harness = await setup()
    await activate(harness)
    const errors: object[] = []
    harness.service.register('agent-error', 'normalize-error', event => void errors.push(event))
    const hostile = { [Symbol.toPrimitive]() { throw new Error('cannot stringify') } }
    agentEvents(harness.ctx, harness.agent).emit('agent/error', { turn: 1, step: 1, error: hostile })
    await harness.service.whenIdle()
    expect(errors).toContainEqual(expect.objectContaining({
      errorName: 'Error', errorMessage: '<unprintable thrown value>',
    }))
  })
})
