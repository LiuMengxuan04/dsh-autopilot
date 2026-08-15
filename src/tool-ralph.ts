/** Fixed model tools for bounded, Host-managed Ralph leaf loops. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ManagedSubagentStart } from './managed-subagents.ts'
import type { RalphSnapshot } from './ralph-state.ts'

export const name = 'dsh-autopilot-tool-ralph'
export const inject = ['autopilotRalph', 'tools']

/** Host-owned provenance wrapper; model input cannot select a transport or model. */
export interface RalphToolHost {
  readonly startSubagent: ManagedSubagentStart
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Ralph tools require an Agent-backed session')
  return exec.agent
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Project bounded durable state into plain JSON for the model transcript. */
export function ralphJson(snapshot: RalphSnapshot): JsonValue {
  return {
    runId: snapshot.runId,
    generation: snapshot.generation,
    goalId: snapshot.goalId,
    taskId: snapshot.taskId,
    revision: snapshot.revision,
    phase: snapshot.phase,
    maxRounds: snapshot.maxRounds,
    roundsStarted: snapshot.rounds.length,
    reservedThroughRound: snapshot.reservedThroughRound,
    ...(snapshot.handoff === undefined ? {} : { handoff: snapshot.handoff }),
    rounds: snapshot.rounds.map(round => ({
      number: round.number,
      status: round.status,
      ...(round.childSessionId === undefined ? {} : { childSessionId: round.childSessionId }),
      ...(round.summary === undefined ? {} : { summary: round.summary }),
      ...(round.handoff === undefined ? {} : { handoff: round.handoff }),
      evidence: round.evidence.map(item => ({ ...item })),
    })),
    ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
  }
}

/**
 * Register exactly four fixed Ralph controls.
 * @param ctx - Host context carrying durable Ralph and tool services.
 * @param host - Mandatory Host-owned managed subagent start callback.
 */
export function apply(ctx: Context, host: RalphToolHost): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_ralph_start',
    description: 'Claim one dependency-ready Autopilot DAG leaf and run bounded fresh workers until continue, completion, blocking, failure, interruption, or budget exhaustion. This never completes the parent Goal.',
    parameters: {
      taskId: { type: 'string', required: true },
      instruction: { type: 'string', required: true },
      maxRounds: { type: 'number' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return ralphJson(await ctx.autopilotRalph.start(requireAgent(exec), {
        taskId: args.taskId,
        instruction: args.instruction,
        ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
        startSubagent: host.startSubagent,
        signal: exec.signal,
      }))
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_ralph_resume',
    description: 'Resume one interrupted Ralph leaf from its durable handoff with a new fresh child. The request may only retain or lower the existing round ceiling.',
    parameters: {
      taskId: { type: 'string', required: true },
      maxRounds: { type: 'number' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return ralphJson(await ctx.autopilotRalph.resume(requireAgent(exec), {
        taskId: args.taskId,
        ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
        startSubagent: host.startSubagent,
        signal: exec.signal,
      }))
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_ralph_status',
    description: 'Inspect durable rounds, handoff, evidence, budget accounting, and terminal state without starting a child.',
    parameters: { taskId: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const snapshot = ctx.autopilotRalph.status(requireAgent(exec), args.taskId)
      return snapshot === undefined ? { status: 'missing', taskId: args.taskId } : ralphJson(snapshot)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_ralph_cancel',
    description: 'Abort one in-flight Ralph child and terminally cancel only its attributed DAG leaf loop.',
    parameters: {
      taskId: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return ralphJson(await ctx.autopilotRalph.cancel(
        requireAgent(exec),
        args.taskId,
        args.reason,
      ))
    },
  })))
}
