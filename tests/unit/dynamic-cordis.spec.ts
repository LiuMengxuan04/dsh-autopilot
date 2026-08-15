import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
} from '@deepseek-ai/dsh-cordis-host-runner'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FORBIDDEN_DYNAMIC_SERVICES,
  DynamicExtensionController,
  dynamicSourceSha256,
  scanDynamicSource,
} from '../../src/dynamic-cordis.ts'
import { createHarness, createTestAgent } from '../helpers.ts'

let callSequence = 0

const HOST_V1 = "return { name: 'leaf-v1', apply() {} }"
const HOST_V2 = "return { name: 'leaf-v2', apply(ctx) { ctx.on('tools/change', () => {}) } }"
const BROKEN_HOST = 'throw new Error("broken dynamic update")'

/** Execute one registered model tool. */
function executeTool(ctx: Context, agent: Agent, name: string, args: unknown = {}) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`dsh-autopilot-cordis-call-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

/** Authorize a Goal under the requested dynamic Cordis policy. */
async function startAutopilot(ctx: Context, agent: Agent): Promise<void> {
  const goal = ctx.goals.create(agent, { objective: 'exercise dynamic Cordis', maxGoalRounds: 8 })
  await ctx.autonomy.start(agent, { goalId: goal.id })
}

/** Apply one immutable wrapper-owned Host extension. */
function applyExtension(
  ctx: Context,
  agent: Agent,
  hostCode: string,
  name = 'Leaf capability',
) {
  return executeTool(ctx, agent, 'autopilot_cordis_apply', {
    logicalId: 'leaf-capability',
    name,
    purpose: 'Supply one missing leaf capability for the active task.',
    hostCode,
  })
}

/** Trigger the same pre-step recovery hook used by the Agent loop. */
function enterStep(ctx: Context, agent: Agent) {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [],
    turn: 1,
    step: 0,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

/** Register the native Client-bearing Cordis path over the real DSH runner. */
function registerNativeClientTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'cordis_define',
    description: 'native definition fixture',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('agent required')
      const receipt = ctx.dynamicCordisRunner.define({
        sessionId: exec.agent.id,
        plugin: { kind: 'new', idPrefix: 'panel' },
        name: 'Approved panel',
        purpose: 'Exercise the native human approval path.',
        code: { host: HOST_V1, client: 'return () => {}' },
      })
      return Promise.resolve({
        pluginId: String(receipt.pluginId),
        packageId: String(receipt.packageId),
        hasHostHalf: receipt.hasHostHalf,
        hasClientHalf: receipt.hasClientHalf,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'cordis_run',
    description: 'native activation fixture',
    parameters: {
      pluginId: { type: 'string', required: true },
      packageId: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      if (exec.agent === undefined) throw new Error('agent required')
      const result = await ctx.dynamicCordisRunner.run(
        exec.agent,
        CordisDynamicPluginId(args.pluginId),
        CordisDynamicPackageId(args.packageId),
        'run',
        exec.signal,
      )
      return result as unknown as JsonValue
    },
  }))
}

describe('durable Host-only Cordis wrapper', () => {
  it('does nothing when rehydration has no armed durable run', async () => {
    const { ctx, agent } = await createHarness()
    const controller = new DynamicExtensionController(ctx)
    await controller.ensureRehydrated(agent)
    expect(controller.list(agent)).toEqual([])
    await expect(controller.remove(agent, 'missing-leaf', 'nothing to remove'))
      .rejects.toThrow(/Autopilot run|dynamic extension/iu)
  })

  it('defines, activates, inspects, audits, and updates immutable Host versions', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const first = await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')
    expect(first).toMatchObject({
      isError: false,
      value: {
        logicalId: 'leaf-capability', version: 1, status: 'running', recovered: false,
      },
    })
    const firstValue = first.value as { pluginId: string; packageId: string }
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      pluginId: firstValue.pluginId,
      currentPackageId: firstValue.packageId,
      activeRun: { packageId: firstValue.packageId },
    }])
    expect(ctx.autonomy.get(agent)).toMatchObject({
      dynamicPackages: 1,
      dynamicExtensions: [{ logicalId: 'leaf-capability', version: 1, status: 'active' }],
    })
    await enterStep(ctx, agent)

    const second = await applyExtension(ctx, agent, HOST_V2, 'Leaf v2')
    expect(second).toMatchObject({
      isError: false,
      value: {
        logicalId: 'leaf-capability', version: 2, status: 'running',
        pluginId: firstValue.pluginId,
      },
    })
    const secondValue = second.value as { packageId: string }
    expect(secondValue.packageId).not.toBe(firstValue.packageId)
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      pluginId: firstValue.pluginId,
      currentPackageId: secondValue.packageId,
      activeRun: { packageId: secondValue.packageId },
    }])
    expect(ctx.autonomy.get(agent)?.dynamicExtensions.map(version => [version.version, version.status]))
      .toEqual([[1, 'superseded'], [2, 'active']])
  })

  it('replays the previous active source and records a failed update', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const first = await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')
    expect(first.isError).toBe(false)

    const failed = await applyExtension(ctx, agent, BROKEN_HOST, 'Leaf broken')
    expect(failed).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('broken dynamic update') },
    })
    const inventory = dynamicCordisRunner.snapshot(agent)
    expect(inventory).toHaveLength(1)
    expect(inventory[0]).toMatchObject({
      packages: [{ name: 'Leaf v1' }],
      activeRun: { packageId: inventory[0]?.currentPackageId },
    })
    expect(ctx.autonomy.get(agent)?.dynamicExtensions.map(version => ({
      version: version.version,
      status: version.status,
      reason: version.reason,
    }))).toEqual([
      { version: 1, status: 'active', reason: undefined },
      { version: 2, status: 'failed', reason: expect.stringContaining('broken dynamic update') },
    ])
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
  })

  it('replays the prior runtime when an existing-version runner call rejects', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')).isError).toBe(false)
    vi.spyOn(dynamicCordisRunner, 'run').mockRejectedValueOnce(new Error('update transport failed'))

    expect(await applyExtension(ctx, agent, HOST_V2, 'Leaf v2')).toMatchObject({
      isError: true,
      error: { message: 'update transport failed' },
    })
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      packages: [{ name: 'Leaf v1' }],
      activeRun: { packageId: expect.any(String) },
    }])
  })

  it('replays the prior runtime when an update is missing from inspection', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')).isError).toBe(false)
    vi.spyOn(dynamicCordisRunner, 'snapshot').mockReturnValueOnce([])

    expect(await applyExtension(ctx, agent, HOST_V2, 'Leaf v2')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('inspected active Package') },
    })
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      packages: [{ name: 'Leaf v1' }],
      activeRun: { packageId: expect.any(String) },
    }])
  })

  it('selects the highest active version deterministically during rollback', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')).isError).toBe(false)
    expect((await applyExtension(ctx, agent, HOST_V2, 'Leaf v2')).isError).toBe(false)
    const begin = ctx.autonomy.beginDynamicExtension.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'beginDynamicExtension').mockImplementation(async (...args) => {
      const reserved = await begin(...args)
      const dynamicExtensions = reserved.view.dynamicExtensions.map(extension => extension.version < 3
        ? Object.freeze({ ...extension, status: 'active' as const })
        : extension)
      return Object.freeze({
        extension: reserved.extension,
        view: Object.freeze({ ...reserved.view, dynamicExtensions: Object.freeze(dynamicExtensions) }),
      })
    })

    expect(await applyExtension(ctx, agent, BROKEN_HOST, 'Leaf broken')).toMatchObject({ isError: true })
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      packages: [{ name: 'Leaf v2' }],
      activeRun: { packageId: expect.any(String) },
    }])
  })

  it('persists and reports rollback failure instead of losing the applying version', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')).isError).toBe(false)
    const define = dynamicCordisRunner.define.bind(dynamicCordisRunner)
    let calls = 0
    vi.spyOn(dynamicCordisRunner, 'define').mockImplementation((request) => {
      calls += 1
      if (calls === 2) throw new Error('rollback replay unavailable')
      return define(request)
    })

    const failed = await applyExtension(ctx, agent, BROKEN_HOST, 'Leaf broken')
    expect(failed).toMatchObject({
      isError: true,
      error: { message: expect.stringMatching(/rollback|replay/iu) },
    })
    expect(ctx.autonomy.get(agent)?.dynamicExtensions.at(-1)).toMatchObject({
      version: 2,
      status: 'failed',
      reason: expect.stringMatching(/rollback|replay/iu),
    })
    expect(ctx.autonomy.get(agent)?.activation).toBe('disarmed')
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: {
        lease: {
          reason: expect.stringMatching(/rollback|replay/iu),
          dynamicExtensions: [{ status: 'active' }, { status: 'failed', reason: expect.any(String) }],
        },
      },
    })
  })

  it('reports pause failure alongside rollback failure without losing the failed version record', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1, 'Leaf v1')).isError).toBe(false)
    const define = dynamicCordisRunner.define.bind(dynamicCordisRunner)
    let calls = 0
    vi.spyOn(dynamicCordisRunner, 'define').mockImplementation((request) => {
      calls += 1
      if (calls === 2) throw new Error('rollback replay unavailable')
      return define(request)
    })
    vi.spyOn(ctx.autonomy, 'pause').mockRejectedValueOnce(new Error('pause persistence unavailable'))

    expect(await applyExtension(ctx, agent, BROKEN_HOST, 'Leaf broken')).toMatchObject({
      isError: true,
      error: { message: expect.stringMatching(/rollback failed/iu) },
    })
    expect(ctx.autonomy.get(agent)?.dynamicExtensions.at(-1)).toMatchObject({
      status: 'failed', reason: expect.stringMatching(/rollback failed/iu),
    })
  })

  it('rolls back a failed first version without leaving process-local Cordis state', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await applyExtension(ctx, agent, BROKEN_HOST)).toMatchObject({ isError: true })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
    expect(ctx.autonomy.get(agent)).toMatchObject({
      dynamicPackages: 1,
      dynamicExtensions: [{ version: 1, status: 'failed' }],
    })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { lease: { dynamicExtensions: [{ status: 'failed', reason: expect.any(String) }] } },
    })
    await enterStep(ctx, agent)
  })

  it('retains the original failure when failed-version persistence is unavailable', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    vi.spyOn(ctx.autonomy, 'settleDynamicExtension').mockRejectedValueOnce(new Error('audit store unavailable'))
    expect(await applyExtension(ctx, agent, BROKEN_HOST)).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('broken dynamic update') },
    })
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([{ status: 'applying' }])
  })

  it('contains a runner rejection before the first runtime is published', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    vi.spyOn(dynamicCordisRunner, 'run').mockRejectedValueOnce(new Error('runner transport failed'))

    expect(await applyExtension(ctx, agent, HOST_V1)).toMatchObject({
      isError: true,
      error: { message: 'runner transport failed' },
    })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([
      { version: 1, status: 'failed', reason: 'runner transport failed' },
    ])
  })

  it('normalizes a primitive runner rejection into the durable failure reason', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    vi.spyOn(dynamicCordisRunner, 'run').mockRejectedValueOnce(42)

    expect(await applyExtension(ctx, agent, HOST_V1)).toMatchObject({
      isError: true,
      error: { message: '42' },
    })
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([
      { version: 1, status: 'failed', reason: '42' },
    ])
  })

  it('rejects a Host extension parked on unavailable services', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await applyExtension(
      ctx,
      agent,
      "return { name: 'waiting', inject: ['missingLeafService'], apply() {} }",
    )).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('waiting for unavailable services') },
    })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('rejects an activation that is absent from post-run inspection', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    vi.spyOn(dynamicCordisRunner, 'snapshot').mockReturnValue([])

    expect(await applyExtension(ctx, agent, HOST_V1)).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('inspected active Package') },
    })
    expect(dynamicCordisRunner.inventory()).toEqual([])
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([
      { version: 1, status: 'failed' },
    ])
  })

  it('rejects authority-bearing service references before reserving a version', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await applyExtension(
      ctx,
      agent,
      "return { name: 'bad', inject: ['autonomy'], apply() {} }",
    )).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('forbidden service "autonomy"') },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ dynamicPackages: 0, dynamicExtensions: [] })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('does not misrepresent source lint as isolation against computed service access', () => {
    expect(() => scanDynamicSource(
      "return { apply(ctx) { ctx.get('auto' + 'nomy') } }",
      DEFAULT_FORBIDDEN_DYNAMIC_SERVICES,
    )).not.toThrow()
  })

  it('removes the desired version and retracts the runtime contribution', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1)).isError).toBe(false)
    const removed = await executeTool(ctx, agent, 'autopilot_cordis_remove', {
      logicalId: 'leaf-capability',
      reason: 'the temporary capability is no longer needed',
    })
    expect(removed).toMatchObject({
      isError: false,
      value: { lease: { dynamicExtensions: [{ status: 'removed' }] } },
    })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('fails closed when runtime removal cannot be confirmed', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1)).isError).toBe(false)
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('runner teardown unavailable'))

    expect(await executeTool(ctx, agent, 'autopilot_cordis_remove', {
      logicalId: 'leaf-capability',
      reason: 'remove it',
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('runner teardown unavailable') },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: expect.stringMatching(/paused|needs-attention/u),
      activation: 'disarmed',
    })
  })

  it('reports both runtime-removal and fail-closed persistence failures', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1)).isError).toBe(false)
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('runner teardown unavailable'))
    vi.spyOn(ctx.autonomy, 'settleDynamicExtensionRemoval')
      .mockRejectedValueOnce(new Error('removal audit unavailable'))
    vi.spyOn(ctx.autonomy, 'pause').mockRejectedValueOnce(new Error('pause store unavailable'))

    expect(await executeTool(ctx, agent, 'autopilot_cordis_remove', {
      logicalId: 'leaf-capability', reason: 'remove it',
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('dynamic extension removal failed') },
    })
  })

  it('awaits lifecycle cleanup when a run pauses', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await applyExtension(ctx, agent, HOST_V1)).isError).toBe(false)
    expect(dynamicCordisRunner.snapshot(agent)).toHaveLength(1)

    await ctx.autonomy.pause(agent, 'operator pause')

    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('keeps cleanup bounded when the Host runner rejects retraction', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const controller = new DynamicExtensionController(ctx)
    const applied = await controller.apply(agent, {
      logicalId: 'direct-leaf',
      name: 'Direct leaf',
      purpose: 'Exercise controller cleanup.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    expect(controller.list(agent)).toMatchObject([{ logicalId: 'direct-leaf', version: 1 }])

    await controller.cleanup(agent, 'different-run')
    expect(controller.list(agent)).toHaveLength(1)
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('cleanup unavailable'))
    await expect(controller.cleanup(agent, applied.runId))
      .rejects.toThrow('failed to retract 1 dynamic extension contribution')
    expect(controller.list(agent)).toHaveLength(1)
    await controller.cleanup(agent, applied.runId)
    expect(controller.list(agent)).toEqual([])
  })

  it('disposes every Agent runtime and aggregates independent teardown failures', async () => {
    const first = await createHarness()
    const secondAgent = createTestAgent('second-dynamic-agent')
    first.ctx.agents.register(secondAgent)
    await startAutopilot(first.ctx, first.agent)
    const secondGoal = first.ctx.goals.create(secondAgent, { objective: 'second dynamic run' })
    await first.ctx.autonomy.start(secondAgent, { goalId: secondGoal.id })
    const controller = new DynamicExtensionController(first.ctx)
    await controller.apply(first.agent, {
      logicalId: 'first-leaf', name: 'First leaf', purpose: 'First dispose target.', hostCode: HOST_V1,
    }, first.ctx.autonomy.signal(first.agent))
    await controller.apply(secondAgent, {
      logicalId: 'second-leaf', name: 'Second leaf', purpose: 'Second dispose target.', hostCode: HOST_V2,
    }, first.ctx.autonomy.signal(secondAgent))
    vi.spyOn(first.dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('first teardown unavailable'))

    await expect(controller.dispose()).rejects.toThrow('failed to dispose dynamic extension controller')
    expect(controller.list(first.agent)).toHaveLength(1)
    expect(controller.list(secondAgent)).toEqual([])
    await controller.dispose()
    expect(controller.list(first.agent)).toEqual([])
  })

  it('fails recovery closed when the durable source hash is inconsistent', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    const actual = ctx.autonomy.get(agent)
    if (actual === undefined) throw new Error('missing run')
    const get = vi.spyOn(ctx.autonomy, 'get').mockReturnValue({
      ...actual,
      dynamicExtensions: [{
        logicalId: 'forged-leaf',
        version: 1,
        name: 'Forged leaf',
        purpose: 'Exercise source audit.',
        hostCode: HOST_V1,
        sourceSha256: '0'.repeat(64),
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const controller = new DynamicExtensionController(ctx)
    await expect(controller.ensureRehydrated(agent)).rejects.toThrow('source hash does not match')
    get.mockRestore()
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('rehydrates active source when process-local runtime state is absent', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const reserved = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf capability',
      purpose: 'Recover an active durable definition.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'leaf-capability', reserved.extension.version, { ok: true })

    await enterStep(ctx, agent)

    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
        packages: [{ name: 'Leaf capability' }],
        activeRun: { packageId: expect.any(String) },
    }])
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([
      { version: 1, status: 'active' },
    ])
  })

  it('adopts an exact active Package after the controller instance is replaced', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const firstController = new DynamicExtensionController(ctx)
    const first = await firstController.apply(agent, {
      logicalId: 'reload-leaf',
      name: 'Reload leaf',
      purpose: 'Survive a controller replacement.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    const replacement = new DynamicExtensionController(ctx)
    const define = vi.spyOn(dynamicCordisRunner, 'define')

    await replacement.ensureRehydrated(agent)

    expect(define).not.toHaveBeenCalled()
    expect(replacement.list(agent)).toMatchObject([{
      pluginId: first.pluginId,
      packageId: first.packageId,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    }])
    expect(dynamicCordisRunner.snapshot(agent)).toHaveLength(1)
  })

  it('ignores inactive Packages and fails closed when multiple active Packages claim one durable version', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const firstController = new DynamicExtensionController(ctx)
    const first = await firstController.apply(agent, {
      logicalId: 'reload-leaf',
      name: 'Reload leaf',
      purpose: 'Detect ambiguous controller replacement.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    const inspected = dynamicCordisRunner.inspectPackage(
      agent,
      CordisDynamicPluginId(first.pluginId),
      CordisDynamicPackageId(first.packageId),
    )
    const hostCode = inspected.code.host
    if (hostCode === undefined) throw new Error('test Host Package lost its source')
    dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'idle' },
      name: inspected.name,
      purpose: inspected.purpose,
      code: { host: hostCode },
    })
    const duplicate = dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'dupe' },
      name: inspected.name,
      purpose: inspected.purpose,
      code: { host: hostCode },
    })
    await dynamicCordisRunner.run(
      agent,
      duplicate.pluginId,
      duplicate.packageId,
      'run',
      ctx.autonomy.signal(agent),
    )
    const replacement = new DynamicExtensionController(ctx)

    await expect(replacement.ensureRehydrated(agent)).rejects.toThrow('multiple active Host Plugins')

    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('finds and retracts a marked Package when the replacement controller has no runtime map', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const firstController = new DynamicExtensionController(ctx)
    await firstController.apply(agent, {
      logicalId: 'reload-leaf',
      name: 'Reload leaf',
      purpose: 'Remove after a controller replacement.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    const replacement = new DynamicExtensionController(ctx)

    await replacement.remove(agent, 'reload-leaf', 'no longer required')

    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([{ status: 'removed' }])
  })

  it('cleans marked Packages after a controller replacement without adopting them first', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const firstController = new DynamicExtensionController(ctx)
    const applied = await firstController.apply(agent, {
      logicalId: 'reload-leaf',
      name: 'Reload leaf',
      purpose: 'Clean after a controller replacement.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    const replacement = new DynamicExtensionController(ctx)

    await replacement.cleanup(agent, applied.runId)

    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('cleans an untracked marked Plugin before a mapped sibling runtime', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const untracked = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'untracked-leaf',
      name: 'Untracked leaf',
      purpose: 'Exist before the replacement map is populated.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'untracked-leaf', untracked.extension.version, { ok: true })
    const receipt = dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'old' },
      name: untracked.extension.name,
      purpose: `${untracked.extension.purpose}\n[dsh-autopilot:${untracked.view.id}:untracked-leaf:1:${untracked.extension.sourceSha256}]`,
      code: { host: untracked.extension.hostCode },
    })
    await dynamicCordisRunner.run(agent, receipt.pluginId, receipt.packageId, 'run', ctx.autonomy.signal(agent))
    const replacement = new DynamicExtensionController(ctx)
    await replacement.apply(agent, {
      logicalId: 'mapped-leaf',
      name: 'Mapped leaf',
      purpose: 'Populate only the replacement runtime map.',
      hostCode: HOST_V2,
    }, ctx.autonomy.signal(agent))

    await replacement.cleanup(agent, untracked.view.id)

    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('removes durable desired state before rehydration when no runtime exists', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const reserved = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf capability',
      purpose: 'Remove before process-local replay.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'leaf-capability', reserved.extension.version, { ok: true })
    expect(await executeTool(ctx, agent, 'autopilot_cordis_remove', {
      logicalId: 'leaf-capability', reason: 'remove before replay',
    })).toMatchObject({ isError: false, value: { lease: { dynamicExtensions: [{ status: 'removed' }] } } })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('finishes a durable removal interrupted before process-local rehydration', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const reserved = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf capability',
      purpose: 'Recover an interrupted removal.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'leaf-capability', reserved.extension.version, { ok: true })
    await ctx.autonomy.beginDynamicExtensionRemoval(agent, 'leaf-capability', 'cleanup interrupted')

    await enterStep(ctx, agent)

    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([{ status: 'removed' }])
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('stops rehydration if an interrupted removal concurrently disarms the run', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const reserved = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf capability',
      purpose: 'Exercise rehydration authority loss.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'leaf-capability', reserved.extension.version, { ok: true })
    await ctx.autonomy.beginDynamicExtensionRemoval(agent, 'leaf-capability', 'cleanup interrupted')
    const settle = ctx.autonomy.settleDynamicExtensionRemoval.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'settleDynamicExtensionRemoval').mockImplementation(async (...args) => {
      const view = await settle(...args)
      await ctx.autonomy.pause(agent, 'operator paused during cleanup')
      return view
    })

    await enterStep(ctx, agent)

    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
  })

  it('finishes an interrupted applying version during durable rehydration', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf capability',
      purpose: 'Recover an interrupted definition.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await enterStep(ctx, agent)

    expect(dynamicCordisRunner.snapshot(agent)).toHaveLength(1)
    expect(ctx.autonomy.get(agent)?.dynamicExtensions).toMatchObject([
      { version: 1, status: 'active' },
    ])
  })

  it('settles an applying version whose matching runtime already survived in process', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const controller = new DynamicExtensionController(ctx)
    await controller.apply(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf capability',
      purpose: 'Exercise interrupted settlement.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    const view = ctx.autonomy.get(agent)
    if (view === undefined) throw new Error('missing run')
    const applying = {
      ...view,
      dynamicExtensions: view.dynamicExtensions.map(extension => ({ ...extension, status: 'applying' as const })),
    }
    vi.spyOn(ctx.autonomy, 'get').mockReturnValue(applying)
    const settle = vi.spyOn(ctx.autonomy, 'settleDynamicExtension').mockResolvedValue(applying)
    const define = vi.spyOn(dynamicCordisRunner, 'define')

    await controller.ensureRehydrated(agent)

    expect(settle).toHaveBeenCalledWith(agent, 'leaf-capability', 1, { ok: true })
    expect(define).not.toHaveBeenCalled()
    expect(controller.list(agent)).toMatchObject([{ version: 1, sourceSha256: dynamicSourceSha256(HOST_V1) }])
  })

  it('replaces a stale process runtime when the durable version or source hash advances', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const controller = new DynamicExtensionController(ctx)
    const first = await controller.apply(agent, {
      logicalId: 'leaf-capability',
      name: 'Leaf v1',
      purpose: 'Create stale process state.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    const view = ctx.autonomy.get(agent)
    if (view === undefined) throw new Error('missing run')
    vi.spyOn(ctx.autonomy, 'get').mockReturnValue({
      ...view,
      dynamicExtensions: [{
        logicalId: 'leaf-capability',
        version: 2,
        name: 'Leaf v2',
        purpose: 'Replace stale process state.',
        hostCode: HOST_V2,
        sourceSha256: dynamicSourceSha256(HOST_V2),
        status: 'active',
        createdAt: 2,
        updatedAt: 2,
      }],
    })

    await controller.ensureRehydrated(agent)

    expect(controller.list(agent)).toMatchObject([{
      version: 2,
      sourceSha256: dynamicSourceSha256(HOST_V2),
    }])
    expect(controller.list(agent)[0]?.pluginId).not.toBe(first.pluginId)
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      packages: [{ name: 'Leaf v2' }], activeRun: { packageId: expect.any(String) },
    }])
  })

  it('selects the newest durable candidate regardless of replay order', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    const first = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'ordered-leaf',
      name: 'Ordered leaf v1',
      purpose: 'Create the earlier replay candidate.',
      hostCode: HOST_V1,
      sourceSha256: dynamicSourceSha256(HOST_V1),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'ordered-leaf', first.extension.version, { ok: true })
    await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'ordered-leaf',
      name: 'Ordered leaf v2',
      purpose: 'Create the later replay candidate.',
      hostCode: HOST_V2,
      sourceSha256: dynamicSourceSha256(HOST_V2),
    })
    const view = ctx.autonomy.get(agent)
    if (view === undefined) throw new Error('missing run')
    vi.spyOn(ctx.autonomy, 'get').mockReturnValue({
      ...view,
      dynamicExtensions: [...view.dynamicExtensions].reverse(),
    })
    const controller = new DynamicExtensionController(ctx)

    await controller.ensureRehydrated(agent)

    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      packages: [{ name: 'Ordered leaf v2' }],
      activeRun: { packageId: expect.any(String) },
    }])
  })

  it('keeps sibling runtimes after removing one logical id', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    const controller = new DynamicExtensionController(ctx)
    await controller.apply(agent, {
      logicalId: 'first-leaf',
      name: 'First leaf',
      purpose: 'Exercise sibling runtime retention.',
      hostCode: HOST_V1,
    }, ctx.autonomy.signal(agent))
    await controller.apply(agent, {
      logicalId: 'sibling-leaf',
      name: 'Sibling leaf',
      purpose: 'Remain active while the first leaf is removed.',
      hostCode: HOST_V2,
    }, ctx.autonomy.signal(agent))

    await controller.remove(agent, 'first-leaf', 'first leaf no longer needed')

    expect(controller.list(agent)).toMatchObject([{ logicalId: 'sibling-leaf' }])
    await controller.cleanup(agent, '')
  })

  it('records and pauses when an interrupted applying version cannot recover', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'leaf-capability',
      name: 'Broken leaf',
      purpose: 'Exercise failed recovery.',
      hostCode: BROKEN_HOST,
      sourceSha256: dynamicSourceSha256(BROKEN_HOST),
    })
    await expect(enterStep(ctx, agent)).rejects.toThrow('dynamic extension recovery failed')

    expect(dynamicCordisRunner.snapshot(agent)).toEqual([])
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused',
      activation: 'disarmed',
      dynamicExtensions: [{ version: 1, status: 'failed', reason: expect.stringContaining('recovery failed') }],
    })
  })
})

describe('native Client-approved Cordis path', () => {
  it('leaves DSH human approval intact instead of treating Client code as Host-only', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerNativeClientTools(ctx)
    await startAutopilot(ctx, agent)
    const defined = await executeTool(ctx, agent, 'cordis_define')
    expect(defined).toMatchObject({ isError: false, value: { hasClientHalf: true } })
    const reference = defined.value as { pluginId: string; packageId: string }
    const run = await executeTool(ctx, agent, 'cordis_run', reference)

    expect(run).toMatchObject({
      isError: false,
      value: {
        ok: true,
        status: 'awaiting-approval',
        pluginId: reference.pluginId,
        packageId: reference.packageId,
      },
    })
    expect(dynamicCordisRunner.snapshot(agent)).toMatchObject([{
      pluginId: reference.pluginId,
      latestRun: { status: 'awaiting-approval', requiresApproval: true },
    }])
    expect(ctx.autonomy.get(agent)).toMatchObject({ dynamicPackages: 1, activation: 'armed' })
  })
})
