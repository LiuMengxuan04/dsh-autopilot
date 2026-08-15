import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedWorkflowService, ManagedWorkflowStart } from '../../src/workflow-service.ts'
import type { ManagedWorkflowSnapshot } from '../../src/workflow-state.ts'
import * as workflowTool from '../../src/tool-workflow.ts'
import { createTestAgent } from '../helpers.ts'

let calls = 0

function snapshot(overrides: Partial<ManagedWorkflowSnapshot> = {}): ManagedWorkflowSnapshot {
  return {
    version: 1,
    workflowId: '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    goalId: 'goal',
    revision: 6,
    maxAuditRecords: 100,
    maxAuditBytes: 1_000_000,
    profileId: 'fanout',
    profileSha256: 'a'.repeat(64),
    argsSha256: 'b'.repeat(64),
    taskIds: ['build'],
    maxTotalAgents: 2,
    subagentsStartedBefore: 0,
    phase: 'completed',
    createdAt: 100,
    updatedAt: 150,
    claimedRunRevision: 3,
    engineRunId: 'engine',
    engineStopReason: 'completed',
    engineAgentsStarted: 1,
    targetPhase: 'completed',
    outcomes: [{
      taskId: 'build', status: 'completed', summary: 'done',
      evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
    }],
    settledTaskIds: ['build'],
    ...overrides,
  }
}

function execute(ctx: Context, args: unknown, agent?: Agent) {
  calls += 1
  return ctx.tools.execute({
    callId: CallId(`workflow-tool-${calls}`),
    name: 'autopilot_workflow_run',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

async function setup(profiles = [{
  id: 'fanout', description: 'Fan out exact DAG tasks.', maxTotalAgents: 2,
  maxArgsBytes: 1_024, sha256: 'a'.repeat(64),
}]) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const run = vi.fn(async () => snapshot())
  const listProfiles = vi.fn(() => profiles)
  ctx.provide('autopilotWorkflows', {
    run,
    listProfiles,
  } as unknown as ManagedWorkflowService)
  const startWorkflow = vi.fn<ManagedWorkflowStart>()
  const fiber = await ctx.plugin(workflowTool, { startWorkflow })
  await vi.waitFor(() => expect(ctx.tools.schemas().map(schema => schema.name))
    .toContain('autopilot_workflow_run'))
  return { ctx, run, listProfiles, startWorkflow, fiber }
}

describe('managed workflow tool', () => {
  it('exposes only profile, task ids, and JSON args while projecting durable results', async () => {
    const harness = await setup()
    const agent = createTestAgent('parent')
    const result = await execute(harness.ctx, {
      profileId: 'fanout', taskIds: ['build'], args: { focus: 'tests' },
    }, agent)
    expect(result).toMatchObject({
      isError: false,
      value: {
        workflowId: expect.any(String), profileId: 'fanout', taskIds: ['build'], phase: 'completed',
        engineRunId: 'engine', engineStopReason: 'completed', agentsStarted: 1,
        outcomes: [{ taskId: 'build', status: 'completed', applied: true }],
      },
      content: [{ type: 'text', text: expect.stringContaining('"profileId": "fanout"') }],
    })
    expect(harness.run).toHaveBeenCalledWith(agent, {
      profileId: 'fanout', taskIds: ['build'], args: { focus: 'tests' },
      signal: expect.any(AbortSignal), startWorkflow: harness.startWorkflow,
    })
    const schema = harness.ctx.tools.schemas().find(item => item.name === 'autopilot_workflow_run')
    expect(schema?.parameters).toMatchObject({ properties: {
      profileId: expect.any(Object), taskIds: expect.any(Object), args: expect.any(Object),
    } })
    expect(Object.keys(schema?.parameters.properties ?? {}).sort()).toEqual(['args', 'profileId', 'taskIds'])
    const definition = harness.ctx.tools.get('autopilot_workflow_run')
    expect(definition?.presentCall?.({ profileId: 'fanout', taskIds: ['build'] })).toEqual({
      card: 'generic', title: 'Autopilot workflow: fanout', rawInput: '1 DAG task',
    })
    expect(definition?.presentCall?.({ profileId: 'fanout', taskIds: ['build', 'test'] }))
      .toMatchObject({ rawInput: '2 DAG tasks' })
    expect(definition?.presentResult?.(
      { profileId: 'fanout', taskIds: ['build'] },
      { content: [], isError: false },
    )).toEqual({ card: 'generic' })
    const prompt = await harness.ctx.systemPrompt.assemble()
    expect(prompt.sections).toContainEqual(expect.objectContaining({
      name: 'tool:autopilot-workflow', text: expect.stringContaining('fanout: Fan out exact DAG tasks.'),
    }))
    await harness.fiber.dispose()
    expect(harness.ctx.tools.schemas().map(item => item.name)).not.toContain('autopilot_workflow_run')
    await harness.ctx.fiber.dispose()
  })

  it('handles no profiles, optional args, subjectless calls, and optional result fields', async () => {
    const harness = await setup([])
    const agent = createTestAgent('parent')
    harness.run.mockResolvedValueOnce(snapshot({
      phase: 'cancelled',
      revision: 4,
      engineRunId: undefined,
      engineStopReason: undefined,
      engineAgentsStarted: undefined,
      targetPhase: undefined,
      outcomes: [],
      settledTaskIds: [],
      reason: 'cancelled before start',
    }))
    const result = await execute(harness.ctx, { profileId: 'fanout', taskIds: ['build'] }, agent)
    expect(result.value).toMatchObject({
      phase: 'cancelled', outcomes: [], reason: 'cancelled before start',
    })
    expect(result.value).not.toHaveProperty('engineRunId')
    expect(harness.run).toHaveBeenCalledWith(agent, expect.not.objectContaining({ args: expect.anything() }))
    expect((await execute(harness.ctx, { profileId: 'fanout', taskIds: ['build'] })).isError).toBe(true)
    expect((await harness.ctx.systemPrompt.assemble()).sections)
      .toContainEqual(expect.objectContaining({ text: expect.stringContaining('No managed workflow profiles') }))
    await harness.ctx.fiber.dispose()
  })

  it('projects unapplied outcomes and an optional profile hint', () => {
    expect(workflowTool.managedWorkflowJson(snapshot({
      phase: 'uncertain', settledTaskIds: [], reason: 'restart uncertainty',
    }))).toMatchObject({
      outcomes: [{ applied: false }], reason: 'restart uncertainty',
    })
  })
})
