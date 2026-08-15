/** Model tools for durable continuable teams and their structured child reports. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ManagedContinuableStart } from './team-service.ts'
import type { TeamEvidence } from './team-state.ts'

export const name = 'dsh-autopilot-tool-team'
export const inject = ['autopilotTeam', 'subagents', 'systemPrompt', 'tools']

const TEAM_REPORT_SECTION_ORDER = 118

/** Require the Agent attached by the DSH tool runtime. */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Autopilot team tools require an Agent-backed session')
  return exec.agent
}

/** Generic JSON rendering for inspectable team tool results. */
function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Project one immutable thread into the tool runtime's JSON vocabulary. */
function threadJson(thread: ReturnType<Context['autopilotTeam']['list']>[number]) {
  return {
    runId: thread.runId,
    generation: thread.generation,
    taskId: thread.taskId,
    revision: thread.revision,
    role: thread.role,
    phase: thread.phase,
    label: thread.label,
    ...(thread.childSessionId === undefined ? {} : { childSessionId: thread.childSessionId }),
    messages: thread.messages.map(message => ({ ...message })),
    ...(thread.pendingMessage === undefined ? {} : {
      pending: { kind: thread.pendingMessage.kind, preparedAt: thread.pendingMessage.preparedAt },
    }),
    ...(thread.report === undefined ? {} : {
      report: {
        status: thread.report.status,
        summary: thread.report.summary,
        evidence: thread.report.evidence.map(item => ({ ...item })),
        messageId: thread.report.messageId,
      },
    }),
    ...(thread.reason === undefined ? {} : { reason: thread.reason }),
    ...(thread.lastError === undefined ? {} : { lastError: thread.lastError }),
  }
}

/** Project one durable orphan without leaking optional undefined fields. */
function orphanJson(orphan: ReturnType<Context['autopilotTeam']['orphans']>[number]) {
  return {
    version: orphan.version,
    parentSessionId: orphan.parentSessionId,
    runId: orphan.runId,
    generation: orphan.generation,
    childSessionId: orphan.childSessionId,
    observedAt: orphan.observedAt,
    reason: orphan.reason,
    ...(orphan.label === undefined ? {} : { label: orphan.label }),
    ...(orphan.initialMessageId === undefined ? {} : { initialMessageId: orphan.initialMessageId }),
    ...(orphan.parentId === undefined ? {} : { parentId: orphan.parentId }),
    ...(orphan.depth === undefined ? {} : { depth: orphan.depth }),
  }
}

/**
 * Install the structured settlement tool into one continuable child's own scope.
 * @param childCtx - Child-scoped context receiving the tool and guidance.
 * @param ctx - Root service context that owns durable team state.
 * @returns disposer that revokes both registrations.
 */
export function installTeamReportTool(childCtx: Context, ctx: Context): () => void {
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:autopilot-team-report',
    order: TEAM_REPORT_SECTION_ORDER,
    text: 'You own one durable Autopilot DAG task. When it reaches a final outcome, call '
      + 'autopilot_team_report exactly once. A completed report requires concrete evidence. Blocked and failed '
      + 'reports require a self-contained reason. The accepted report settles only your attributed task.',
  })
  let disposeTool: () => void
  try {
    disposeTool = childCtx.tools.register(defineTool({
      name: 'autopilot_team_report',
      description: 'Settle your exact attributed Autopilot DAG task with a structured final status and evidence. Call exactly once when the task has a final outcome.',
      parameters: {
        status: { type: 'string', required: true, enum: ['completed', 'blocked', 'failed'] },
        summary: { type: 'string', required: true },
        evidence: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                required: true,
                enum: ['file', 'command', 'test', 'url', 'note', 'subagent'],
              },
              ref: { type: 'string', required: true },
              summary: { type: 'string', required: true },
            },
          },
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const thread = await ctx.autopilotTeam.report(requireAgent(exec), {
          status: args.status,
          summary: args.summary,
          evidence: args.evidence as TeamEvidence[],
        }, exec.signal)
        return {
          taskId: thread.taskId,
          phase: thread.phase,
          ...(thread.report === undefined ? {} : { reportMessageId: thread.report.messageId }),
        }
      },
    }))
  } catch (error: unknown) {
    try {
      disposeSection()
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'failed to register the team report tool and roll back its prompt guidance',
      )
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeTool, disposeSection]) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke team report tool registrations')
    }
  }
}

/** Host-owned managed-start callback required by the parent tool surface. */
export interface ContinuableTeamToolHost {
  readonly startContinuable: ManagedContinuableStart
}

/**
 * Register parent mailbox controls and child-only structured settlement.
 * @param ctx - Host context carrying the team and tool services.
 * @param host - Managed-start provenance wrapper shared with existing Autopilot subagents.
 */
export function apply(ctx: Context, host: ContinuableTeamToolHost): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_team_start',
    description: 'Atomically claim one dependency-ready Autopilot DAG task and start its durable continuable worker. The worker survives interruption and process restart.',
    parameters: {
      taskId: { type: 'string', required: true },
      role: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const thread = await ctx.autopilotTeam.start(requireAgent(exec), {
        taskId: args.taskId,
        role: args.role,
        prompt: args.prompt,
        signal: exec.signal,
        startContinuable: host.startContinuable,
      })
      return threadJson(thread)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_team_send',
    description: 'Send the next FIFO message to an attributed continuable worker. A cold child is resumed from its durable DSH session.',
    parameters: {
      taskId: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const thread = await ctx.autopilotTeam.followup(requireAgent(exec), {
        taskId: args.taskId,
        message: args.message,
        signal: exec.signal,
      })
      return threadJson(thread)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_team_interrupt',
    description: 'Interrupt only an attributed worker current turn while preserving its durable child session and queued mailbox.',
    parameters: {
      taskId: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return threadJson(await ctx.autopilotTeam.interrupt(
        requireAgent(exec),
        args.taskId,
        args.reason,
      ))
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_team_list',
    description: 'List exact durable run/task/child/message attribution and mailbox state without resuming any worker.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      return {
        threads: ctx.autopilotTeam.list(agent).map(threadJson),
        orphans: ctx.autopilotTeam.orphans(agent).map(orphanJson),
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_team_reconcile',
    description: 'Audit durable continuable descendants, finish an accepted report settlement after restart, and fail closed on any unattributed child or uncertain inbox delivery.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const result = await ctx.autopilotTeam.reconcile(requireAgent(exec), exec.signal)
      return {
        inspected: result.inspected,
        resumedSettlements: result.resumedSettlements,
        orphaned: result.orphaned,
        issues: [...result.issues],
      }
    },
  })))

  ctx.subagents.registerContinuableSetup(childCtx => installTeamReportTool(childCtx, ctx))
}
