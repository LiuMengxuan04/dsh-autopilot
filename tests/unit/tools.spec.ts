import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyTools, inject as toolsInject } from '../../src/tools.ts'
import ManagedWorkflowService from '../../src/workflow-service.ts'
import {
  createHarness,
  createTestAgent,
  shellResult,
} from '../helpers.ts'

let callSequence = 0
const projectRoots: string[] = []

/** Create a canonical project workspace with a trusted root package manifest. */
async function projectWorkspace(scripts: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-tools-project-')))
  projectRoots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }))
  return root
}

afterEach(async () => {
  await Promise.all(projectRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Execute a model tool with a unique call identity. */
function executeTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: unknown = {},
  signal: AbortSignal = new AbortController().signal,
) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`dsh-autopilot-call-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal,
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

/** Create and durably authorize an Autopilot Goal. */
async function startAutopilot(ctx: Context, agent: Agent, objective = 'ship verified work'): Promise<GoalView> {
  const goal = ctx.goals.create(agent, { objective, maxGoalRounds: 8 })
  await ctx.autonomy.start(agent, { goalId: goal.id })
  await ctx.autonomy.recordInterview(agent, {
    summary: 'The test objective and constraints are understood.',
    decisions: ['Use the bounded fixture plan.'],
    openQuestions: [],
  })
  return goal
}

/** Approve one fixture plan without consuming model-subagent outcomes unrelated to the test. */
async function approveTestPlan(ctx: Context, agent: Agent): Promise<void> {
  const reviewing = await ctx.autonomy.beginPlanReview(agent)
  const revision = reviewing.plan?.revision
  if (revision === undefined) throw new Error('fixture plan is missing')
  await ctx.autonomy.settlePlanReview(agent, revision, [
    { role: 'metis', verdict: 'advice', summary: 'requirements are explicit', findings: [], recommendations: [] },
    { role: 'momus', verdict: 'advice', summary: 'plan is executable', findings: [], recommendations: [] },
    { role: 'oracle', verdict: 'advice', summary: 'architecture is sound', findings: [], recommendations: [] },
  ])
}

/** Create and complete the smallest valid durable plan through model tools. */
async function completePlan(ctx: Context, agent: Agent): Promise<void> {
  const planned = await executeTool(ctx, agent, 'autopilot_plan', {
    action: 'replace',
    intent: 'implementation',
    acceptanceCriteria: ['all checks and independent review pass'],
    tasks: [{
      id: 'implement',
      title: 'Implement',
      description: 'Implement the requested behavior',
      acceptanceCriteria: ['focused checks pass'],
    }],
  })
  if (planned.isError) throw new Error(planned.error.message)
  await approveTestPlan(ctx, agent)
  const started = await executeTool(ctx, agent, 'autopilot_task', {
    taskId: 'implement',
    action: 'start',
  })
  if (started.isError) throw new Error(started.error.message)
  const completed = await executeTool(ctx, agent, 'autopilot_task', {
    taskId: 'implement',
    action: 'complete',
    evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'focused tests passed' }],
  })
  if (completed.isError) throw new Error(completed.error.message)
}

/** Run the policy portion of one proposed Agent step. */
function enterStep(ctx: Context, agent: Agent, step = 0) {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [],
    turn: 1,
    step,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

/** One valid independent reviewer result. */
function reviewer(
  verdict: 'pass' | 'fail' | 'inconclusive',
  findings: string[] = [],
) {
  return {
    output: [],
    stopReason: 'completed' as const,
    structured: { verdict, summary: `${verdict} review`, findings },
  }
}

/** Publish one model answer through the same session event observed by the Host UI. */
function emitAssistantMessage(ctx: Context, agent: Agent, text = 'Verified work is complete.'): void {
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    seq: agent.session.events.length,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test', model: 'test' },
      }),
    },
  })
}

/** Publish a non-message session event for listener selectivity tests. */
function emitTurnEnd(ctx: Context, agent: Agent): void {
  ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    seq: agent.session.events.length,
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'completed' } },
  })
}

/** Admit and complete the exact deterministic notice queued by the verifier. */
function emitCompletionTurn(ctx: Context, agent: Agent, text = 'Verified work is complete.'): void {
  const message = (agent.followup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as UserMessage | undefined
  if (message === undefined) throw new Error('fixture has no queued completion notice')
  agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn: 1 })
  ctx.emit('session/event', agent.session, {
    type: 'user/message',
    seq: agent.session.events.length,
    time: Date.now(),
    data: message,
  })
  emitAssistantMessage(ctx, agent, text)
  emitTurnEnd(ctx, agent)
}

/** Rebuild the durable Goal half that a production session replay would provide. */
function restoreGoal(agent: Agent, goal: GoalView): void {
  const now = Date.now()
  agent.session.append('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: 'active',
      maxGoalRounds: goal.maxGoalRounds,
    },
    roundsStarted: goal.roundsStarted,
    createdAt: now,
    updatedAt: now,
  })
}

/** Completion-critical deployment settings used by restart-policy tests. */
function strictVerificationConfig() {
  return {
    minimumEvidenceItems: 2,
    maxOutputChars: 16,
    checks: [
      { name: 'tests', command: 'secure-check --token SUPER_SECRET', timeoutMs: 12_345 },
      { name: 'types', command: 'pnpm typecheck', timeoutMs: 23_456 },
    ],
    autoDiscoverChecks: false,
    projectCheckTimeoutMs: 34_567,
    reviewers: [
      {
        role: 'requirements',
        description: 'Audit every requirement.',
        subagentProvider: 'spawn',
        provider: 'deepseek',
        model: 'strict-reviewer',
        fallbacks: [{ provider: 'backup', model: 'backup-reviewer' }],
      },
      { role: 'security', description: 'Audit security.' },
    ],
  }
}

describe('model-facing autonomy context', () => {
  it('returns an empty status and prompt before any Goal exists', async () => {
    const { ctx, agent } = await createHarness()
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { goal: null, lease: null },
    })
    const subjectless = await ctx.systemPrompt.assemble()
    expect(subjectless.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text).toBe('')
  })

  it('bounds the durable checkpoint injected into a model request', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent, 'x'.repeat(3000))
    await ctx.autonomy.setPlan(agent, ['bounded checkpoint'], Array.from({ length: 40 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      description: `Complete task ${index}`,
      acceptanceCriteria: [`task ${index} is complete`],
    })))

    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const text = prompt.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text
    expect(text).toContain(`Objective checkpoint: "${'x'.repeat(2000)}"`)
    expect(text).not.toContain('x'.repeat(2001))
    expect(text).toContain('Task checkpoint (32/40 shown)')
    expect(text).toContain('{"id":"task-31","status":"pending"}')
    expect(text).not.toContain('{"id":"task-32","status":"pending"}')
    expect(text).toContain('Latest verification checkpoint: null')
  })

  it('keeps an ordinary Goal transparent and restricts create_goal only for an armed Autopilot run', async () => {
    const { ctx, agent } = await createHarness()
    registerTool(ctx, 'create_goal')
    const goal = ctx.goals.create(agent, { objective: 'ordinary goal' })

    await enterStep(ctx, agent)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('create_goal')
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { goal: { id: String(goal.id), objective: 'ordinary goal' }, lease: null },
    })
    const ordinary = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(ordinary.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text).toBe('')

    await ctx.autonomy.start(agent, { goalId: goal.id })
    await enterStep(ctx, agent, 1)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('create_goal')
    const active = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(active.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text)
      .toContain('Create the durable plan with autopilot_plan')
    await enterStep(ctx, agent, 2)

    ctx.goals.pause(agent, ctx.goals.get(agent)!)
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    })
    await enterStep(ctx, agent, 3)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('create_goal')
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).contexts
      .find(item => item.name === 'dsh-autopilot:autopilot')?.text).toBe('')
  })

  it('reports the durable graph, evidence, budgets, extensions, and verification history', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    const status = await executeTool(ctx, agent, 'get_autopilot')

    expect(status).toMatchObject({
      isError: false,
      value: {
        goal: { objective: 'ship verified work', phase: 'active', activation: 'armed' },
        lease: {
          generation: 1,
          phase: 'running',
          activation: 'armed',
          selfModification: 'host-only',
          dynamicExtensions: [],
          plan: {
            acceptanceCriteria: ['all checks and independent review pass'],
            tasks: [{
              id: 'implement',
              status: 'completed',
              attempts: 1,
              evidence: [{ kind: 'test', ref: 'pnpm test' }],
            }],
          },
          verificationHistory: [],
        },
      },
    })
    expect(ctx.tools.executionMode({
      callId: CallId('parallel-status'),
      name: 'get_autopilot',
      arguments: {},
      agent,
      signal: new AbortController().signal,
    })).toEqual({ kind: 'parallel' })
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(prompt.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text)
      .toContain('Durable task plan: 1/1 complete')
  })

  it('reports the exact native DSH capability composition visible to this Agent', async () => {
    const { ctx, agent } = await createHarness()
    for (const name of [
      'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
      'skill', 'lsp', 'glob', 'grep', 'web_search', 'web_fetch',
      'terminal_open', 'terminal_read', 'terminal_send', 'terminal_close',
      'job_output', 'job_list', 'job_kill', 'read_image',
    ]) registerTool(ctx, name)
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: {
        composition: {
          sessionSearch: true,
          skillCatalog: true,
          lspNavigation: true,
          fileSearch: true,
          webResearch: true,
          interactiveTerminal: true,
          backgroundJobs: true,
          imageAnalysis: true,
        },
      },
    })
    agent.ctx.tools.restrict({ deny: ['web_fetch', 'terminal_close', 'job_kill', 'read_image'] })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      value: {
        composition: {
          sessionSearch: true,
          webResearch: false,
          interactiveTerminal: false,
          backgroundJobs: false,
          imageAnalysis: false,
        },
      },
    })
  })

  it('restores the model-visible task evidence and failed verification after compaction', async () => {
    const { ctx, agent, shell } = await createHarness({
      autonomy: { autoResume: true, selfModification: 'host-only' },
      tools: {
        checks: [{ name: 'tests', command: 'pnpm test' }],
        reviewers: [{ role: 'requirements', description: 'Audit every acceptance criterion.' }],
      },
    })
    await startAutopilot(ctx, agent, 'preserve durable work across compaction')
    await enterStep(ctx, agent)
    await completePlan(ctx, agent)
    shell.outcomes.push(shellResult({
      exitCode: 1,
      stderr: { text: 'one acceptance criterion still fails', truncated: false },
    }))

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'first candidate',
      evidence: ['focused test output'],
    })).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: { verdict: 'fail' },
    })
    const beforeCompaction = ctx.autonomy.get(agent)
    expect(beforeCompaction).toMatchObject({
      phase: 'running',
      activation: 'armed',
      plan: {
        tasks: [{
          id: 'implement',
          status: 'completed',
          evidence: [{ kind: 'test', ref: 'pnpm test' }],
        }],
      },
      verificationHistory: [{
        verdict: 'fail',
        findings: [expect.stringContaining('tests failed')],
      }],
    })

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    await enterStep(ctx, agent, 1)

    expect(ctx.goals.get(agent)).toMatchObject({
      objective: 'preserve durable work across compaction',
      phase: 'active',
      activation: 'armed',
    })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: {
        goal: { objective: 'preserve durable work across compaction' },
        lease: {
          id: beforeCompaction?.id,
          phase: 'running',
          activation: 'armed',
          plan: {
            tasks: [{
              id: 'implement',
              status: 'completed',
              evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'focused tests passed' }],
            }],
          },
          verificationHistory: [{
            verdict: 'fail',
            findings: [expect.stringContaining('tests failed')],
          }],
        },
      },
    })
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const autopilotContext = prompt.contexts.find(item => item.name === 'dsh-autopilot:autopilot')?.text
    expect(autopilotContext).toContain('Durable task plan: 1/1 complete')
    expect(autopilotContext).toContain('Objective checkpoint: "preserve durable work across compaction"')
    expect(autopilotContext).toContain('Task checkpoint (1/1 shown): [{"id":"implement","status":"completed"}]')
    expect(autopilotContext).toContain('Latest verification checkpoint: {"attempt":1,"verdict":"fail"')
    expect(autopilotContext).toContain('tests failed')
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
  })

  it('keeps core autonomy tools available when the optional Host runner is absent', async () => {
    const { ctx, agent } = await createHarness({ dynamicCordisRunner: false })
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)
    const names = ctx.tools.schemas(agent).map(tool => tool.name)

    expect(names).toEqual(expect.arrayContaining([
      'get_autopilot',
      'autopilot_plan',
      'autopilot_task',
      'autopilot_delegate',
      'autopilot_verify',
    ]))
    expect(names).not.toEqual(expect.arrayContaining([
      'autopilot_cordis_apply',
      'autopilot_cordis_remove',
    ]))
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { goal: { objective: 'ship verified work' }, lease: { phase: 'running' } },
    })
  })

  it('installs managed Workflow tools when both optional Host services appear', async () => {
    const { ctx } = await createHarness()
    ctx.provide('workflowEngine', { start: vi.fn() } as never)
    ctx.provide('autopilotWorkflows', {
      listProfiles: () => [],
      listRun: () => [],
      run: vi.fn(),
    } as never)

    await vi.waitFor(() => {
      expect(ctx.tools.schemas().map(tool => tool.name)).toContain('autopilot_workflow_run')
    })
    expect(ctx.autopilotRecoveryReadiness.missing()).not.toContain('tool-workflow')
  })

  it('resolves a managed Workflow engine from the executing Agent preset', async () => {
    const { ctx, agent, recoveryContributionDisposers } = await createHarness()
    recoveryContributionDisposers.get('tool-workflow')?.()
    expect(ctx.autopilotRecoveryReadiness.missing()).toContain('tool-workflow')
    expect(ctx.get('workflowEngine')).toBeUndefined()

    const requests: WorkflowStartRequest[] = []
    const engine = {
      start(request: WorkflowStartRequest) {
        requests.push(request)
        const taskIds = (request.args as { taskIds: readonly string[] }).taskIds
        return {
          id: WorkflowRunId(`dsh-autopilot-web-workflow-${requests.length}`),
          meta: request.meta,
          result: Promise.resolve({
            stopReason: 'completed' as const,
            agentsStarted: taskIds.length,
            value: {
              outcomes: taskIds.map(taskId => ({
                taskId,
                status: 'completed',
                summary: `completed ${taskId}`,
                evidence: [{ kind: 'subagent', ref: taskId, summary: 'workflow evidence' }],
              })),
            },
          }),
          cancel: vi.fn(),
          dispose: vi.fn(async () => {}),
        }
      },
    }
    const serviceFor = vi.fn((candidate: Agent, name: string) =>
      candidate === agent && name === 'workflowEngine' ? engine : undefined)
    ctx.provide('agentPresets', { serviceFor } as never)
    await ctx.plugin(ManagedWorkflowService, {
      profiles: [{
        id: 'web-fanout',
        description: 'Exercise an Agent-scoped Workflow engine.',
        script: 'return args',
        maxTotalAgents: 1,
      }],
    })

    await vi.waitFor(() => {
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('autopilot_workflow_run')
      expect(ctx.autopilotRecoveryReadiness.missing()).not.toContain('tool-workflow')
    })
    expect(serviceFor).not.toHaveBeenCalled()

    await startAutopilot(ctx, agent)
    const planned = await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['the workflow task completes'],
      tasks: [{
        id: 'implement',
        title: 'Implement',
        description: 'Implement through the Agent-scoped Workflow engine',
        acceptanceCriteria: ['workflow evidence is recorded'],
      }],
    })
    expect(planned.isError).toBe(false)
    await approveTestPlan(ctx, agent)

    const result = await executeTool(ctx, agent, 'autopilot_workflow_run', {
      profileId: 'web-fanout',
      taskIds: ['implement'],
    })

    expect(result).toMatchObject({
      isError: false,
      value: { profileId: 'web-fanout', phase: 'completed', taskIds: ['implement'] },
    })
    expect(serviceFor).toHaveBeenCalledTimes(1)
    expect(serviceFor).toHaveBeenCalledWith(agent, 'workflowEngine')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.parent).toBe(agent)
    expect(ctx.autonomy.get(agent)?.plan?.tasks[0]?.status).toBe('completed')

    expect(await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'add',
      tasks: [{
        id: 'host-engine',
        title: 'Use Host engine',
        description: 'Exercise the rosterless Host fallback.',
        acceptanceCriteria: ['Host Workflow evidence is recorded'],
      }],
    })).toMatchObject({ isError: false })
    await approveTestPlan(ctx, agent)
    serviceFor.mockReturnValue(undefined)
    ctx.provide('workflowEngine', engine as never)
    expect(await executeTool(ctx, agent, 'autopilot_workflow_run', {
      profileId: 'web-fanout',
      taskIds: ['host-engine'],
    })).toMatchObject({
      isError: false,
      value: { profileId: 'web-fanout', phase: 'completed', taskIds: ['host-engine'] },
    })
    expect(serviceFor).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(2)
  })

  it('fails the managed Workflow task when no Agent or Host engine exists', async () => {
    const { ctx, agent, recoveryContributionDisposers } = await createHarness()
    recoveryContributionDisposers.get('tool-workflow')?.()
    await ctx.plugin(ManagedWorkflowService, {
      profiles: [{
        id: 'missing-engine',
        description: 'Exercise a missing Workflow engine.',
        script: 'return args',
        maxTotalAgents: 1,
      }],
    })
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['the missing engine is reported'],
      tasks: [{
        id: 'implement',
        title: 'Implement',
        description: 'Attempt a managed Workflow without an engine.',
        acceptanceCriteria: ['the failure is durable'],
      }],
    })).toMatchObject({ isError: false })
    await approveTestPlan(ctx, agent)

    expect(await executeTool(ctx, agent, 'autopilot_workflow_run', {
      profileId: 'missing-engine',
      taskIds: ['implement'],
    })).toMatchObject({
      isError: true,
      error: { message: 'managed Workflow requires workflowEngine in the current Agent preset or Host' },
    })
  })

  it('unloads cleanly when a root Agent has no Autopilot run', async () => {
    const { ctx, toolsFiber } = await createHarness()
    await expect(toolsFiber.dispose()).resolves.toBeUndefined()
    expect(ctx.tools.get('get_autopilot')).toBeUndefined()
  })

  it('releases its create_goal restriction when the tools plugin unloads', async () => {
    const { ctx, agent, toolsFiber } = await createHarness()
    registerTool(ctx, 'create_goal')
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('create_goal')
    await toolsFiber.dispose()
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('create_goal')
  })
})

describe('durable plan and delegation tools', () => {
  it('imports a Markdown mission, runs it sequentially, exposes audit, and gates verification on operator state', async () => {
    const workspace = await projectWorkspace({ test: 'vitest' })
    await writeFile(join(workspace, 'mission.md'), [
      '# Release queue',
      '- [ ] Audit the failure.',
      '- [ ] Apply the fix.',
    ].join('\n'))
    const { ctx, agent, subagents } = await createHarness({ cwd: workspace })
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await startAutopilot(ctx, agent, 'run a file-backed mission')
    expect(await executeTool(ctx, agent, 'autopilot_mission', { action: 'plan' })).toMatchObject({
      isError: true,
      error: { message: 'autopilot_mission plan requires path' },
    })
    const planned = await executeTool(ctx, agent, 'autopilot_mission', {
      action: 'plan', path: 'mission.md', continueOnError: false,
    })
    expect(planned).toMatchObject({
      isError: false,
      value: { phase: 'planned', counts: { planned: 2 }, tasks: [{ id: 'task-001' }, { id: 'task-002' }] },
    })
    const missionId = (planned.value as { missionId: string }).missionId
    await approveTestPlan(ctx, agent)
    const completed = await executeTool(ctx, agent, 'autopilot_mission', {
      action: 'resume', missionId,
    })
    expect(completed).toMatchObject({
      isError: false,
      value: { phase: 'passed', counts: { passed: 2 } },
    })
    expect(subagents.requests.slice(-2).map(request => request.label)).toEqual([
      `autopilot-mission-${missionId}-task-001`,
      `autopilot-mission-${missionId}-task-002`,
    ])
    expect(await executeTool(ctx, agent, 'autopilot_mission', { action: 'audit', limit: 200 }))
      .toMatchObject({ isError: false, value: expect.arrayContaining([expect.objectContaining({ operation: 'plan' })]) })
    expect(await executeTool(ctx, agent, 'autopilot_mission', {
      action: 'mark', missionId, taskId: 'task-001', status: 'needs-human-review', reason: 'owner approval',
    })).toMatchObject({ isError: false, value: { phase: 'needs-human-review' } })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'must remain gated', evidence: ['mission evidence'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining(`mission:${missionId}:needs-human-review`) },
    })
    expect(await executeTool(ctx, agent, 'autopilot_mission', {
      action: 'rerun', missionId, taskId: 'task-001',
    })).toMatchObject({ isError: false, value: { phase: 'passed' } })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'mission queue passed', evidence: ['mission evidence'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass' } })
  })

  it('runs the canonical interview and fixed Metis, Momus, and Oracle plan hardening through tools', async () => {
    const workspace = await projectWorkspace({ test: 'vitest run' })
    const { ctx, subagents } = await createHarness()
    const agent = createTestAgent('canonical-flow-agent', workspace)
    ctx.agents.register(agent)
    const goal = ctx.goals.create(agent, { objective: 'exercise canonical tool flow', maxGoalRounds: 8 })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await enterStep(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_flow', { action: 'status' })).toMatchObject({
      isError: false,
      value: { lease: { flow: { stage: 'interview', cycle: 1 } } },
    })
    expect(await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace', intent: 'implementation', acceptanceCriteria: ['done'],
      tasks: [{ id: 'work', title: 'Work', description: 'Work', acceptanceCriteria: ['done'] }],
    })).toMatchObject({ isError: true, error: { message: expect.stringContaining('interview') } })
    expect(await executeTool(ctx, agent, 'autopilot_flow', { action: 'interview' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('requires summary') } })
    expect(await executeTool(ctx, agent, 'autopilot_flow', {
      action: 'interview',
      summary: 'The task is bounded.',
      decisions: ['Use the durable task graph.'],
      openQuestions: [],
    })).toMatchObject({ isError: false, value: { lease: { flow: { stage: 'planning' } } } })
    expect(await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace', intent: 'implementation', acceptanceCriteria: ['done'],
      tasks: [{ id: 'work', title: 'Work', description: 'Work', acceptanceCriteria: ['done'] }],
    })).toMatchObject({ isError: false })
    for (const role of ['metis', 'momus', 'oracle']) {
      subagents.outcomes.push({
        output: [],
        stopReason: 'completed',
        structured: {
          verdict: 'advice',
          summary: `${role} approved the plan`,
          findings: [],
          recommendations: [],
        },
      })
    }
    expect(await executeTool(ctx, agent, 'autopilot_flow', { action: 'harden' })).toMatchObject({
      isError: false,
      value: { lease: { flow: { stage: 'execution', planReview: { passed: true } } } },
    })
    expect(subagents.requests.map(request => request.label)).toEqual([
      'autopilot-specialist-metis',
      'autopilot-specialist-momus',
      'autopilot-specialist-oracle',
    ])
    const reviewPrompts = subagents.requests.map((request) => {
      const block = request.prompt[0]
      return block?.type === 'text' ? block.text : ''
    })
    expect(reviewPrompts).toHaveLength(3)
    expect(reviewPrompts.every(prompt => prompt.includes('Return concern only'))).toBe(true)
    expect(reviewPrompts.every(prompt => prompt.includes('unsafe, unexecutable, or unverifiable'))).toBe(true)
    expect(reviewPrompts.every(prompt => prompt.includes('parentExecutionSnapshot'))).toBe(true)
    expect(reviewPrompts.every(prompt => prompt.includes('host-supplied-parent-snapshot'))).toBe(true)
    expect(reviewPrompts.every(prompt => prompt.includes('child tool list are intentionally isolated'))).toBe(true)
    expect(reviewPrompts.every(prompt => prompt.includes(workspace))).toBe(true)
    expect(subagents.requests.every(request => !request.toolFilter?.allow?.includes('get_autopilot'))).toBe(true)
    const planSchema = ctx.tools.schemas().find(schema => schema.name === 'autopilot_plan')
    expect(JSON.stringify(planSchema)).toContain('status, attempts, and evidence are output-only runtime fields')
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 3 })
  })

  it('defaults omitted interview questions and records plan-review start failures without a child id', async () => {
    const { ctx, agent, subagents } = await createHarness()
    const goal = ctx.goals.create(agent, { objective: 'exercise canonical defaults', maxGoalRounds: 8 })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    expect(await executeTool(ctx, agent, 'autopilot_flow', {
      action: 'interview',
      summary: 'The task is bounded.',
      decisions: ['Use the durable task graph.'],
    })).toMatchObject({
      isError: false,
      value: { lease: { flow: { interview: { openQuestions: [] } } } },
    })
    expect(await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace', intent: 'implementation', acceptanceCriteria: ['done'],
      tasks: [{ id: 'work', title: 'Work', description: 'Work', acceptanceCriteria: ['done'] }],
    })).toMatchObject({ isError: false })
    subagents.outcomes.push(
      { startError: new Error('metis unavailable') },
      { startError: new Error('momus unavailable') },
      { startError: new Error('oracle unavailable') },
    )
    expect(await executeTool(ctx, agent, 'autopilot_flow', { action: 'harden' })).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: {
        lease: {
          flow: {
            stage: 'planning',
            planReview: { reviewers: [{ verdict: 'error' }, { verdict: 'error' }, { verdict: 'error' }] },
          },
        },
      },
    })
    const reviewers = ctx.autonomy.get(agent)?.flow.planReview?.reviewers ?? []
    expect(reviewers.every(reviewer => reviewer.childSessionId === undefined)).toBe(true)
  })

  it('returns a hostile plan-review concern to a new planning cycle', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace', intent: 'planning', acceptanceCriteria: ['the plan is hardened'],
      tasks: [{ id: 'plan', title: 'Plan', description: 'Plan the work', acceptanceCriteria: ['specific'] }],
    })).toMatchObject({ isError: false })
    for (const [role, verdict] of [
      ['metis', 'advice'], ['momus', 'concern'], ['oracle', 'advice'],
    ] as const) {
      subagents.outcomes.push({
        output: [],
        stopReason: 'completed',
        structured: {
          verdict,
          summary: `${role} verdict`,
          findings: verdict === 'concern' ? ['acceptance proof is vague'] : [],
          recommendations: verdict === 'concern' ? ['name the exact proof'] : [],
        },
      })
    }
    expect(await executeTool(ctx, agent, 'autopilot_flow', { action: 'harden' })).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: {
        lease: {
          reason: 'canonical plan review requires revision',
          flow: { stage: 'planning', cycle: 2, planReview: { passed: false } },
        },
      },
    })
  })

  it('creates, extends, reorders, and transitions a dependency graph through tools', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    expect((await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['release is verified'],
      tasks: [
        {
          id: 'build', title: 'Build', description: 'Build it',
          acceptanceCriteria: ['implementation exists'],
        },
        {
          id: 'test', title: 'Test', description: 'Test it',
          acceptanceCriteria: ['tests pass'], dependencies: ['build'],
        },
      ],
    })).isError).toBe(false)
    expect((await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'add',
      tasks: [{
        id: 'document', title: 'Document', description: 'Document it',
        acceptanceCriteria: ['docs exist'], dependencies: ['test'],
      }],
    })).isError).toBe(false)
    expect((await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'reorder', order: ['build', 'test', 'document'],
    })).isError).toBe(false)
    await approveTestPlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_task', { taskId: 'test', action: 'start' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('dependencies') } })

    for (const taskId of ['build', 'test', 'document']) {
      expect((await executeTool(ctx, agent, 'autopilot_task', { taskId, action: 'start' })).isError).toBe(false)
      expect((await executeTool(ctx, agent, 'autopilot_task', {
        taskId,
        action: 'complete',
        evidence: [{ kind: 'file', ref: `${taskId}.ts`, summary: `${taskId} inspected` }],
      })).isError).toBe(false)
    }
    expect(ctx.autonomy.get(agent)?.plan?.tasks.map(task => [task.id, task.status])).toEqual([
      ['build', 'completed'],
      ['test', 'completed'],
      ['document', 'completed'],
    ])
    expect(ctx.autonomy.get(agent)?.plan?.intent).toBe('implementation')
  })

  it('claims ready tasks, runs native DSH subagents, and durably settles their evidence', async () => {
    const { ctx, agent, subagents } = await createHarness({
      tools: {
        checks: [{ name: 'quality', command: 'pnpm test' }],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
        taskRoutes: [{
          role: 'implementation', subagentProvider: 'spawn',
          provider: 'deepseek', model: 'worker-model', persona: 'Worker.',
          fallbacks: [{ model: 'worker-fallback' }],
        }],
      },
    })
    await startAutopilot(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['both lanes complete'],
      tasks: [
        { id: 'api', title: 'API', description: 'Build API', acceptanceCriteria: ['API works'] },
        { id: 'docs', title: 'Docs', description: 'Write docs', acceptanceCriteria: ['docs work'] },
      ],
    })
    await approveTestPlan(ctx, agent)
    const result = await executeTool(ctx, agent, 'autopilot_delegate', {
      assignments: [
        { taskId: 'api', role: 'implementation', prompt: 'Implement the API.' },
        { taskId: 'docs', role: 'documentation', prompt: 'Write the docs.' },
      ],
    })

    expect(result).toMatchObject({
      isError: false,
      value: [
        { taskId: 'api', status: 'completed', evidence: [{ kind: 'subagent' }] },
        { taskId: 'docs', status: 'completed', evidence: [{ kind: 'subagent' }] },
      ],
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 2 })
    expect(ctx.autonomy.get(agent)?.plan?.tasks.every(task => task.status === 'completed')).toBe(true)
    expect(subagents.requests).toHaveLength(2)
    expect(subagents.requests[0]).toMatchObject({
      label: 'autopilot-api',
      maxDepth: 1,
      persona: 'Worker.',
      agentOptions: { provider: 'deepseek', model: 'worker-model' },
    })
    expect(subagents.disposed.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
  })

  it('lists packaged specialists and runs a budgeted managed read-only consultation', async () => {
    const { ctx, agent, subagents } = await createHarness({
      tools: {
        taskRoutes: [{ role: 'oracle', provider: 'deepseek', model: 'reasoner' }],
      },
    })
    const listed = await executeTool(ctx, agent, 'autopilot_specialist', { action: 'list' })
    expect(listed.isError).toBe(false)
    expect(listed.value).toMatchObject({
      specialists: expect.any(Array),
      categories: expect.any(Array),
    })
    const listedValue = listed.value as {
      specialists: Array<{ id: string, toolPolicy: string }>
      categories: Array<{ id: string }>
    }
    expect(listedValue.specialists).toContainEqual(expect.objectContaining({
      id: 'oracle', toolPolicy: 'read-only',
    }))
    expect(listedValue.categories).toContainEqual(expect.objectContaining({ id: 'ultrabrain' }))
    await startAutopilot(ctx, agent)
    subagents.outcomes.push({
      output: [],
      stopReason: 'completed',
      structured: {
        verdict: 'concern',
        summary: 'The lifecycle has a stale rearm window.',
        findings: ['Observer mutation is not rechecked.'],
        recommendations: ['Re-read the durable revision before arming.'],
      },
    })
    const result = await executeTool(ctx, agent, 'autopilot_specialist', {
      action: 'consult',
      specialistId: 'oracle',
      prompt: 'Review the resume lifecycle.',
      context: 'The sidecar publishes before native Goal rearm.',
    })
    expect(result).toMatchObject({
      isError: false,
      value: {
        specialistId: 'oracle',
        verdict: 'concern',
        childSessionId: 'dsh-autopilot-child-0',
      },
    })
    expect(ctx.autonomy.get(agent)?.subagentsStarted).toBe(1)
    expect(subagents.requests[0]).toMatchObject({
      label: 'autopilot-specialist-oracle',
      maxDepth: 1,
      agentOptions: { provider: 'deepseek', model: 'reasoner' },
      toolFilter: { allow: expect.not.arrayContaining(['bash', 'str_replace_editor']) },
    })
    expect(subagents.disposed[0]).toHaveBeenCalledOnce()
  })

  it('rejects incomplete specialist consultation requests before dispatch', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_specialist', { action: 'consult' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('requires specialistId') } })
    expect(subagents.requests).toHaveLength(0)
  })

  it('runs a specialist consultation without optional context', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    subagents.outcomes.push({
      output: [],
      stopReason: 'completed',
      structured: {
        verdict: 'advice',
        summary: 'The decision is sound.',
        findings: [],
        recommendations: [],
      },
    })
    expect(await executeTool(ctx, agent, 'autopilot_specialist', {
      action: 'consult', specialistId: 'oracle', prompt: 'Review the decision.',
    })).toMatchObject({ isError: false, value: { verdict: 'advice' } })
  })

  it('applies configured infrastructure fallback routes and charges the extra worker attempt', async () => {
    const { ctx, agent, subagents } = await createHarness({
      tools: {
        taskRoutes: [{
          role: 'implementation',
          subagentProvider: 'missing-primary',
          fallbacks: [{ subagentProvider: 'spawn', provider: 'backup-provider', model: 'backup-model' }],
        }],
      },
    })
    await startAutopilot(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['fallback task completes'],
      tasks: [{
        id: 'fallback', title: 'Fallback', description: 'Use the available worker',
        acceptanceCriteria: ['worker evidence exists'],
      }],
    })
    await approveTestPlan(ctx, agent)

    const result = await executeTool(ctx, agent, 'autopilot_delegate', {
      assignments: [{ taskId: 'fallback', role: 'implementation', prompt: 'Complete the task.' }],
    })

    expect(result).toMatchObject({
      isError: false,
      value: [{ status: 'completed', summary: expect.stringContaining('previous route failures') }],
    })
    expect(subagents.requests).toHaveLength(1)
    expect(subagents.requests[0]?.agentOptions).toEqual({ provider: 'backup-provider', model: 'backup-model' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 2 })
  })

  it('uses the lowest deployment-authored cost route in economy mode', async () => {
    const { ctx, agent, subagents } = await createHarness({
      tools: {
        taskRoutingPreference: 'economy',
        taskRoutes: [{
          role: 'implementation',
          subagentProvider: 'spawn',
          model: 'quality-model',
          costWeight: 100,
          fallbacks: [{ subagentProvider: 'spawn', model: 'economy-model', costWeight: 10 }],
        }],
      },
    })
    await startAutopilot(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['economy route completes'],
      tasks: [{
        id: 'economy', title: 'Economy', description: 'Use the economical worker',
        acceptanceCriteria: ['worker evidence exists'],
      }],
    })
    await approveTestPlan(ctx, agent)

    expect((await executeTool(ctx, agent, 'autopilot_delegate', {
      assignments: [{ taskId: 'economy', role: 'implementation', prompt: 'Complete economically.' }],
    })).isError).toBe(false)
    expect(subagents.requests[0]?.agentOptions).toEqual({ model: 'economy-model' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 1 })
  })

  it('returns actionable errors for missing operation-specific plan arguments', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_plan', { action: 'replace' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('requires intent') } })
    expect(await executeTool(ctx, agent, 'autopilot_plan', { action: 'add' }))
      .toMatchObject({ isError: true, error: { message: 'autopilot_plan add requires tasks' } })
    expect(await executeTool(ctx, agent, 'autopilot_plan', { action: 'reorder' }))
      .toMatchObject({ isError: true, error: { message: 'autopilot_plan reorder requires order' } })
  })

  it('projects task blockers into status without inventing evidence', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'planning',
      acceptanceCriteria: ['human input arrives'],
      tasks: [{ id: 'decision', title: 'Decision', description: 'Wait', acceptanceCriteria: ['decided'] }],
    })
    await approveTestPlan(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_task', { taskId: 'decision', action: 'start' })
    await executeTool(ctx, agent, 'autopilot_task', {
      taskId: 'decision', action: 'block', reason: 'human decision required',
    })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { lease: { plan: { intent: 'planning', tasks: [{ status: 'blocked', reason: 'human decision required' }] } } },
    })
  })
})

describe('independent completion verifier', () => {
  it('reuses an identical frozen policy after restart without persisting check credentials', async () => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-policy-same-')))
    projectRoots.push(storageRoot)
    const agentId = 'verification-policy-same'
    const cwd = '/deployment/workspace'
    const first = await createHarness({
      storageRoot,
      agentId,
      cwd,
      tools: strictVerificationConfig(),
    })
    const goal = await startAutopilot(first.ctx, first.agent)
    await enterStep(first.ctx, first.agent)
    await completePlan(first.ctx, first.agent)
    const frozen = first.ctx.autonomy.get(first.agent)?.verificationPolicy
    expect(frozen).toMatchObject({
      workspace: cwd,
      minimumEvidenceItems: 2,
      maxOutputChars: 16,
      fixedChecks: [
        { name: 'tests', commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), timeoutMs: 12_345 },
        { name: 'types', commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), timeoutMs: 23_456 },
      ],
      projectCheckTimeoutMs: 34_567,
      reviewers: [
        {
          role: 'requirements',
          primary: { subagentProvider: 'spawn', provider: 'deepseek', model: 'strict-reviewer' },
          fallbacks: [{ subagentProvider: 'spawn', provider: 'backup', model: 'backup-reviewer' }],
        },
        { role: 'security', primary: { subagentProvider: 'spawn' }, fallbacks: [] },
      ],
    })
    expect(JSON.stringify(first.ctx.autonomy.history(first.agent))).not.toContain('SUPER_SECRET')
    await first.ctx.fiber.dispose()

    const reopened = await createHarness({
      storageRoot,
      agentId,
      cwd,
      tools: strictVerificationConfig(),
    })
    restoreGoal(reopened.agent, goal)
    await reopened.ctx.autonomy.resume(reopened.agent, goal.id)
    reopened.ctx.goals.resume(reopened.agent, reopened.ctx.goals.get(reopened.agent)!)
    await enterStep(reopened.ctx, reopened.agent)
    expect(reopened.ctx.autonomy.get(reopened.agent)?.verificationPolicy).toEqual(frozen)
    expect(await executeTool(reopened.ctx, reopened.agent, 'autopilot_verify', {
      summary: 'strict policy still passes',
      evidence: ['tests', 'types'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass' } })
    expect(reopened.shell.requests.map(request => request.workdir)).toEqual([cwd, cwd])
  })

  it('moves a resumed run to needs-attention when deployment policy is weakened', async () => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-policy-drift-')))
    projectRoots.push(storageRoot)
    const agentId = 'verification-policy-drift'
    const first = await createHarness({
      storageRoot,
      agentId,
      tools: strictVerificationConfig(),
    })
    const goal = await startAutopilot(first.ctx, first.agent)
    await enterStep(first.ctx, first.agent)
    await completePlan(first.ctx, first.agent)
    const frozen = first.ctx.autonomy.get(first.agent)?.verificationPolicy
    await first.ctx.fiber.dispose()

    const weakened = await createHarness({
      storageRoot,
      agentId,
      tools: {
        minimumEvidenceItems: 0,
        maxOutputChars: 100_000,
        checks: [],
        autoDiscoverChecks: false,
        reviewers: [{ role: 'requirements', description: 'Minimal review.' }],
      },
    })
    restoreGoal(weakened.agent, goal)
    await weakened.ctx.autonomy.resume(weakened.agent, goal.id)
    weakened.ctx.goals.resume(weakened.agent, weakened.ctx.goals.get(weakened.agent)!)

    await expect(enterStep(weakened.ctx, weakened.agent)).rejects.toThrow('verification policy drift')
    expect(weakened.ctx.autonomy.get(weakened.agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      verificationPolicy: frozen,
      reason: expect.stringContaining('verification policy drift'),
    })
    expect(await executeTool(weakened.ctx, weakened.agent, 'autopilot_verify', {
      summary: 'cannot bypass strict policy',
      evidence: [],
    })).toMatchObject({ isError: true })
    expect(weakened.shell.requests).toEqual([])
    expect(weakened.subagents.requests).toEqual([])
  })

  it('completes only after the plan, fixed checks, and fresh reviewer quorum pass', async () => {
    const { ctx, agent, shell, subagents } = await createHarness({
      tools: {
        checks: [
          { name: 'tests', command: 'pnpm test', timeoutMs: 10_000 },
          { name: 'types', command: 'pnpm typecheck', timeoutMs: 20_000 },
        ],
        reviewers: [
          { role: 'requirements', description: 'Audit requirements.' },
          { role: 'security', description: 'Audit security.' },
        ],
      },
    })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
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
      value: {
        verdict: 'pass',
        checks: [{ passed: true }, { passed: true }],
        reviewers: [{ verdict: 'pass' }, { verdict: 'pass' }],
        goal: { phase: 'complete' },
      },
    })
    expect(result.concludesTurn).toBe(true)
    expect(result.additionalContexts).toBeUndefined()
    expect(agent.followup).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^dsh-autopilot:run-.*:completion$/u),
      source: { kind: 'plugin', plugin: 'dsh-autopilot', form: 'notice', summary: expect.any(String) },
      content: [{ type: 'text', text: expect.stringContaining('Deliver the final user-facing completion report') }],
    }))
    expect(shell.requests.map(request => request.command)).toEqual(['pnpm test', 'pnpm typecheck'])
    expect(subagents.requests.map(request => request.label)).toEqual([
      'autopilot-review-requirements',
      'autopilot-review-security',
    ])
    expect(subagents.requests.every(request => !request.toolFilter?.allow?.includes('get_autopilot'))).toBe(true)
    expect(subagents.requests.every(request => !request.toolFilter?.allow?.includes('get_goal'))).toBe(true)
    expect(subagents.requests.every((request) => {
      const block = request.prompt[0]
      return block?.type === 'text'
        && block.text.includes('host-supplied-parent-snapshot')
        && block.text.includes('child-local Goal or Autopilot state')
        && block.text.includes('deterministicChecks')
        && block.text.includes('tests passed')
    })).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'complete', activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'completed',
      activation: 'disarmed',
      completionReported: false,
      verificationAttempts: 1,
      subagentsStarted: 2,
      verificationHistory: [{ verdict: 'pass' }],
    })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: {
        lease: {
          verificationHistory: [{
            verdict: 'pass',
            reviewers: [
              { role: 'requirements', childSessionId: 'dsh-autopilot-child-0' },
              { role: 'security', childSessionId: 'dsh-autopilot-child-1' },
            ],
          }],
        },
      },
    })
    emitCompletionTurn(ctx, agent)
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ completionReported: true })
    })
  })

  it('retains cleanup debt and refuses completion when cleanup and attention writes keep failing', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'completion-cleanup-plugin',
      packageId: 'completion-cleanup-package',
      hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    const undefine = vi.spyOn(dynamicCordisRunner, 'undefine')
      .mockRejectedValue(new Error('completion cleanup unavailable'))
    vi.spyOn(ctx.autonomy, 'markNeedsAttention')
      .mockRejectedValue(new Error('attention persistence unavailable'))
    const beginFinalization = vi.spyOn(ctx.autonomy, 'beginFinalization')

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'Everything is implemented.',
      evidence: ['focused checks passed'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('attention persistence unavailable') },
    })
    expect(beginFinalization).not.toHaveBeenCalled()
    expect(undefine.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'blocked', activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused',
      activation: 'disarmed',
      completionReported: false,
      reason: expect.stringContaining('attention persistence unavailable'),
    })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('dynamic cleanup is still pending') },
    })

    undefine.mockResolvedValue({ ok: true, wasRunning: true })
    await expect(enterStep(ctx, agent)).resolves.toMatchObject({ kind: 'enter' })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({ isError: false })
  })

  it('uses configured reviewer fallback routes and charges the extra fresh reviewer', async () => {
    const { ctx, agent, subagents } = await createHarness({
      tools: {
        autoDiscoverChecks: false,
        reviewers: [{
          role: 'requirements',
          description: 'Audit requirements.',
          subagentProvider: 'missing-primary',
          fallbacks: [{ subagentProvider: 'spawn', provider: 'backup-provider', model: 'backup-model' }],
        }],
      },
    })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'Everything is implemented.',
      evidence: ['reviewable workspace evidence'],
    })).toMatchObject({
      isError: false,
      value: { verdict: 'pass' },
    })
    expect(subagents.requests).toHaveLength(1)
    expect(subagents.requests[0]?.agentOptions).toEqual({ provider: 'backup-provider', model: 'backup-model' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ subagentsStarted: 2, phase: 'completed' })
  })

  it('retains an unacknowledged completion notice and retries on the next final response', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    emitAssistantMessage(ctx, agent, 'An unrelated earlier response.')
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    vi.spyOn(ctx.autonomy, 'markCompletionReported')
      .mockRejectedValueOnce(new Error('completion acknowledgement unavailable'))

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'Everything is implemented.',
      evidence: ['focused checks passed'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass' } })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'completed', completionReported: false })
    emitTurnEnd(ctx, agent)
    emitCompletionTurn(ctx, agent, 'First delivery attempt.')
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(expect.stringContaining('completion acknowledgement unavailable'))
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ completionReported: false })

    emitAssistantMessage(ctx, agent, 'Retry delivery.')
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ completionReported: true })
    })
  })

  it('rejects incomplete plans before running deterministic checks', async () => {
    const { ctx, agent, shell } = await createHarness()
    await startAutopilot(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'repair',
      acceptanceCriteria: ['done'],
      tasks: [{ id: 'work', title: 'Work', description: 'Work', acceptanceCriteria: ['done'] }],
    })
    await approveTestPlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'not actually done', evidence: ['claim'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('every planned task must be completed') },
    })
    expect(shell.requests).toHaveLength(0)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'blocked', activation: 'disarmed' })
  })

  it('returns bounded fixed-check findings, skips reviewers, and starts a repair round', async () => {
    const { ctx, agent, shell, subagents } = await createHarness({
      tools: {
        maxOutputChars: 4,
        checks: [{ name: 'tests', command: 'test command' }],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
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
          passed: false,
          stdout: { text: '5678', truncated: true },
          stderr: { text: 'efgh', truncated: true },
          sandbox: { denied: true, enforcement: 'full', runnerFailed: true },
        }],
        reviewers: [{ role: 'requirements', verdict: 'pass' }],
      },
    })
    expect(subagents.requests).toHaveLength(1)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'running',
      activation: 'armed',
      verificationHistory: [{ verdict: 'fail' }],
    })
  })

  it.each([
    ['fail', ['a concrete defect']],
    ['inconclusive', []],
  ] as const)('returns reviewer %s as a repair result', async (verdict, findings) => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    subagents.outcomes.push(reviewer(verdict, [...findings]))

    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['focused test'],
    })
    expect(result).toMatchObject({
      isError: false,
      concludesTurn: true,
      value: {
        verdict,
        reviewers: [{ verdict }],
        findings: verdict === 'inconclusive'
          ? ['Verification did not produce a conclusive passing result.']
          : findings,
      },
    })
    expect(ctx.autonomy.get(agent)?.verificationHistory.at(-1)?.verdict).toBe(verdict)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
  })

  it('fails closed when a reviewer returns an invalid result', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    subagents.outcomes.push({ output: [], stopReason: 'completed', structured: { verdict: 'pass' } })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['focused test'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('reviewer failed') },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused', activation: 'disarmed', verificationHistory: [{ verdict: 'error' }],
    })
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked', activation: 'disarmed', blockedReason: { code: 'verifier-error' },
    })
  })

  it('retains reviewer start failures without inventing a child session id', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    subagents.outcomes.push({ startError: new Error('reviewer provider unavailable') })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['focused test'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('reviewer failed') },
    })
    const status = await executeTool(ctx, agent, 'get_autopilot')
    expect(status).toMatchObject({
      isError: false,
      value: { lease: { verificationHistory: [{ reviewers: [{ verdict: 'error' }] }] } },
    })
    const reviewerStatus = ((status.value as {
      lease: { verificationHistory: Array<{ reviewers: Array<Record<string, unknown>> }> }
    }).lease.verificationHistory[0]?.reviewers[0])
    expect(reviewerStatus).not.toHaveProperty('childSessionId')
  })

  it('returns an interrupted reviewer start as inconclusive without a child id', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    const abort = new AbortController()
    vi.spyOn(subagents, 'start').mockImplementation(async () => {
      abort.abort()
      throw new Error('review cancelled before publication')
    })

    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['focused test'],
    }, abort.signal)
    expect(result).toMatchObject({ isError: true })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'running',
      verificationHistory: [{ verdict: 'inconclusive', reviewers: [{ verdict: 'inconclusive' }] }],
    })
    const reviewerRecord = ctx.autonomy.get(agent)?.verificationHistory[0]?.reviewers[0]
    expect(reviewerRecord)
      .not.toHaveProperty('childSessionId')
  })

  it('persists verifier infrastructure errors and blocks the Goal', async () => {
    const { ctx, agent, shell } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    shell.outcomes.push(new Error('shell backend unavailable'))

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['focused test'],
    })).toMatchObject({ isError: true, error: { message: 'shell backend unavailable' } })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused', activation: 'disarmed', reason: expect.stringContaining('shell backend unavailable'),
      verificationHistory: [{ verdict: 'error', findings: ['shell backend unavailable'] }],
    })
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked', blockedReason: { code: 'verifier-error', message: 'shell backend unavailable' },
    })
  })

  it('validates candidate evidence before changing Goal or lease activation', async () => {
    const { ctx, agent } = await createHarness({
      tools: {
        minimumEvidenceItems: 2,
        checks: [{ name: 'quality', command: 'quality' }],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', { summary: ' ', evidence: ['one', 'two'] }))
      .toMatchObject({ isError: true, error: { message: 'verification summary must not be empty' } })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['one', '  '],
    })).toMatchObject({ isError: true, error: { message: expect.stringContaining('at least 2') } })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
  })

  it('refuses completion while any managed auxiliary ledger is unresolved', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    ctx.provide('autopilotTeam', {
      listRun: () => [{ taskId: 'team-task', phase: 'reporting' }],
    } as never)
    ctx.provide('autopilotRalph', {
      listRun: () => [{ taskId: 'ralph-task', phase: 'needs-attention' }],
    } as never)
    ctx.provide('autopilotWorkflows', {
      listRun: () => [{ workflowId: 'workflow-id', phase: 'uncertain' }],
    } as never)

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringMatching(/team:team-task:reporting.*ralph:ralph-task:needs-attention.*workflow:workflow-id:uncertain/u) },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
  })

  it('accepts every terminal managed auxiliary phase before verification', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    ctx.provide('autopilotTeam', {
      listRun: () => [
        { taskId: 'settled-team', phase: 'settled' },
        { taskId: 'failed-team', phase: 'failed' },
      ],
    } as never)
    ctx.provide('autopilotRalph', {
      listRun: () => ['completed', 'blocked', 'failed', 'cancelled'].map((phase, index) => ({
        taskId: `ralph-${index}`,
        phase,
      })),
    } as never)
    ctx.provide('autopilotWorkflows', {
      listRun: () => ['completed', 'partial-failure', 'cancelled', 'error'].map((phase, index) => ({
        workflowId: `workflow-${index}`,
        phase,
      })),
    } as never)

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'all managed work is quiescent', evidence: ['quality output'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass' } })
  })

  it('verifies without Mission when the optional Mission service is absent', async () => {
    const { ctx, agent } = await createHarness({ missionService: false })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'no Mission is active', evidence: ['quality output'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass' } })
  })

  it('requires the current Goal to remain armed before verification starts', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    ctx.goals.disarm(agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('fail-closed') },
    })
    await enterStep(ctx, agent)
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'autopilot_verify requires the current armed Goal and its active lease' },
    })
  })

  it('fails closed if the Goal changes while passing checks run', async () => {
    const { ctx, agent, shell } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    vi.spyOn(shell, 'run').mockImplementation(async () => {
      ctx.goals.pause(agent, ctx.goals.get(agent)!)
      return shellResult()
    })
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Goal changed while verification was running' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('fails closed if the Autopilot run changes while checks run', async () => {
    const { ctx, agent, shell, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    vi.spyOn(shell, 'run').mockImplementation(async () => {
      await ctx.autonomy.pause(agent, 'operator paused during checks')
      return shellResult()
    })
    const start = vi.spyOn(subagents, 'start')

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Autopilot run changed while verification checks were running' },
    })
    expect(start).not.toHaveBeenCalled()
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('fails closed if the Goal changes while independent reviewers run', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    const start = subagents.start.bind(subagents)
    vi.spyOn(subagents, 'start').mockImplementation(async (request) => {
      const run = await start(request)
      ctx.goals.pause(agent, ctx.goals.get(agent)!)
      return run
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Goal or Autopilot run changed while code review was running' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
  })

  it('fails closed if the Autopilot run changes before dynamic cleanup starts', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    const start = subagents.start.bind(subagents)
    vi.spyOn(subagents, 'start').mockImplementation(async (request) => {
      const run = await start(request)
      await ctx.autonomy.pause(agent, 'reviewer changed the run')
      return run
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Goal or Autopilot run changed while code review was running' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('detects an Autopilot pause after checks and before dynamic cleanup', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    const beginQualityAssurance = ctx.autonomy.beginQualityAssurance.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'beginQualityAssurance').mockImplementation(async (currentAgent) => {
      const view = await beginQualityAssurance(currentAgent)
      await ctx.autonomy.pause(agent, 'operator paused after checks')
      return view
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Autopilot run changed before dynamic cleanup could start' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('detects a Goal pause after reviewers pass and before cleanup', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    const beginQualityAssurance = ctx.autonomy.beginQualityAssurance.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'beginQualityAssurance').mockImplementation(async (currentAgent) => {
      const view = await beginQualityAssurance(currentAgent)
      ctx.goals.pause(agent, ctx.goals.get(agent)!)
      return view
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Goal changed while verification was running' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('detects a Goal pause performed while dynamic cleanup succeeds', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'goal-drift-plugin',
      packageId: 'goal-drift-package',
      hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    vi.spyOn(ctx.autonomy, 'markNeedsAttention').mockResolvedValue()
    vi.spyOn(dynamicCordisRunner, 'undefine').mockImplementation(async () => {
      ctx.goals.pause(agent, ctx.goals.get(agent)!)
      return { ok: true, wasRunning: true }
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'stale candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Goal changed while verification was running' },
    })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('reports the durable attention reason when dynamic cleanup prevents completion', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'verification-cleanup-plugin',
      packageId: 'verification-cleanup-package',
      hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    vi.spyOn(dynamicCordisRunner, 'undefine')
      .mockRejectedValue(new Error('verification cleanup unavailable'))

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining(
        'Dynamic extension cleanup prevented completion: dynamic cleanup failed',
      ) },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: expect.stringContaining('failed to retract 1 native Host Plugin contribution'),
    })
  })

  it('reports cleanup state loss without fabricating a reason', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'lost-cleanup-plugin',
      packageId: 'lost-cleanup-package',
      hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    const get = ctx.autonomy.get.bind(ctx.autonomy)
    let hideRun = false
    vi.spyOn(ctx.autonomy, 'get').mockImplementation((subject) => hideRun ? undefined : get(subject))
    vi.spyOn(dynamicCordisRunner, 'undefine').mockImplementation(async () => {
      hideRun = true
      return { ok: true, wasRunning: true }
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: true,
      error: { message: 'Dynamic extension cleanup prevented completion' },
    })
  })

  it('does not resume a Goal paused after a failed verification settles', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    subagents.outcomes.push(reviewer('fail', ['repair required']))
    const settle = ctx.autonomy.verificationFailed.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'verificationFailed').mockImplementation(async (...args) => {
      const view = await settle(...args)
      ctx.goals.pause(agent, ctx.goals.get(agent)!)
      return view
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({
      isError: false,
      value: { verdict: 'fail' },
    })
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('does not resume a Goal paused after a failed deterministic check settles', async () => {
    const { ctx, agent, shell } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    shell.outcomes.push(shellResult({ exitCode: 1 }))
    const settle = ctx.autonomy.verificationFailed.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'verificationFailed').mockImplementation(async (...args) => {
      const view = await settle(...args)
      ctx.goals.pause(agent, ctx.goals.get(agent)!)
      return view
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({ isError: false, value: { verdict: 'fail' } })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('pauses and blocks when the durable verification budget is exhausted', async () => {
    const { ctx, agent, shell } = await createHarness({
      autonomy: { maxVerificationAttempts: 1 },
    })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    shell.outcomes.push(shellResult({ exitCode: 1 }))
    expect((await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'first candidate', evidence: ['failed check'],
    })).isError).toBe(false)

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'second candidate', evidence: ['same check'],
    })).toMatchObject({
      isError: true,
      error: { message: 'verification attempt budget exhausted (1)' },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused', activation: 'disarmed', reason: 'verification attempt budget exhausted (1)',
    })
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'verification-attempts-exhausted' },
    })
  })

  it('disarms the Goal if verifier-error blocking itself fails', async () => {
    const { ctx, agent, shell } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    shell.outcomes.push(new Error('verifier unavailable'))
    vi.spyOn(ctx.goals, 'block').mockImplementation(() => {
      throw new Error('Goal store unavailable')
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({ isError: true, error: { message: 'verifier unavailable' } })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('uses the Agent workspace for fixed checks and preserves optional sandbox detail', async () => {
    const { ctx, shell } = await createHarness({
      tools: {
        autoDiscoverChecks: false,
        checks: [{ name: 'quality', command: 'pnpm test' }],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const agent = createTestAgent('workspace-agent', '/workspace/project')
    ctx.agents.register(agent)
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    shell.outcomes.push(shellResult({ sandbox: { mode: 'workspace-write', denied: false } }))
    const result = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'workspace verified', evidence: ['quality output'],
    })
    expect(shell.requests[0]?.workdir).toBe('/workspace/project')
    expect(result).toMatchObject({
      isError: false,
      value: { checks: [{ sandbox: { mode: 'workspace-write', denied: false } }] },
    })
  })

  it('discovers finite repository-native checks and runs them from the canonical workspace', async () => {
    const workspace = await projectWorkspace({ typecheck: 'ignored manifest body', test: 'also ignored' })
    const { ctx, shell } = await createHarness({
      tools: {
        checks: [],
        autoDiscoverChecks: true,
        projectCheckTimeoutMs: 4321,
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const agent = createTestAgent('discovery-agent', workspace)
    ctx.agents.register(agent)
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'project recipes pass', evidence: ['manifest discovery'],
    })).toMatchObject({
      isError: false,
      value: {
        verdict: 'pass',
        checks: [
          { name: 'project/js:typecheck', passed: true },
          { name: 'project/js:test', passed: true },
        ],
      },
    })
    expect(shell.requests.map(request => ({
      command: request.command, workdir: request.workdir, timeoutMs: request.timeoutMs,
    }))).toEqual([
      { command: 'npm run typecheck', workdir: workspace, timeoutMs: 4321 },
      { command: 'npm run test', workdir: workspace, timeoutMs: 4321 },
    ])
  })

  it('freezes project checks before the first model step and rejects a weakened manifest', async () => {
    const workspace = await projectWorkspace({ test: 'vitest run' })
    const { ctx, shell } = await createHarness({
      tools: {
        checks: [],
        autoDiscoverChecks: true,
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const agent = createTestAgent('baseline-agent', workspace)
    ctx.agents.register(agent)
    await startAutopilot(ctx, agent)

    await enterStep(ctx, agent)
    const frozen = ctx.autonomy.get(agent)?.verificationBaseline
    expect(frozen).toMatchObject({
      kind: 'project',
      workspace,
      checks: [{ id: 'js:test', command: 'npm run test' }],
      manifests: [{ name: 'package.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
    })
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).contexts
      .find(item => item.name === 'dsh-autopilot:autopilot')?.text)
      .toContain('Verification baseline: 1 frozen project check(s)')
    await completePlan(ctx, agent)

    await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
    const rejected = await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'weakened candidate', evidence: ['manifest was edited'],
    })
    expect(rejected).toMatchObject({
      isError: false,
      value: {
        verdict: 'fail',
        checks: [{
          name: 'project/verification-baseline',
          passed: false,
          stderr: { text: expect.stringContaining('package.json changed after the baseline was frozen') },
        }],
      },
    })
    expect(shell.requests).toEqual([])
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'running',
      verificationBaseline: frozen,
      verificationHistory: [{
        verdict: 'fail',
        findings: [expect.stringContaining('package.json changed after the baseline was frozen')],
      }],
    })
  })

  it('rejects manifest drift that occurs while frozen checks are executing', async () => {
    const workspace = await projectWorkspace({ test: 'vitest run' })
    const { ctx, shell } = await createHarness({
      tools: {
        checks: [],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const agent = createTestAgent('baseline-race-agent', workspace)
    ctx.agents.register(agent)
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)
    await completePlan(ctx, agent)
    vi.spyOn(shell, 'run').mockImplementationOnce(async (spec) => {
      shell.requests.push(spec)
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
      return shellResult()
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'racing candidate', evidence: ['check output'],
    })).toMatchObject({
      isError: false,
      value: {
        verdict: 'fail',
        checks: [
          { name: 'project/js:test', passed: true },
          { name: 'project/verification-baseline', passed: false },
        ],
      },
    })
  })

  it('rejects manifest drift that occurs while independent reviewers run', async () => {
    const workspace = await projectWorkspace({ test: 'vitest run' })
    const { ctx, shell, subagents } = await createHarness({
      tools: {
        checks: [],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const agent = createTestAgent('baseline-review-race-agent', workspace)
    ctx.agents.register(agent)
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)
    await completePlan(ctx, agent)
    vi.spyOn(shell, 'run').mockResolvedValue(shellResult())
    const start = subagents.start.bind(subagents)
    vi.spyOn(subagents, 'start').mockImplementation(async (request) => {
      const run = await start(request)
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
      return run
    })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'racing candidate', evidence: ['review output'],
    })).toMatchObject({
      isError: false,
      value: {
        verdict: 'fail',
        checks: [
          { name: 'project/js:test', passed: true },
          { name: 'project/verification-baseline', passed: false },
        ],
      },
    })
  })

  it('records why automatic project verification has no runnable recipe', async () => {
    const empty = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-tools-empty-')))
    projectRoots.push(empty)
    const manifestOnly = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-tools-manifest-')))
    projectRoots.push(manifestOnly)
    await writeFile(join(manifestOnly, 'package.json'), JSON.stringify({ scripts: {} }))
    const { ctx } = await createHarness({
      tools: { checks: [], autoDiscoverChecks: true },
    })
    const emptyAgent = createTestAgent('empty-project-agent', empty)
    const manifestAgent = createTestAgent('manifest-only-agent', manifestOnly)
    ctx.agents.register(emptyAgent)
    ctx.agents.register(manifestAgent)
    await startAutopilot(ctx, emptyAgent)
    await startAutopilot(ctx, manifestAgent)

    await enterStep(ctx, emptyAgent)
    await enterStep(ctx, manifestAgent)
    expect(ctx.autonomy.get(emptyAgent)?.verificationBaseline).toMatchObject({
      kind: 'reviewer-only', reason: 'no-supported-project', manifests: [], checks: [],
    })
    expect(ctx.autonomy.get(manifestAgent)?.verificationBaseline).toMatchObject({
      kind: 'reviewer-only',
      reason: 'no-supported-project-checks',
      manifests: [{ name: 'package.json' }],
      checks: [],
    })
  })

  it('supports reviewer-only verification when discovery is disabled', async () => {
    const { ctx, agent, shell } = await createHarness({
      tools: {
        checks: [],
        autoDiscoverChecks: false,
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)
    expect(ctx.autonomy.get(agent)?.verificationBaseline).toMatchObject({
      kind: 'reviewer-only',
      reason: 'project-check-discovery-disabled',
      checks: [],
    })
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).contexts
      .find(item => item.name === 'dsh-autopilot:autopilot')?.text)
      .toContain('reviewer-only (project-check-discovery-disabled)')
    await completePlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'reviewed candidate', evidence: ['task evidence'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass', checks: [] } })
    expect(shell.requests).toEqual([])
  })

  it('fails loud for unavailable, over-cap, or workspace-free explicit project recipes', async () => {
    const unavailableWorkspace = await projectWorkspace({ test: 'ignored' })
    const unavailable = await createHarness({
      tools: {
        checks: [],
        projectChecks: ['js:build'],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const unavailableAgent = createTestAgent('unavailable-check-agent', unavailableWorkspace)
    unavailable.ctx.agents.register(unavailableAgent)
    await startAutopilot(unavailable.ctx, unavailableAgent)
    await completePlan(unavailable.ctx, unavailableAgent)
    expect(await executeTool(unavailable.ctx, unavailableAgent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['task evidence'],
    })).toMatchObject({
      isError: true,
      error: { message: 'explicit project checks are unavailable: js:build' },
    })

    const cappedWorkspace = await projectWorkspace({ typecheck: 'ignored', test: 'ignored' })
    const capped = await createHarness({
      tools: {
        checks: [],
        projectChecks: ['js:typecheck', 'js:test'],
        maxProjectChecks: 1,
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const cappedAgent = createTestAgent('capped-check-agent', cappedWorkspace)
    capped.ctx.agents.register(cappedAgent)
    await startAutopilot(capped.ctx, cappedAgent)
    await completePlan(capped.ctx, cappedAgent)
    expect(await executeTool(capped.ctx, cappedAgent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['task evidence'],
    })).toMatchObject({
      isError: true,
      error: { message: 'explicit project checks exceed maxProjectChecks: js:test' },
    })

    const noWorkspace = await createHarness({
      tools: {
        checks: [],
        projectChecks: ['js:test'],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    await startAutopilot(noWorkspace.ctx, noWorkspace.agent)
    await completePlan(noWorkspace.ctx, noWorkspace.agent)
    expect(await executeTool(noWorkspace.ctx, noWorkspace.agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['task evidence'],
    })).toMatchObject({
      isError: true,
      error: { message: 'explicit projectChecks require an Agent workspace' },
    })

    const availableWorkspace = await projectWorkspace({ test: 'ignored' })
    const available = await createHarness({
      tools: {
        checks: [],
        projectChecks: ['js:test'],
        reviewers: [{ role: 'requirements', description: 'Audit requirements.' }],
      },
    })
    const availableAgent = createTestAgent('available-check-agent', availableWorkspace)
    available.ctx.agents.register(availableAgent)
    await startAutopilot(available.ctx, availableAgent)
    await completePlan(available.ctx, availableAgent)
    expect(await executeTool(available.ctx, availableAgent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['task evidence'],
    })).toMatchObject({
      isError: false,
      value: { verdict: 'pass', checks: [{ name: 'project/js:test', passed: true }] },
    })
  })
})

describe('autonomy guards', () => {
  it('leaves native definitions untouched outside an active Autopilot run', async () => {
    const { ctx, agent } = await createHarness()
    registerTool(ctx, 'cordis_define', () => null)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false, value: null })
  })

  it('owns completion and denies native Cordis mutation during Host-only Autopilot', async () => {
    const { ctx, agent } = await createHarness()
    for (const name of ['update_goal', 'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']) {
      registerTool(ctx, name)
    }
    await startAutopilot(ctx, agent)

    expect(await executeTool(ctx, agent, 'update_goal', { action: 'complete' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('controller-owned') } })
    expect(await executeTool(ctx, agent, 'update_goal', { action: 'blocked' }))
      .toMatchObject({ isError: true, error: { message: expect.stringContaining('controller-owned') } })
    for (const name of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']) {
      expect(await executeTool(ctx, agent, name)).toMatchObject({
        isError: true,
        error: { message: expect.stringContaining('durable autopilot_cordis_apply/remove') },
      })
    }
  })

  it('denies every Autopilot mutation tool when the native Goal half is absent', async () => {
    const { ctx, agent } = await createHarness()
    for (const name of [
      'cordis_define',
      'cordis_run',
      'cordis_stop',
      'cordis_undefine',
      'send_message',
      'interrupt_agent',
      'update_goal',
      'read',
    ]) registerTool(ctx, name)
    await startAutopilot(ctx, agent)
    const getGoal = vi.spyOn(ctx.goals, 'get').mockReturnValue(undefined)

    for (const name of [
      'autopilot_plan',
      'cordis_define',
      'cordis_run',
      'cordis_stop',
      'cordis_undefine',
      'send_message',
      'interrupt_agent',
    ]) {
      expect(await executeTool(ctx, agent, name)).toMatchObject({
        isError: true,
        error: { message: expect.stringContaining('fail-closed') },
      })
    }
    for (const action of ['complete', 'blocked']) {
      expect(await executeTool(ctx, agent, 'update_goal', { action })).toMatchObject({
        isError: true,
        error: { message: expect.stringContaining('fail-closed') },
      })
    }
    expect(await executeTool(ctx, agent, 'update_goal', { action: 'inspect' }))
      .toMatchObject({ isError: false, value: { action: 'inspect' } })
    expect(await executeTool(ctx, agent, 'read')).toMatchObject({ isError: false })
    await enterStep(ctx, agent)
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    })
    expect(agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot Goal reconciliation' },
      { keepInbox: true },
    )
    getGoal.mockRestore()
  })

  it('coalesces concurrent reconciliation attempts for the same diverged Goal', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    const getGoal = vi.spyOn(ctx.goals, 'get').mockReturnValue(undefined)
    const release = Promise.withResolvers<void>()
    const mark = ctx.autonomy.markNeedsAttention.bind(ctx.autonomy)
    const reconcile = vi.spyOn(ctx.autonomy, 'markNeedsAttention').mockImplementation(async (...args) => {
      await release.promise
      return mark(...args)
    })

    const first = enterStep(ctx, agent, 1)
    await vi.waitFor(() => { expect(reconcile).toHaveBeenCalledTimes(1) })
    const second = enterStep(ctx, agent, 2)
    release.resolve()
    await Promise.all([first, second])

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention' })
    getGoal.mockRestore()
  })

  it('denies every tool except autopilot_verify while verification is in progress', async () => {
    const { ctx, agent } = await createHarness()
    registerTool(ctx, 'read')
    registerTool(ctx, 'create_goal')
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    await enterStep(ctx, agent)
    await ctx.autonomy.beginVerification(agent, { summary: 'candidate', evidence: ['test'] })
    await enterStep(ctx, agent, 1)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('create_goal')
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).contexts
      .find(item => item.name === 'dsh-autopilot:autopilot')?.text).toContain('Autopilot is authorized')
    expect(await executeTool(ctx, agent, 'read')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('verification is in progress') },
    })
  })

  it('rejects unmanaged orchestration while an Autopilot Goal is active', async () => {
    const { ctx, agent } = await createHarness()
    const unmanaged = [
      'subagent', 'subagent_custom', 'workflow', 'ralph', 'schedule_create',
      'send_message', 'interrupt_agent',
    ]
    for (const name of unmanaged) registerTool(ctx, name)
    await startAutopilot(ctx, agent)

    for (const name of unmanaged) {
      expect(await executeTool(ctx, agent, name)).toMatchObject({
        isError: true,
        error: { message: expect.stringContaining('autopilot_delegate') },
      })
    }
  })

  it('attributes managed task workers and reviewers without triggering the native-start audit', async () => {
    const { ctx, agent, subagents } = await createHarness()
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)
    expect((await executeTool(ctx, agent, 'autopilot_plan', {
      action: 'replace',
      intent: 'implementation',
      acceptanceCriteria: ['managed work is independently reviewed'],
      tasks: [{
        id: 'managed',
        title: 'Managed work',
        description: 'Delegate through the durable orchestrator.',
        acceptanceCriteria: ['the worker supplies evidence'],
      }],
    })).isError).toBe(false)
    await approveTestPlan(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_delegate', {
      assignments: [{ taskId: 'managed', role: 'implementation', prompt: 'Complete the task.' }],
    })).toMatchObject({
      isError: false,
      value: [{ taskId: 'managed', status: 'completed' }],
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })

    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'Managed work passed.', evidence: ['worker evidence'],
    })).toMatchObject({ isError: false, value: { verdict: 'pass' } })
    expect(subagents.requests.map(request => request.label)).toEqual([
      'autopilot-managed',
      'autopilot-review-requirements',
    ])
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(ctx.autonomy.history(agent).map(record => record.operation)).not.toContain('needs-attention')
  })

  it('fails closed when a custom tool starts native children without managed provenance', async () => {
    const { ctx, agent, subagents } = await createHarness()
    const markNeedsAttention = ctx.autonomy.markNeedsAttention.bind(ctx.autonomy)
    vi.spyOn(ctx.autonomy, 'markNeedsAttention').mockImplementationOnce(async (...args) => {
      await markNeedsAttention(...args)
      throw new Error('observer persistence acknowledgement failed')
    })
    const logged = vi.spyOn(ctx.logger, 'error')
    registerTool(ctx, 'custom_fanout', async () => {
      const input = (label: string) => ctx.subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: 'Bypass managed delegation.' }],
        parent: agent,
        signal: new AbortController().signal,
      })
      const runs = await Promise.all([input('unmanaged-one'), input('unmanaged-two')])
      await Promise.all(runs.map(run => run.dispose()))
      return { started: runs.length }
    })
    await startAutopilot(ctx, agent)
    await enterStep(ctx, agent)

    expect(await executeTool(ctx, agent, 'custom_fanout')).toMatchObject({
      isError: false,
      value: { started: 2 },
    })
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: expect.stringContaining('unmanaged subagent start'),
      })
    })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot unmanaged subagent start' },
      { keepInbox: true },
    )
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not persist needs-attention'))
    })
    expect(subagents.requests.map(request => request.label)).toEqual(['unmanaged-one', 'unmanaged-two'])
  })

  it('removes native-start observers when authorization or their owning surface ends', async () => {
    const startDirect = async (ctx: Context, agent: Agent, label: string) => {
      const run = await ctx.subagents.start('spawn', {
        label,
        prompt: [{ type: 'text', text: 'Outside an active Autopilot run.' }],
        parent: agent,
        signal: new AbortController().signal,
      })
      await run.dispose()
    }

    const paused = await createHarness()
    await startAutopilot(paused.ctx, paused.agent)
    await enterStep(paused.ctx, paused.agent)
    await paused.ctx.autonomy.pause(paused.agent, 'observer should retire')
    await startDirect(paused.ctx, paused.agent, 'after-pause')
    expect(paused.agent.cancel).not.toHaveBeenCalled()
    expect(paused.ctx.autonomy.get(paused.agent)).toMatchObject({ phase: 'paused' })

    const disposed = await createHarness()
    await startAutopilot(disposed.ctx, disposed.agent)
    await enterStep(disposed.ctx, disposed.agent)
    agentEvents(disposed.ctx, disposed.agent).emit('agent/disposed', {})
    await startDirect(disposed.ctx, disposed.agent, 'after-agent-disposal')
    expect(disposed.agent.cancel).not.toHaveBeenCalled()
    expect(disposed.ctx.autonomy.get(disposed.agent)).toMatchObject({ activation: 'disarmed' })

    const unloaded = await createHarness()
    await startAutopilot(unloaded.ctx, unloaded.agent)
    await enterStep(unloaded.ctx, unloaded.agent)
    await unloaded.toolsFiber.dispose()
    await startDirect(unloaded.ctx, unloaded.agent, 'after-tools-disposal')
    expect(unloaded.agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot bundle readiness lost' },
      { keepInbox: true },
    )
    await vi.waitFor(() => {
      expect(unloaded.ctx.autonomy.get(unloaded.agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: expect.stringContaining('bundle contribution unloaded: tools'),
      })
    })
    expect(unloaded.ctx.goals.get(unloaded.agent)).toMatchObject({ activation: 'disarmed' })
  })

  it('requires human resume after tools reload before auditing direct native starts', async () => {
    const { ctx, agent, toolsFiber } = await createHarness()
    await startAutopilot(ctx, agent)
    await toolsFiber.dispose()
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: expect.stringContaining('bundle contribution unloaded: tools'),
      })
    })
    await ctx.plugin({
      name: 'dsh-autopilot-tools-reload-test',
      inject: [...toolsInject],
      apply: applyTools,
    }, {
      checks: [{ name: 'quality', command: 'pnpm test', timeoutMs: 5000 }],
      reviewers: [{ role: 'requirements', description: 'Audit every acceptance criterion.' }],
    })
    await vi.waitFor(() => {
      expect(ctx.autopilotRecoveryReadiness.missing()).not.toContain('tools')
    })
    const resumed = await ctx.commands.execute(
      agent,
      '/autopilot resume',
      new AbortController().signal,
    )
    expect(resumed?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Autopilot: running (armed)'),
    })
    await enterStep(ctx, agent)

    const run = await ctx.subagents.start('spawn', {
      label: 'reload-window-bypass',
      prompt: [{ type: 'text', text: 'Attempt a direct start after reload.' }],
      parent: agent,
      signal: new AbortController().signal,
    })
    await run.dispose()
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: expect.stringContaining('unmanaged subagent start'),
      })
    })
    expect(agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot unmanaged subagent start' },
      { keepInbox: true },
    )
  })

  it('retains failed dynamic cleanup across a tools-row reload until teardown succeeds', async () => {
    const { ctx, agent, toolsFiber, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'hmr-cleanup-plugin',
      packageId: 'hmr-cleanup-package',
      hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    const undefine = vi.spyOn(dynamicCordisRunner, 'undefine')
      .mockRejectedValue(new Error('HMR cleanup unavailable'))

    await toolsFiber.dispose().catch(() => {})
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.plugin({
      name: 'dsh-autopilot-tools-cleanup-reload-test',
      inject: [...toolsInject],
      apply: applyTools,
    }, {
      checks: [{ name: 'quality', command: 'pnpm test', timeoutMs: 5000 }],
      reviewers: [{ role: 'requirements', description: 'Audit every acceptance criterion.' }],
    })

    const missingOwner = vi.spyOn(ctx.autonomy, 'get').mockReturnValueOnce(undefined)
    await expect(enterStep(ctx, agent)).rejects.toThrow('dynamic cleanup debt has no owning Autopilot run')
    missingOwner.mockRestore()
    await expect(enterStep(ctx, agent)).rejects.toThrow('dynamic cleanup failed')
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('dynamic cleanup is still pending') },
    })
    undefine.mockResolvedValue({ ok: true, wasRunning: true })
    await expect(enterStep(ctx, agent)).resolves.toMatchObject({ kind: 'enter' })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({ isError: false })
  })

  it('enforces the off policy for both native definition and activation', async () => {
    const { ctx, agent } = await createHarness({ autonomy: { selfModification: 'off' } })
    registerTool(ctx, 'cordis_define')
    registerTool(ctx, 'cordis_run')
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('disables dynamic Cordis definitions') },
    })
    expect(await executeTool(ctx, agent, 'cordis_run')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('disables dynamic Cordis activation') },
    })
  })

  it('atomically denies native definitions beyond in-flight Client-approved budget', async () => {
    const { ctx, agent } = await createHarness({
      autonomy: { selfModification: 'client-approved', maxDynamicPackages: 2 },
    })
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const released = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    registerTool(ctx, 'cordis_define', async (args) => {
      const index = args['action'] === 'first' ? 0 : 1
      entered[index]?.resolve()
      await released[index]?.promise
      return { pluginId: `native-${index}`, packageId: `package-${index}`, hasClientHalf: true }
    })
    await startAutopilot(ctx, agent)
    const first = executeTool(ctx, agent, 'cordis_define', { action: 'first' })
    await entered[0]?.promise
    const second = executeTool(ctx, agent, 'cordis_define', { action: 'second' })
    await entered[1]?.promise

    expect(await executeTool(ctx, agent, 'cordis_define', { action: 'third' })).toMatchObject({
      isError: true,
      error: {
        message: 'Autopilot dynamic Package budget exhausted (2).',
        info: { code: 'AUTONOMY_POLICY_DENIED' },
      },
    })
    released[0]?.resolve()
    expect((await first).isError).toBe(false)
    released[1]?.resolve()
    expect((await second).isError).toBe(false)
    expect(ctx.autonomy.get(agent)?.dynamicPackages).toBe(2)
    expect(await executeTool(ctx, agent, 'cordis_define', { action: 'after-budget' })).toMatchObject({
      isError: true,
      error: { message: 'Autopilot dynamic Package budget exhausted (2).' },
    })
  })

  it('allows native Client-approved activation while the dynamic budget remains available', async () => {
    const { ctx, agent } = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    registerTool(ctx, 'cordis_run', args => args)
    await startAutopilot(ctx, agent)

    expect(await executeTool(ctx, agent, 'cordis_run', { pluginId: 'client-plugin' }))
      .toMatchObject({ isError: false, value: { pluginId: 'client-plugin' } })
  })

  it('contains malformed native receipts, lease races, and durable accounting failure', async () => {
    const malformed = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    registerTool(malformed.ctx, 'cordis_define', args => args['action'] === 'primitive'
      ? null
      : { pluginId: 'partial' })
    await startAutopilot(malformed.ctx, malformed.agent)
    expect((await executeTool(malformed.ctx, malformed.agent, 'cordis_define', { action: 'primitive' })).isError)
      .toBe(false)
    expect((await executeTool(malformed.ctx, malformed.agent, 'cordis_define', { action: 'partial' })).isError)
      .toBe(false)
    expect(malformed.ctx.autonomy.get(malformed.agent)?.dynamicPackages).toBe(0)

    const raced = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    registerTool(raced.ctx, 'cordis_define', async () => {
      entered.resolve()
      await release.promise
      return { pluginId: 'raced-plugin', packageId: 'raced-package', hasClientHalf: true }
    })
    await startAutopilot(raced.ctx, raced.agent)
    const pending = executeTool(raced.ctx, raced.agent, 'cordis_define')
    await entered.promise
    await raced.ctx.autonomy.pause(raced.agent, 'lease changed')
    release.resolve()
    expect(await pending).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('run changed') },
    })

    const accounting = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    registerTool(accounting.ctx, 'cordis_define', () => ({
      pluginId: 'accounting-plugin', packageId: 'accounting-package', hasClientHalf: true,
    }))
    await startAutopilot(accounting.ctx, accounting.agent)
    vi.spyOn(accounting.ctx.autonomy, 'recordDynamicPackage')
      .mockRejectedValueOnce('storage unavailable')
      .mockRejectedValueOnce(new Error('typed storage unavailable'))
    expect(await executeTool(accounting.ctx, accounting.agent, 'cordis_define')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('storage unavailable') },
    })
    expect(await executeTool(accounting.ctx, accounting.agent, 'cordis_define')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('typed storage unavailable') },
    })
  })

  it('cleans tracked native Host definitions on pause and contains cleanup rejection', async () => {
    const successful = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    let defined = 0
    registerTool(successful.ctx, 'cordis_define', () => {
      defined += 1
      return {
        pluginId: `host-plugin-${defined}`, packageId: `host-package-${defined}`, hasClientHalf: false,
      }
    })
    await startAutopilot(successful.ctx, successful.agent)
    expect((await executeTool(successful.ctx, successful.agent, 'cordis_define')).isError).toBe(false)
    expect((await executeTool(successful.ctx, successful.agent, 'cordis_define')).isError).toBe(false)
    await successful.ctx.autonomy.pause(successful.agent, 'cleanup')
    expect(successful.ctx.autonomy.get(successful.agent)).toMatchObject({ phase: 'paused' })

    const rejected = await createHarness({ autonomy: { selfModification: 'client-approved' } })
    registerTool(rejected.ctx, 'cordis_define', () => ({
      pluginId: 'leaked-plugin', packageId: 'leaked-package', hasClientHalf: false,
    }))
    await startAutopilot(rejected.ctx, rejected.agent)
    expect((await executeTool(rejected.ctx, rejected.agent, 'cordis_define')).isError).toBe(false)
    vi.spyOn(rejected.dynamicCordisRunner, 'undefine').mockRejectedValue(new Error('cleanup unavailable'))
    await rejected.ctx.autonomy.pause(rejected.agent, 'cleanup despite runner fault')
    expect(rejected.ctx.autonomy.get(rejected.agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: expect.stringContaining('dynamic cleanup failed'),
    })
  })

  it('aggregates managed dynamic cleanup failure while the tools surface unloads', async () => {
    const { ctx, agent, dynamicCordisRunner, dynamicCordisRunnerFiber } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_cordis_apply', {
      logicalId: 'dispose-managed',
      name: 'Dispose managed',
      purpose: 'Exercise managed teardown failure.',
      hostCode: "return { name: 'dispose-managed', apply() {} }",
    })).toMatchObject({ isError: false })
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('managed teardown unavailable'))

    await dynamicCordisRunnerFiber?.dispose()
    expect(dynamicCordisRunner.undefine).toHaveBeenCalled()
  })

  it('retains every dynamic disposer failure when the tools row unloads', async () => {
    const { ctx, agent, toolsFiber, dynamicCordisRunner } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_cordis_apply', {
      logicalId: 'tools-dispose-managed',
      name: 'Tools dispose managed',
      purpose: 'Exercise the owning tools disposer.',
      hostCode: "return { name: 'tools-dispose-managed', apply() {} }",
    })).toMatchObject({ isError: false })
    const view = ctx.autonomy.get(agent)
    if (view === undefined) throw new Error('fixture has no Autopilot run')
    vi.spyOn(ctx.autonomy, 'get').mockReturnValue({
      ...view,
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: 'pre-existing teardown debt',
    })
    const undefine = vi.spyOn(dynamicCordisRunner, 'undefine')
      .mockRejectedValue(new Error('persistent managed teardown failure'))

    await expect(toolsFiber.dispose()).resolves.toBeUndefined()
    expect(undefine.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('projects active and removed managed extension audit state through status', async () => {
    const { ctx, agent } = await createHarness()
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'autopilot_cordis_apply', {
      logicalId: 'status-managed',
      name: 'Status managed',
      purpose: 'Exercise durable status projection.',
      hostCode: "return { name: 'status-managed', apply() {} }",
    })).toMatchObject({ isError: false })
    expect(await executeTool(ctx, agent, 'get_autopilot')).toMatchObject({
      isError: false,
      value: { lease: { dynamicExtensions: [{ logicalId: 'status-managed', status: 'active' }] } },
    })

    expect(await executeTool(ctx, agent, 'autopilot_cordis_remove', {
      logicalId: 'status-managed', reason: 'demo complete',
    })).toMatchObject({
      isError: false,
      value: { lease: { dynamicExtensions: [{
        logicalId: 'status-managed', status: 'removed', reason: 'demo complete',
      }] } },
    })
  })

  it('aggregates tracked native cleanup failure while the tools surface unloads', async () => {
    const { ctx, agent, dynamicCordisRunner, dynamicCordisRunnerFiber } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'native-dispose-plugin', packageId: 'native-dispose-package', hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('native teardown unavailable'))

    await dynamicCordisRunnerFiber?.dispose()
    expect(dynamicCordisRunner.undefine).toHaveBeenCalled()
  })

  it('logs dynamic cleanup failure observed during Agent disposal', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'disposed-plugin', packageId: 'disposed-package', hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValueOnce(new Error('dispose cleanup unavailable'))
    agentEvents(ctx, agent).emit('agent/disposed', {})

    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'needs-attention',
        reason: expect.stringContaining('left dynamic Host code active'),
      })
    })
  })

  it('logs unretracted Host code when a terminal run later disposes its Agent', async () => {
    const { ctx, agent, dynamicCordisRunner } = await createHarness({
      autonomy: { selfModification: 'client-approved' },
    })
    registerTool(ctx, 'cordis_define', () => ({
      pluginId: 'terminal-plugin', packageId: 'terminal-package', hasClientHalf: false,
    }))
    await startAutopilot(ctx, agent)
    expect(await executeTool(ctx, agent, 'cordis_define')).toMatchObject({ isError: false })
    vi.spyOn(dynamicCordisRunner, 'undefine').mockRejectedValue(new Error('terminal cleanup unavailable'))
    await ctx.autonomy.revoke(agent, 'terminal cleanup exercise')
    const logged = vi.spyOn(ctx.logger, 'error')

    agentEvents(ctx, agent).emit('agent/disposed', {})

    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Agent disposal left dynamic Host code active'))
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'revoked' })
  })
})

describe('tool configuration', () => {
  it.each([
    [{ checks: [{ name: ' ', command: 'test' }] }, 'name must not be empty'],
    [{ checks: [{ name: 'test', command: ' ' }] }, 'command must not be empty'],
    [{ checks: [{ name: 'same', command: 'a' }, { name: ' same ', command: 'b' }] }, 'duplicated'],
    [{ minimumEvidenceItems: -1, checks: [{ name: 'test', command: 'test' }] }, 'minimumEvidenceItems'],
    [{ maxOutputChars: 0, checks: [{ name: 'test', command: 'test' }] }, 'maxOutputChars'],
    [{ checks: [{ name: 'test', command: 'test', timeoutMs: 0 }] }, 'timeoutMs'],
    [{ checks: [{ name: 'test', command: 'test' }], reviewers: [{ role: ' ', description: 'x' }] }, 'must not be empty'],
    [{
      checks: [{ name: 'test', command: 'test' }],
      reviewers: [{ role: 'review', description: 'review', fallbacks: [{}] }],
    }, 'fallback 1 must select'],
    [{
      checks: [{ name: 'test', command: 'test' }],
      reviewers: [{ role: 'same', description: 'a' }, { role: ' same ', description: 'b' }],
    }, 'duplicated'],
    [{
      checks: [{ name: 'test', command: 'test' }],
      taskRoutes: [{ role: 'same' }, { role: ' same ' }],
    }, 'duplicated'],
    [{ checks: [{ name: 'test', command: 'test' }], taskRoutes: [{ role: ' ' }] }, 'must not be empty'],
    [{ checks: [{ name: 'test', command: 'test' }], taskRoutes: [{ role: 'worker', costWeight: 0 }] }, 'costWeight'],
    [{
      checks: [{ name: 'test', command: 'test' }],
      taskRoutes: [{ role: 'worker', fallbacks: [{}] }],
    }, 'fallback 1 must select'],
    [{ checks: [{ name: 'test', command: 'test' }], forbiddenDynamicServices: [''] }, 'unique non-empty'],
    [{ checks: [{ name: 'test', command: 'test' }], taskWorkerToolAllowlist: ['bash', ' bash '] }, 'unique non-empty'],
  ])('fails load for invalid configuration %j', async (tools, message) => {
    await expect(createHarness({ tools: tools as never })).rejects.toThrow(message)
  })

  it('applies normalized verifier defaults through the plugin schema', async () => {
    const { ctx, agent, shell } = await createHarness({
      tools: {
        checks: [{ name: ' quality ', command: ' test ' }],
        reviewers: [{ role: ' requirements ', description: ' audit ' }],
      },
    })
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'defaults', evidence: ['quality output'],
    })
    expect(shell.requests[0]).toMatchObject({ command: 'test', timeoutMs: 120_000 })
  })

  it('defends direct apply callers before Cordis schema normalization', () => {
    const ctx = {} as Context
    expect(() => applyTools(ctx, {})).toThrow()
    expect(() => applyTools(ctx, { taskRoutes: [{ role: 'direct' }] })).toThrow()
    expect(() => applyTools(ctx as Context, {
      minimumEvidenceItems: Number.NaN,
      checks: [{ name: 'direct', command: 'test' }],
    })).toThrow('minimumEvidenceItems')
    expect(() => applyTools(ctx as Context, {
      maxOutputChars: Number.NaN,
      checks: [{ name: 'direct', command: 'test' }],
    })).toThrow('maxOutputChars')
    expect(() => applyTools(ctx as Context, {
      checks: [{ name: 'direct', command: 'test' }],
      taskRoutes: [{ role: 'worker', costWeight: 0 }],
    })).toThrow('costWeight')
    expect(() => applyTools(ctx as Context, {
      checks: [{ name: 'direct', command: 'test', timeoutMs: Number.NaN }],
    })).toThrow('timeoutMs')
    expect(() => applyTools(ctx, {
      checks: [],
      projectChecks: ['not-a-recipe' as 'js:test'],
    })).toThrow('projectChecks')
    expect(() => applyTools(ctx, {
      checks: [],
      projectChecks: ['js:test', 'js:test'],
    })).toThrow('projectChecks')
    for (const maxProjectChecks of [0, 13, Number.NaN]) {
      expect(() => applyTools(ctx, { checks: [], maxProjectChecks })).toThrow('maxProjectChecks')
    }
    expect(() => applyTools(ctx, { checks: [], projectCheckTimeoutMs: Number.NaN }))
      .toThrow('projectCheckTimeoutMs')
    expect(() => applyTools(ctx, {
      checks: [{ name: 'direct', command: 'test' }],
      reviewers: [{
        role: 'review', description: 'review', subagentProvider: 'spawn',
        provider: 'provider', model: 'model',
      }],
    })).toThrow()
  })

  it('surfaces a primitive shell rejection without leaking an active verification', async () => {
    const { ctx, agent, shell } = await createHarness()
    await startAutopilot(ctx, agent)
    await completePlan(ctx, agent)
    vi.spyOn(shell, 'run').mockRejectedValue('primitive failure')
    expect(await executeTool(ctx, agent, 'autopilot_verify', {
      summary: 'candidate', evidence: ['quality output'],
    })).toMatchObject({ isError: true, error: { message: 'primitive failure' } })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })
})
