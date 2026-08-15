import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { describe, expect, it, vi } from 'vitest'
import { ManagedWorkflowService } from '../../src/workflow-service.ts'
import type {
  ManagedWorkflowProfileConfig,
  ManagedWorkflowStart,
} from '../../src/workflow-service.ts'
import { claimManagedWorkflow, prepareManagedWorkflow } from '../../src/workflow-state.ts'
import type { ManagedWorkflowSnapshot } from '../../src/workflow-state.ts'
import { DurableManagedWorkflowStore } from '../../src/workflow-store.ts'
import type { AutonomyLeaseView } from '../../src/service.ts'
import { createServiceHarness, createTestAgent, prepareTestPlan } from '../helpers.ts'

const profile: ManagedWorkflowProfileConfig = {
  id: 'fanout',
  description: 'Fan tasks out and collect exact outcomes.',
  script: 'return { outcomes: [] }',
  whenToUse: 'Several independent DAG tasks are ready.',
  phases: [{ title: 'work', detail: 'Run workers.', provider: 'deepseek', model: 'worker' }],
  subagentProvider: 'spawn',
  maxTotalAgents: 2,
  maxArgsBytes: 1_024,
}

function task(id: string) {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    acceptanceCriteria: [`${id} accepted`],
  }
}

async function setup(options: {
  readonly profiles?: readonly ManagedWorkflowProfileConfig[]
  readonly tasks?: readonly ReturnType<typeof task>[]
  readonly maxSubagents?: number
  readonly maxConcurrentSubagents?: number
} = {}) {
  const harness = await createServiceHarness({
    autonomy: {
      maxSubagents: options.maxSubagents ?? 8,
      maxConcurrentSubagents: options.maxConcurrentSubagents ?? 4,
    },
  })
  const fiber = await harness.ctx.plugin(ManagedWorkflowService, {
    profiles: options.profiles ?? [profile],
  })
  await vi.waitFor(() => expect(harness.ctx.autopilotWorkflows).toBeDefined())
  const goal = harness.ctx.goals.create(harness.agent, { objective: 'exercise managed workflows' })
  await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
  await prepareTestPlan(
    harness.ctx,
    harness.agent,
    ['workflow tasks settle'],
    options.tasks ?? [task('build')],
  )
  return { ...harness, fiber, goal }
}

function result(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    value: {
      outcomes: [{
        taskId: 'build',
        status: 'completed',
        summary: 'built and tested',
        evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
      }],
    },
    stopReason: 'completed',
    agentsStarted: 1,
    ...overrides,
  }
}

function immediateStart(
  outcome: WorkflowResult = result(),
  id = 'engine-run',
): ReturnType<typeof vi.fn<ManagedWorkflowStart>> & {
  readonly dispose: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
} {
  const dispose = vi.fn(async () => {})
  const cancel = vi.fn()
  const start = vi.fn<ManagedWorkflowStart>(request => ({
    id: WorkflowRunId(id),
    meta: request.meta,
    result: Promise.resolve(outcome),
    cancel,
    dispose,
  }))
  return Object.assign(start, { dispose, cancel })
}

function controlledStart(): ReturnType<typeof vi.fn<ManagedWorkflowStart>> & {
  readonly dispose: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
} {
  let resolve: ((value: WorkflowResult) => void) | undefined
  const pending = new Promise<WorkflowResult>((accept) => { resolve = accept })
  const dispose = vi.fn(async () => {})
  const cancel = vi.fn((reason?: string) => {
    resolve?.({ value: null, stopReason: 'cancelled', error: reason ?? 'cancelled', agentsStarted: 0 })
  })
  const start = vi.fn<ManagedWorkflowStart>(request => ({
    id: WorkflowRunId('controlled-run'),
    meta: request.meta,
    result: pending,
    cancel,
    dispose,
  }))
  return Object.assign(start, { dispose, cancel })
}

function storeOf(service: ManagedWorkflowService): DurableManagedWorkflowStore {
  const store = (service as unknown as { store?: DurableManagedWorkflowStore }).store
  if (store === undefined) throw new Error('workflow store unavailable')
  return store
}

interface WorkflowServiceInternals {
  readonly observerTail: Promise<void>
  settleResult(
    parent: Agent,
    entry: { readonly workflowId: string },
    result: WorkflowResult,
  ): Promise<ManagedWorkflowSnapshot>
  applyOutcome(
    parent: Agent,
    workflow: ManagedWorkflowSnapshot,
    outcome: {
      readonly taskId: string
      readonly status: 'completed' | 'blocked' | 'failed'
      readonly summary: string
      readonly evidence: readonly []
    },
  ): Promise<void>
  finishPrestartCancellation(
    parent: Agent,
    entry: { readonly workflowId: string },
  ): Promise<ManagedWorkflowSnapshot>
  markUncertain(parent: Agent, workflow: ManagedWorkflowSnapshot, reason: string): Promise<void>
  requestCancellation(entry: {
    readonly parent: Agent
    readonly workflowId: string
    readonly runId: string
    readonly generation: number
    readonly controller: AbortController
    readonly done: Promise<void>
    resolveDone(): void
    run?: {
      cancel(reason?: string): void
      dispose(): Promise<void>
    }
    cancellation?: Promise<void>
  }, reason: string): Promise<void>
  assertWorkflowRun(workflow: ManagedWorkflowSnapshot, lease: AutonomyLeaseView): void
  assertBudget(
    lease: AutonomyLeaseView,
    profile: unknown,
    taskCount: number,
  ): void
  requireStore(): DurableManagedWorkflowStore
  latest(workflowId: string): ManagedWorkflowSnapshot
  exact(workflow: ManagedWorkflowSnapshot): ManagedWorkflowSnapshot
}

