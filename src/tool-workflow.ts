/** Model-facing entry point for deployment-fixed managed workflow profiles. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolExecution, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ManagedWorkflowStart } from './workflow-service.ts'
import type { ManagedWorkflowSnapshot } from './workflow-state.ts'

export const name = 'dsh-autopilot-tool-workflow'
export const inject = ['autopilotWorkflows', 'systemPrompt', 'tools']

/** Host-owned managed workflow start required by the tool plugin. */
export interface ManagedWorkflowToolHost {
  readonly startWorkflow: ManagedWorkflowStart
}

/** Require the Agent attached by the DSH tool runtime. */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Autopilot workflow tools require an Agent-backed session')
  return exec.agent
}

/** Generic JSON output renderer. */
function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Project durable state without deployment script source or input values. */
export function managedWorkflowJson(snapshot: ManagedWorkflowSnapshot) {
  return {
    workflowId: snapshot.workflowId,
    runId: snapshot.runId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    profileId: snapshot.profileId,
    taskIds: [...snapshot.taskIds],
    maxTotalAgents: snapshot.maxTotalAgents,
    phase: snapshot.phase,
    ...(snapshot.engineRunId === undefined ? {} : { engineRunId: snapshot.engineRunId }),
    ...(snapshot.engineStopReason === undefined ? {} : { engineStopReason: snapshot.engineStopReason }),
    ...(snapshot.engineAgentsStarted === undefined ? {} : { agentsStarted: snapshot.engineAgentsStarted }),
    outcomes: snapshot.outcomes.map(outcome => ({
      taskId: outcome.taskId,
      status: outcome.status,
      summary: outcome.summary,
      evidence: outcome.evidence.map(item => ({ ...item })),
      applied: snapshot.settledTaskIds.includes(outcome.taskId),
    })),
    ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
  }
}

function presentCall(args: { profileId: string; taskIds: string[] }): ToolCallView {
  return {
    card: 'generic',
    title: `Autopilot workflow: ${args.profileId}`,
    rawInput: `${args.taskIds.length} DAG task${args.taskIds.length === 1 ? '' : 's'}`,
  }
}

function presentResult(
  _args: unknown,
  _result: { content: unknown[]; isError: boolean },
): ToolResultView {
  return { card: 'generic' }
}

/**
 * Register the one profile-only workflow tool.
 * @param ctx - Context carrying durable managed workflow and tool services.
 * @param host - Host callback that establishes managed subagent provenance.
 */
export function apply(ctx: Context, host: ManagedWorkflowToolHost): void {
  const profiles = ctx.autopilotWorkflows.listProfiles()
  const catalog = profiles.length === 0
    ? 'No managed workflow profiles are configured.'
    : profiles.map(profile => `${profile.id}: ${profile.description} (up to ${profile.maxTotalAgents} agents)`).join('\n')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:autopilot-workflow',
    order: 117,
    text: [
      'Use autopilot_workflow_run only for dependency-ready tasks in the current durable Autopilot DAG.',
      'Choose a deployment profile; scripts, routes, and resource ceilings are Host-owned and cannot be supplied in tool input.',
      'The workflow claims every task before execution and settles only those exact task ids. It never completes the Goal.',
      'Configured profiles:',
      catalog,
    ].join('\n'),
  }))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_workflow_run',
    description: 'Run one deployment-fixed, budget-reserved fan-out/fan-in workflow over exact dependency-ready Autopilot DAG tasks. Input cannot provide scripts, routes, or resource caps.',
    parameters: {
      profileId: { type: 'string', required: true },
      taskIds: { type: 'array', required: true, items: { type: 'string' } },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Bounded JSON data accepted by the selected deployment profile.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const snapshot = await ctx.autopilotWorkflows.run(requireAgent(exec), {
        profileId: args.profileId,
        taskIds: args.taskIds,
        ...(args.args === undefined ? {} : { args: args.args }),
        signal: exec.signal,
        startWorkflow: host.startWorkflow,
      })
      return managedWorkflowJson(snapshot)
    },
    presentCall,
    presentResult,
  })))
}