function internals(service: ManagedWorkflowService): WorkflowServiceInternals {
  return service as unknown as WorkflowServiceInternals
}

function current(harness: Awaited<ReturnType<typeof setup>>): ManagedWorkflowSnapshot {
  const rows = harness.ctx.autopilotWorkflows.list(harness.agent)
  const snapshot = rows.at(-1)
  if (snapshot === undefined) throw new Error('workflow snapshot unavailable')
  return snapshot
}

function preparedFor(
  harness: Awaited<ReturnType<typeof setup>>,
  workflowId = '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
): ManagedWorkflowSnapshot {
  const lease = harness.ctx.autonomy.get(harness.agent)
  if (lease === undefined) throw new Error('Autopilot lease unavailable')
  return prepareManagedWorkflow({
    workflowId,
    parentSessionId: String(harness.agent.id),
    runId: lease.id,
    generation: lease.generation,
    goalId: String(lease.goalId),
    maxAuditRecords: lease.maxAuditRecords,
    maxAuditBytes: lease.maxAuditBytes,
    profileId: 'fanout',
    profileSha256: 'a'.repeat(64),
    argsSha256: 'b'.repeat(64),
    taskIds: ['build'],
    maxTotalAgents: 2,
    subagentsStartedBefore: 0,
  }, Date.now())
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error(`${label} timed out`)) }, 10_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

describe('managed workflow service', () => {
  it('uses only the fixed profile, reserves worst-case budget, and settles exact tasks', async () => {
    const harness = await setup()
    const start = immediateStart()
    const snapshot = await harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: ' fanout ',
      taskIds: [' build '],
      args: { focus: 'tests' },
      signal: new AbortController().signal,
      startWorkflow: start,
    })
    expect(snapshot).toMatchObject({
      profileId: 'fanout', phase: 'completed', engineRunId: 'engine-run',
      engineAgentsStarted: 1, settledTaskIds: ['build'],
    })
    expect(start).toHaveBeenCalledOnce()
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      script: profile.script,
      meta: { name: 'fanout', description: profile.description, phases: profile.phases },
      args: { taskIds: ['build'], input: { focus: 'tests' } },
      subagentProvider: 'spawn',
      maxTotalAgents: 2,
    })
    expect(start.mock.calls[0]?.[0].parent).toBe(harness.agent)
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      subagentsStarted: 2,
      plan: { tasks: [{ id: 'build', status: 'completed', evidence: [{ kind: 'test' }] }] },
    })
    expect(start.dispose).toHaveBeenCalledOnce()
    expect(harness.ctx.autopilotWorkflows.history(harness.agent)).toHaveLength(6)
    expect(harness.ctx.autopilotWorkflows.listProfiles()).toEqual([
      expect.objectContaining({ id: 'fanout', maxTotalAgents: 2, maxArgsBytes: 1_024, sha256: expect.any(String) }),
    ])
    await harness.ctx.fiber.dispose()
  })

  it('durably represents partial results, invalid output, engine errors, and cancellation', async () => {
    const partialHarness = await setup({ tasks: [task('build'), task('test')] })
    const partial = await within(partialHarness.ctx.autopilotWorkflows.run(partialHarness.agent, {
      profileId: 'fanout', taskIds: ['build', 'test'], signal: new AbortController().signal,
      startWorkflow: immediateStart(result({
        agentsStarted: 2,
        value: { outcomes: [
          {
            taskId: 'test', status: 'blocked', summary: 'external fixture missing', evidence: [],
          },
          {
            taskId: 'build', status: 'completed', summary: 'done',
            evidence: [{ kind: 'file', ref: 'src/a.ts', summary: 'implemented' }],
          },
        ] },
      })),
    }), 'partial run')
    expect(partial).toMatchObject({ phase: 'partial-failure', reason: expect.stringContaining('test') })
    expect(partialHarness.ctx.autonomy.get(partialHarness.agent)?.plan?.tasks)
      .toMatchObject([{ status: 'completed' }, { status: 'blocked' }])
    await within(partialHarness.ctx.fiber.dispose(), 'partial dispose')

    const invalidHarness = await setup()
    const invalid = await within(invalidHarness.ctx.autopilotWorkflows.run(invalidHarness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(result({ value: { outcomes: [] }, agentsStarted: 0 })),
    }), 'invalid output run')
    expect(invalid).toMatchObject({ phase: 'error', reason: expect.stringContaining('invalid task outcomes') })
    expect(invalidHarness.ctx.autonomy.get(invalidHarness.agent)?.plan?.tasks[0]?.status).toBe('failed')
    await invalidHarness.ctx.fiber.dispose()

    const errorHarness = await setup()
    const errored = await errorHarness.ctx.autopilotWorkflows.run(errorHarness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(result({ value: null, stopReason: 'error', error: 'worker failed', agentsStarted: 1 })),
    })
    expect(errored).toMatchObject({ phase: 'error', reason: 'worker failed' })
    await errorHarness.ctx.fiber.dispose()

    const cancelHarness = await setup()
    const signal = new AbortController()
    const start = controlledStart()
    const run = cancelHarness.ctx.autopilotWorkflows.run(cancelHarness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: signal.signal, startWorkflow: start,
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    signal.abort('operator stopped this tool call')
    await expect(run).resolves.toMatchObject({ phase: 'cancelled', reason: 'operator stopped this tool call' })
    expect(cancelHarness.ctx.autonomy.get(cancelHarness.agent)?.plan?.tasks[0]?.status).toBe('blocked')
    expect(start.cancel).toHaveBeenCalled()
    await cancelHarness.ctx.fiber.dispose()
  })

  it('cancels and disposes a live run when Autopilot pauses without completing the Goal', async () => {
    const harness = await setup()
    const start = controlledStart()
    const running = harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal, startWorkflow: start,
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const [paused, workflow] = await within(Promise.all([
      harness.ctx.autonomy.pause(harness.agent, 'human paused'),
      running,
    ]), 'pause and workflow cancellation')
    expect(paused.phase).toBe('paused')
    expect(workflow).toMatchObject({ phase: 'cancelled', reason: expect.stringContaining('paused') })
    expect(start.cancel).toHaveBeenCalled()
    expect(start.dispose).toHaveBeenCalled()
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ phase: 'paused', plan: { tasks: [{ status: 'pending' }] } })
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ phase: 'active' })
    await harness.ctx.fiber.dispose()
  })

  it('observes new Agents and resumed runs and reports no workflows without a lease', async () => {
    const harness = await setup()
    const service = harness.ctx.autopilotWorkflows
    const reconcile = vi.spyOn(service, 'reconcile').mockResolvedValue({
      inspected: 0,
      uncertain: 0,
      issues: [],
    })
    const detached = createTestAgent('workflow-detached')
    expect(service.list(detached)).toEqual([])
    const unregister = harness.ctx.agents.register(detached)
    await internals(service).observerTail
    expect(reconcile).toHaveBeenCalledWith(detached)

    await harness.ctx.autonomy.pause(harness.agent, 'exercise resume observer')
    await harness.ctx.autonomy.resume(harness.agent, harness.goal.id)
    expect(reconcile).toHaveBeenCalledWith(harness.agent)
    const logger = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => {})
    reconcile.mockRejectedValueOnce(new Error('observer reconciliation failed'))
    const rejectedAgent = createTestAgent('workflow-rejected-observer')
    const unregisterRejected = harness.ctx.agents.register(rejectedAgent)
    await internals(service).observerTail
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('observer reconciliation failed'))
    unregisterRejected()
    unregister()
    await harness.ctx.fiber.dispose()
  })

  it('cancels, disposes, and drains a live engine when the service is disposed', async () => {
    const harness = await setup()
    let resolveResult: ((value: WorkflowResult) => void) | undefined
    const pending = new Promise<WorkflowResult>((resolve) => { resolveResult = resolve })
    const cancel = vi.fn()
    const dispose = vi.fn(async () => {})
    const start = vi.fn<ManagedWorkflowStart>(request => ({
      id: WorkflowRunId('dispose-run'),
      meta: request.meta,
      result: pending,
      cancel,
      dispose,
    }))
    const running = harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal, startWorkflow: start,
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const disposing = harness.fiber.dispose()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    resolveResult?.({
      value: null,
      stopReason: 'cancelled',
      error: 'service disposed',
      agentsStarted: 0,
    })
    await expect(running).resolves.toMatchObject({ phase: 'cancelled' })
    await disposing
    expect(dispose).toHaveBeenCalled()
    await harness.ctx.fiber.dispose()
  })

  it('rejects a second workflow while the exact run generation is already owned', async () => {
    const harness = await setup()
    const controller = new AbortController()
    const start = controlledStart()
    const running = harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: controller.signal, startWorkflow: start,
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    await expect(within(harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    }), 'second workflow conflict')).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_CONFLICT' })
    controller.abort('conflict test complete')
    await within(running, 'first workflow cleanup')
    await harness.ctx.fiber.dispose()
  })

  it('settles cancellation before task claim and before an engine is published', async () => {
    const harness = await setup()
    const controller = new AbortController()
    controller.abort()
    const start = immediateStart()
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: controller.signal, startWorkflow: start,
    })).resolves.toMatchObject({ phase: 'cancelled' })
    expect(start).not.toHaveBeenCalled()
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]?.status).toBe('pending')
    await harness.ctx.fiber.dispose()

    const afterClaim = await setup()
    const afterClaimController = new AbortController()
    const afterClaimStart = immediateStart()
    const afterClaimStore = storeOf(afterClaim.ctx.autopilotWorkflows)
    const appendAfterClaim = afterClaimStore.appendIfCurrent.bind(afterClaimStore)
    vi.spyOn(afterClaimStore, 'appendIfCurrent').mockImplementation(async (operation, expected, snapshot) => {
      const persisted = await appendAfterClaim(operation, expected, snapshot)
      if (operation === 'claim') afterClaimController.abort('cancel after the durable claim')
      return persisted
    })
    await expect(afterClaim.ctx.autopilotWorkflows.run(afterClaim.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: afterClaimController.signal,
      startWorkflow: afterClaimStart,
    })).resolves.toMatchObject({ phase: 'cancelled', reason: 'cancel after the durable claim' })
    expect(afterClaimStart).not.toHaveBeenCalled()
    expect(afterClaim.ctx.autonomy.get(afterClaim.agent)?.plan?.tasks[0]?.status).toBe('blocked')
    await afterClaim.ctx.fiber.dispose()

    const directClaim = await setup()
    const directIntent = preparedFor(directClaim, 'b6a8e448-5797-4df1-94bd-833cc5872748')
    const directStore = storeOf(directClaim.ctx.autopilotWorkflows)
    await directStore.create(directIntent)
    const claimedLease = await directClaim.ctx.autonomy.claimTasks(directClaim.agent, directIntent.taskIds)
    const directClaimed = claimManagedWorkflow(directIntent, claimedLease.revision, Date.now())
    await directStore.appendIfCurrent('claim', directIntent, directClaimed)
    await expect(internals(directClaim.ctx.autopilotWorkflows).finishPrestartCancellation(
      directClaim.agent,
      { workflowId: directIntent.workflowId },
    )).resolves.toMatchObject({
      phase: 'cancelled',
      reason: 'workflow cancelled before engine start',
    })
    expect(directClaim.ctx.autonomy.get(directClaim.agent)?.plan?.tasks[0]?.status).toBe('blocked')
    await directClaim.ctx.fiber.dispose()

    const directPrepared = await setup()
    const preparedIntent = preparedFor(directPrepared, 'd8421374-e7bf-4e46-a3e4-b04db0a79b6d')
    await storeOf(directPrepared.ctx.autopilotWorkflows).create(preparedIntent)
    await expect(internals(directPrepared.ctx.autopilotWorkflows).finishPrestartCancellation(
      directPrepared.agent,
      { workflowId: preparedIntent.workflowId },
    )).resolves.toMatchObject({ phase: 'cancelled' })
    expect(directPrepared.ctx.autonomy.get(directPrepared.agent)?.plan?.tasks[0]?.status).toBe('pending')
    await directPrepared.ctx.fiber.dispose()
  })

  it('fails closed on cold non-terminal state and over-reported engine starts', async () => {
    const cold = await setup()
    const lease = cold.ctx.autonomy.get(cold.agent)!
    const intent = prepareManagedWorkflow({
      workflowId: '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
      parentSessionId: String(cold.agent.id), runId: lease.id, generation: lease.generation,
      goalId: String(lease.goalId), maxAuditRecords: lease.maxAuditRecords, maxAuditBytes: lease.maxAuditBytes,
      profileId: 'fanout', profileSha256: 'a'.repeat(64), argsSha256: 'b'.repeat(64),
      taskIds: ['build'], maxTotalAgents: 2, subagentsStartedBefore: 0,
    }, Date.now())
    await storeOf(cold.ctx.autopilotWorkflows).create(intent)
    await expect(cold.ctx.autopilotWorkflows.run(cold.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_UNCERTAIN' })
    expect(current(cold).phase).toBe('uncertain')
    expect(cold.ctx.autonomy.get(cold.agent)?.phase).toBe('needs-attention')
    await expect(cold.ctx.autopilotWorkflows.reconcile(cold.agent)).resolves.toEqual({
      inspected: 0, uncertain: 0, issues: [],
    })
    await cold.ctx.fiber.dispose()

    const overflow = await setup()
    await expect(overflow.ctx.autopilotWorkflows.run(overflow.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(result({ agentsStarted: 3 })),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_UNCERTAIN' })
    expect(current(overflow).phase).toBe('uncertain')
    expect(overflow.ctx.autonomy.get(overflow.agent)?.phase).toBe('needs-attention')
    await overflow.ctx.fiber.dispose()
  })

  it('reports reconciliation persistence failures without restarting fixed scripts', async () => {
    const harness = await setup()
    const intent = preparedFor(harness)
    const store = storeOf(harness.ctx.autopilotWorkflows)
    await store.create(intent)
    const append = store.appendIfCurrent.bind(store)
    const appendSpy = vi.spyOn(store, 'appendIfCurrent').mockImplementation((operation, expected, snapshot) =>
      operation === 'uncertain'
        ? Promise.reject(new Error('uncertain ledger unavailable'))
        : append(operation, expected, snapshot))
    await expect(harness.ctx.autopilotWorkflows.reconcile(harness.agent)).resolves.toMatchObject({
      inspected: 1,
      uncertain: 0,
      issues: [expect.stringContaining('reconciliation failed: uncertain ledger unavailable')],
    })
    expect(current(harness).phase).toBe('prepared')
    appendSpy.mockRestore()
    await internals(harness.ctx.autopilotWorkflows).markUncertain(
      createTestAgent('workflow-without-lease'),
      intent,
      'detached parent cannot be resumed',
    )
    expect(current(harness).phase).toBe('uncertain')
    await harness.ctx.fiber.dispose()
  })

  it('enforces exact durable ownership in defensive service operations', async () => {
    const uninitialized = new ManagedWorkflowService(new Context())
    expect(() => internals(uninitialized).requireStore()).toThrow(/not initialized/u)

    const harness = await setup()
    const completed = await harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    })
    await expect(internals(harness.ctx.autopilotWorkflows).settleResult(
      harness.agent,
      { workflowId: completed.workflowId },
      result(),
    )).resolves.toEqual(completed)
    await expect(internals(harness.ctx.autopilotWorkflows).markUncertain(
      harness.agent,
      completed,
      'terminal rows converge',
    )).resolves.toBeUndefined()
    await expect(internals(harness.ctx.autopilotWorkflows).markUncertain(
      harness.agent,
      { ...completed, workflowId: 'missing-workflow' },
      'missing rows converge',
    )).resolves.toBeUndefined()

    const lease = harness.ctx.autonomy.get(harness.agent)
    if (lease === undefined) throw new Error('Autopilot lease unavailable')
    expect(() => internals(harness.ctx.autopilotWorkflows).assertWorkflowRun(
      completed,
      { ...lease, id: 'different-run' },
    )).toThrow(/different Autopilot run generation/u)
    expect(() => internals(harness.ctx.autopilotWorkflows).latest('missing-workflow'))
      .toThrow(/disappeared/u)
    expect(() => internals(harness.ctx.autopilotWorkflows).exact({
      ...completed,
      revision: completed.revision - 1,
    })).toThrow(/changed during an external operation/u)

    const noRun = {
      parent: harness.agent,
      workflowId: 'missing-workflow',
      runId: lease.id,
      generation: lease.generation,
      controller: new AbortController(),
      done: Promise.resolve(),
      resolveDone() {},
    }
    const cancellation = internals(harness.ctx.autopilotWorkflows).requestCancellation(noRun, 'nothing published')
    await expect(cancellation).resolves.toBeUndefined()
    await expect(internals(harness.ctx.autopilotWorkflows).requestCancellation(noRun, 'idempotent'))
      .resolves.toBeUndefined()
    await harness.ctx.fiber.dispose()
  })

  it('preserves cancellation diagnostics and fails closed across defensive workflow races', async () => {
    const engineDiagnostic = await setup()
    const engineIntent = preparedFor(engineDiagnostic, 'f02d011c-6ca2-4c8d-8d7b-7bace094b0ad')
    await storeOf(engineDiagnostic.ctx.autopilotWorkflows).create(engineIntent)
    await engineDiagnostic.ctx.autonomy.pause(engineDiagnostic.agent, 'make the workflow owner inactive')
    await expect(internals(engineDiagnostic.ctx.autopilotWorkflows).settleResult(
      engineDiagnostic.agent,
      { workflowId: engineIntent.workflowId },
      result({ stopReason: 'error', error: 'engine supplied diagnostic', value: null }),
    )).resolves.toMatchObject({ phase: 'cancelled', reason: 'engine supplied diagnostic' })
    await engineDiagnostic.ctx.fiber.dispose()

    const genericDiagnostic = await setup()
    const genericIntent = preparedFor(genericDiagnostic, 'c7125862-054b-45df-be5d-ab55e0be1d2b')
    await storeOf(genericDiagnostic.ctx.autopilotWorkflows).create(genericIntent)
    await genericDiagnostic.ctx.autonomy.pause(genericDiagnostic.agent, 'make the workflow owner inactive')
    await expect(internals(genericDiagnostic.ctx.autopilotWorkflows).settleResult(
      genericDiagnostic.agent,
      { workflowId: genericIntent.workflowId },
      result({ stopReason: 'cancelled', value: null }),
    )).resolves.toMatchObject({ phase: 'cancelled', reason: 'workflow stopped as cancelled' })
    await genericDiagnostic.ctx.fiber.dispose()

    const missingTask = await setup()
    const missingLease = missingTask.ctx.autonomy.get(missingTask.agent)
    if (missingLease?.plan === undefined) throw new Error('fixture Autopilot plan is unavailable')
    const missingWorkflow = preparedFor(missingTask)
    const getMissingPlan = vi.spyOn(missingTask.ctx.autonomy, 'get').mockReturnValueOnce({
      ...missingLease,
      plan: { ...missingLease.plan, tasks: [] },
    })
    await expect(internals(missingTask.ctx.autopilotWorkflows).applyOutcome(
      missingTask.agent,
      missingWorkflow,
      { taskId: 'build', status: 'completed', summary: 'not applied', evidence: [] },
    )).rejects.toThrow(/changed to missing/u)
    getMissingPlan.mockRestore()
    await missingTask.ctx.fiber.dispose()

    const verifying = await setup()
    const verifyingIntent = preparedFor(verifying, '8d454ea7-e482-4f79-88ce-a9f6bd9dc997')
    await storeOf(verifying.ctx.autopilotWorkflows).create(verifyingIntent)
    const verifyingLease = verifying.ctx.autonomy.get(verifying.agent)
    if (verifyingLease === undefined) throw new Error('fixture Autopilot lease is unavailable')
    const getVerifying = vi.spyOn(verifying.ctx.autonomy, 'get').mockReturnValueOnce({
      ...verifyingLease,
      phase: 'verifying',
    })
    const markVerifying = vi.spyOn(verifying.ctx.autonomy, 'markNeedsAttention').mockResolvedValueOnce(undefined)
    await internals(verifying.ctx.autopilotWorkflows).markUncertain(
      verifying.agent,
      verifyingIntent,
      'verifying workflow became uncertain',
    )
    expect(markVerifying).toHaveBeenCalledOnce()
    getVerifying.mockRestore()
    markVerifying.mockRestore()
    await verifying.ctx.fiber.dispose()

    const aggregate = await setup()
    const aggregateIntent = preparedFor(aggregate, '2db8e215-938a-4bd6-b292-a149967db368')
    const aggregateStore = storeOf(aggregate.ctx.autopilotWorkflows)
    await aggregateStore.create(aggregateIntent)
    vi.spyOn(aggregateStore, 'reduceCurrent').mockRejectedValueOnce(new Error('cancel intent failed'))
    const aggregateEntry = {
      parent: aggregate.agent,
      workflowId: aggregateIntent.workflowId,
      runId: aggregateIntent.runId,
      generation: aggregateIntent.generation,
      controller: new AbortController(),
      done: Promise.resolve(),
      resolveDone() {},
      run: {
        cancel() { throw new Error('engine cancel failed') },
        async dispose() { throw new Error('engine dispose failed') },
      },
    }
    await expect(internals(aggregate.ctx.autopilotWorkflows).requestCancellation(
      aggregateEntry,
      'aggregate cancellation failure',
    )).rejects.toBeInstanceOf(AggregateError)
    expect(current(aggregate).phase).toBe('uncertain')
    await aggregate.ctx.fiber.dispose()
  })

  it('rejects missing profiles, malformed args, budget overflow, and an inexact Goal pair', async () => {
    const harness = await setup()
    const base = {
      taskIds: ['build'], signal: new AbortController().signal, startWorkflow: immediateStart(),
    }
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, { ...base, profileId: 'missing' }))
      .rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_PROFILE_MISSING' })
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      ...base, profileId: 'fanout', taskIds: [],
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      ...base, profileId: 'fanout', args: { huge: 'x'.repeat(2_000) },
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      ...base, profileId: 'fanout', args: cyclic,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    const alias: Record<string, unknown> = { value: true }
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      ...base, profileId: 'fanout', args: { first: alias, second: alias },
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    for (const args of [
      [] as unknown,
      new Date(),
      { nested: new Date() },
      { invalid: Number.NaN },
      { invalid: () => undefined },
    ]) {
      await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
        ...base, profileId: 'fanout', args: args as Readonly<Record<string, unknown>>,
      })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    }
    for (const taskIds of [
      ['build', 'build'],
      ['INVALID'],
      Array.from({ length: 257 }, (_, index) => `t${index}`),
    ]) {
      await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
        ...base, profileId: 'fanout', taskIds,
      })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    }
    await harness.ctx.autonomy.pause(harness.agent)
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, { ...base, profileId: 'fanout' }))
      .rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_INVALID' })
    await harness.ctx.fiber.dispose()

    const budget = await setup({ profiles: [{ ...profile, maxTotalAgents: 5 }] })
    await expect(budget.ctx.autopilotWorkflows.run(budget.agent, {
      ...base, profileId: 'fanout', startWorkflow: immediateStart(),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_BUDGET' })
    await budget.ctx.fiber.dispose()

    const remaining = await setup({ maxSubagents: 1, maxConcurrentSubagents: 1 })
    await expect(remaining.ctx.autopilotWorkflows.run(remaining.agent, {
      ...base, profileId: 'fanout', startWorkflow: immediateStart(),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_BUDGET' })
    await remaining.ctx.fiber.dispose()

    const taskCap = await setup({ tasks: [task('build'), task('test'), task('lint')] })
    await expect(taskCap.ctx.autopilotWorkflows.run(taskCap.agent, {
      ...base, profileId: 'fanout', taskIds: ['build', 'test', 'lint'],
      startWorkflow: immediateStart(),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_BUDGET' })
    await taskCap.ctx.fiber.dispose()

    const tooFew = await setup({ tasks: [task('build'), task('test')] })
    await expect(tooFew.ctx.autopilotWorkflows.run(tooFew.agent, {
      ...base, profileId: 'fanout', taskIds: ['build', 'test'],
      startWorkflow: immediateStart(),
    })).resolves.toBeDefined()
    await tooFew.ctx.fiber.dispose()
  })

  it('supports the minimal fixed profile and deeply materializes plain JSON args', async () => {
    const minimal: ManagedWorkflowProfileConfig = {
      id: 'minimal',
      description: 'One exact task.',
      script: 'return { outcomes: [] }',
      maxTotalAgents: 1,
    }
    const harness = await setup({ profiles: [minimal] })
    const raw = new ManagedWorkflowService(new Context(), { profiles: [minimal] })
    expect(raw.listProfiles()).toEqual([
      expect.objectContaining({ id: 'minimal', maxArgsBytes: 32_768 }),
    ])
    const rawProfiles = (raw as unknown as { profiles: ReadonlyMap<string, unknown> }).profiles
    ;(harness.ctx.autopilotWorkflows as unknown as {
      profiles: ReadonlyMap<string, unknown>
    }).profiles = rawProfiles
    const args = Object.assign(Object.create(null) as Record<string, unknown>, {
      values: [null, 'text', true, false, 7, { nested: 'value' }],
    })
    const start = immediateStart()
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'minimal', taskIds: ['build'], args,
      signal: new AbortController().signal, startWorkflow: start,
    })).resolves.toMatchObject({ phase: 'completed' })
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      meta: { name: 'minimal', description: 'One exact task.' },
      args: { taskIds: ['build'], input: { values: [null, 'text', true, false, 7, { nested: 'value' }] } },
      maxTotalAgents: 1,
    })
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty('subagentProvider')
    expect(start.mock.calls[0]?.[0].meta).not.toHaveProperty('phases')
    expect(harness.ctx.autopilotWorkflows.listProfiles()).toEqual([
      expect.not.objectContaining({ whenToUse: expect.anything() }),
    ])
    await harness.ctx.fiber.dispose()
  })

  it('records claim and engine-start failures without inventing success', async () => {
    const claim = await setup()
    await expect(claim.ctx.autopilotWorkflows.run(claim.agent, {
      profileId: 'fanout', taskIds: ['missing'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    })).rejects.toBeInstanceOf(Error)
    expect(current(claim)).toMatchObject({ phase: 'error', reason: expect.stringContaining('claim rejected') })
    expect(claim.ctx.autonomy.get(claim.agent)?.subagentsStarted).toBe(0)
    await claim.ctx.fiber.dispose()

    const engine = await setup()
    const failure = new Error('profile does not parse')
    const start = vi.fn<ManagedWorkflowStart>(() => { throw failure })
    await expect(engine.ctx.autopilotWorkflows.run(engine.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal, startWorkflow: start,
    })).rejects.toBe(failure)
    expect(current(engine).phase).toBe('error')
    expect(engine.ctx.autonomy.get(engine.agent)?.plan?.tasks[0]?.status).toBe('failed')
    await engine.ctx.fiber.dispose()
  })

  it('fails closed when claims partially commit or claimed tasks cannot be settled', async () => {
    const partialClaim = await setup()
    const claimTasks = partialClaim.ctx.autonomy.claimTasks.bind(partialClaim.ctx.autonomy)
    const claimError = new Error('claim acknowledgement lost')
    vi.spyOn(partialClaim.ctx.autonomy, 'claimTasks').mockImplementationOnce(async (...args) => {
      await claimTasks(...args)
      throw claimError
    })
    await expect(partialClaim.ctx.autopilotWorkflows.run(partialClaim.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    })).rejects.toBe(claimError)
    expect(current(partialClaim)).toMatchObject({
      phase: 'uncertain',
      reason: expect.stringContaining('partially committed'),
    })
    await partialClaim.ctx.fiber.dispose()

    const settlement = await setup()
    vi.spyOn(settlement.ctx.autonomy, 'updateTask').mockRejectedValueOnce(new Error('DAG write failed'))
    await expect(settlement.ctx.autopilotWorkflows.run(settlement.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_UNCERTAIN' })
    expect(current(settlement)).toMatchObject({ phase: 'uncertain', reason: expect.stringContaining('DAG write failed') })
    await settlement.ctx.fiber.dispose()

    const rejectedStart = await setup()
    vi.spyOn(rejectedStart.ctx.autonomy, 'updateTask').mockRejectedValueOnce(new Error('failed-task write lost'))
    await expect(rejectedStart.ctx.autopilotWorkflows.run(rejectedStart.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: () => { throw new Error('engine rejected script') },
    })).rejects.toThrow('engine rejected script')
    expect(current(rejectedStart)).toMatchObject({
      phase: 'uncertain',
      reason: expect.stringContaining('DAG settlement failed'),
    })
    await rejectedStart.ctx.fiber.dispose()
  })

  it('detects DAG ownership changes while applying a workflow outcome', async () => {
    const harness = await setup()
    const start: ManagedWorkflowStart = request => ({
      id: WorkflowRunId('changed-task-run'),
      meta: request.meta,
      result: (async () => {
        await harness.ctx.autonomy.updateTask(harness.agent, 'build', 'block', {
          reason: 'operator changed task',
        })
        return result()
      })(),
      cancel() {},
      async dispose() {},
    })
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal, startWorkflow: start,
    })).rejects.toMatchObject({ code: 'AUTOPILOT_WORKFLOW_UNCERTAIN' })
    expect(current(harness)).toMatchObject({
      phase: 'uncertain',
      reason: expect.stringContaining('changed to blocked'),
    })
    await harness.ctx.fiber.dispose()
  })

  it('cancels an accepted engine run when its durable identity cannot be recorded', async () => {
    const harness = await setup()
    const store = storeOf(harness.ctx.autopilotWorkflows)
    const append = store.appendIfCurrent.bind(store)
    vi.spyOn(store, 'appendIfCurrent').mockImplementation((operation, expected, snapshot) =>
      operation === 'start'
        ? Promise.reject(new Error('engine identity disk failure'))
        : append(operation, expected, snapshot))
    const cancel = vi.fn()
    const dispose = vi.fn(async () => { throw new Error('engine cleanup also failed') })
    const start: ManagedWorkflowStart = request => ({
      id: WorkflowRunId('unrecorded-engine-run'),
      meta: request.meta,
      result: Promise.resolve(result()),
      cancel,
      dispose,
    })
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal, startWorkflow: start,
    })).rejects.toThrow('engine identity disk failure')
    expect(cancel).toHaveBeenCalledWith('workflow run identity could not be persisted')
    expect(dispose).toHaveBeenCalled()
    expect(current(harness).phase).toBe('uncertain')
    await harness.ctx.fiber.dispose()
  })

  it('validates deployment profiles before activation', () => {
    expect(new ManagedWorkflowService(new Context()).listProfiles()).toEqual([])
    const invalid = [
      [[{ ...profile, id: 'Bad' }], /id .* invalid/u],
      [[profile, profile], /duplicated/u],
      [[{ ...profile, description: ' ' }], /description/u],
      [[{ ...profile, script: ' ' }], /script/u],
      [[{ ...profile, script: 'x'.repeat(262_145) }], /script/u],
      [[{ ...profile, maxTotalAgents: 0 }], /maxTotalAgents/u],
      [[{ ...profile, maxTotalAgents: 1.5 }], /maxTotalAgents/u],
      [[{ ...profile, maxArgsBytes: 0 }], /maxArgsBytes/u],
      [[{ ...profile, maxArgsBytes: 1.5 }], /maxArgsBytes/u],
      [[{ ...profile, whenToUse: ' ' }], /whenToUse/u],
      [[{ ...profile, subagentProvider: ' ' }], /subagentProvider/u],
      [[{ ...profile, phases: [{ title: 'same' }, { title: 'same' }] }], /unique/u],
      [[{ ...profile, phases: [{ title: ' ' }] }], /phase 1 title/u],
      [[{ ...profile, phases: [{ title: 'phase', detail: ' ' }] }], /phase 1 detail/u],
      [[{ ...profile, phases: [{ title: 'phase', provider: ' ' }] }], /phase 1 provider/u],
      [[{ ...profile, phases: [{ title: 'phase', model: ' ' }] }], /phase 1 model/u],
    ] satisfies readonly [readonly ManagedWorkflowProfileConfig[], RegExp][]
    for (const [profiles, message] of invalid) {
      expect(() => new ManagedWorkflowService(new Context(), { profiles })).toThrow(message)
    }
  })

  it('marks rejected result and cleanup promises uncertain', async () => {
    const resultFailure = await setup()
    const rejectedResult = Promise.withResolvers<WorkflowResult>()
    const brokenResult: ManagedWorkflowStart = request => ({
      id: WorkflowRunId('broken-result'), meta: request.meta,
      result: rejectedResult.promise,
      cancel() {}, dispose: vi.fn(async () => {}),
    })
    const resultRun = resultFailure.ctx.autopilotWorkflows.run(resultFailure.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: brokenResult,
    })
    await vi.waitFor(() => { expect(current(resultFailure).phase).toBe('running') })
    rejectedResult.reject(new Error('unexpected rejection'))
    await expect(resultRun).rejects.toThrow('unexpected rejection')
    expect(current(resultFailure).phase).toBe('uncertain')
    await resultFailure.ctx.fiber.dispose()

    const cleanupFailure = await setup()
    const brokenDispose: ManagedWorkflowStart = request => ({
      id: WorkflowRunId('broken-dispose'), meta: request.meta,
      result: Promise.resolve(result()), cancel() {},
      dispose: vi.fn(async () => { throw new Error('dispose failed') }),
    })
    await expect(cleanupFailure.ctx.autopilotWorkflows.run(cleanupFailure.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: brokenDispose,
    })).rejects.toThrow('dispose failed')
    expect(current(cleanupFailure).phase).toBe('uncertain')
    await cleanupFailure.ctx.fiber.dispose()

    const bothFail = await setup()
    const rejectedBoth = Promise.withResolvers<WorkflowResult>()
    const brokenBoth: ManagedWorkflowStart = request => ({
      id: WorkflowRunId('broken-both'),
      meta: request.meta,
      result: rejectedBoth.promise,
      cancel() {},
      async dispose() { throw new Error('dispose rejected') },
    })
    const bothRun = bothFail.ctx.autopilotWorkflows.run(bothFail.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: brokenBoth,
    })
    await vi.waitFor(() => { expect(current(bothFail).phase).toBe('running') })
    rejectedBoth.reject(new Error('result rejected'))
    await expect(bothRun).rejects.toBeInstanceOf(AggregateError)
    expect(current(bothFail).phase).toBe('uncertain')
    await bothFail.ctx.fiber.dispose()
  })

  it('normalizes non-object results and absent engine diagnostics into durable failures', async () => {
    const malformed = await setup()
    await expect(malformed.ctx.autopilotWorkflows.run(malformed.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(result({ value: null })),
    })).resolves.toMatchObject({ phase: 'error', reason: expect.stringContaining('outcomes array') })
    await malformed.ctx.fiber.dispose()

    const absent = await setup()
    await expect(absent.ctx.autopilotWorkflows.run(absent.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(result({ stopReason: 'error', value: null })),
    })).resolves.toMatchObject({ phase: 'error', reason: 'workflow stopped as error' })
    await absent.ctx.fiber.dispose()
  })

  it('preserves an unrenderable thrown claim value without fabricating success', async () => {
    const harness = await setup()
    const thrown = Object.create(null) as { [Symbol.toPrimitive]?: () => never }
    thrown[Symbol.toPrimitive] = () => { throw new Error('cannot render') }
    vi.spyOn(harness.ctx.autonomy, 'claimTasks').mockRejectedValueOnce(thrown)
    await expect(harness.ctx.autopilotWorkflows.run(harness.agent, {
      profileId: 'fanout', taskIds: ['build'], signal: new AbortController().signal,
      startWorkflow: immediateStart(),
    })).rejects.toBe(thrown)
    expect(current(harness)).toMatchObject({
      phase: 'error',
      reason: expect.stringContaining('<unrenderable thrown value>'),
    })
    await harness.ctx.fiber.dispose()
  })
})
