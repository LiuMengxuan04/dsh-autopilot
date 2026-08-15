/** Model tool for durable file-backed sequential mission queues. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ManagedSubagentStart } from './managed-subagents.ts'
import {
  missionCounts,
  missionSourceSha256,
  parseMissionMarkdown,
} from './mission-state.ts'
import type { MissionSnapshot } from './mission-state.ts'
import type { TaskRoute, TaskRoutingPreference } from './orchestrator.ts'

export const name = 'dsh-autopilot-tool-mission'
export const inject = ['autopilotMissions', 'tools']

/** Host-owned worker route and managed-start policy. */
export interface MissionToolHost {
  readonly routes: readonly TaskRoute[]
  readonly routingPreference: TaskRoutingPreference
  readonly toolAllowlist: readonly string[]
  readonly startSubagent: ManagedSubagentStart
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Autopilot mission requires an Agent-backed session')
  return exec.agent
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Project one mission summary into the logged model-tool vocabulary. */
export function missionJson(snapshot: MissionSnapshot): JsonValue {
  return {
    missionId: snapshot.missionId,
    runId: snapshot.runId,
    generation: snapshot.generation,
    goalId: snapshot.goalId,
    revision: snapshot.revision,
    source: { ...snapshot.source },
    phase: snapshot.phase,
    continueOnError: snapshot.continueOnError,
    counts: missionCounts(snapshot.tasks),
    dagTaskId: snapshot.dagTaskId,
    tasks: snapshot.tasks.map(task => ({
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      attempts: task.attempts.map(attempt => ({
        number: attempt.number,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        status: attempt.status,
        summary: attempt.summary,
        evidence: attempt.evidence.map(item => ({ ...item })),
        ...(attempt.childSessionId === undefined ? {} : { childSessionId: attempt.childSessionId }),
      })),
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    })),
    ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
  }
}

async function readMissionSource(ctx: Context, agent: Agent, path: string, signal: AbortSignal) {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('mission file requires an Agent workspace')
  const fs = agent.ctx.get('fs') ?? ctx.get('fs')
  if (fs === undefined) throw new Error('mission file requires the DSH filesystem service in the Agent preset')
  const entry = await fs.lstat(path, { cwd }, signal)
  if (entry?.type === 'symlink') throw new Error('mission file must not be a symbolic link')
  if (entry?.type !== 'file') throw new Error('mission path must name a regular file')
  const workspace = await fs.resolve('.', { cwd, signal })
  const target = await fs.resolve(path, { cwd, signal })
  if (!fs.contains(workspace, target)) throw new Error('mission file must resolve inside the Agent workspace')
  const before = await fs.stat(target, signal)
  if (before?.type !== 'file') throw new Error('mission path must resolve to a regular file')
  const maxBytes = ctx.autopilotMissions.limits.maxSourceBytes
  const bytes = await fs.readBytes(target, signal, maxBytes)
  const after = await fs.stat(target, signal)
  if (after?.type !== 'file' || after.version !== before.version) {
    throw new Error('mission file changed while it was being read')
  }
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new Error(`mission file is not valid UTF-8: ${String(error)}`)
  }
  return Object.freeze({
    source: Object.freeze({
      path: target.displayPath,
      sha256: missionSourceSha256(bytes),
      bytes: bytes.byteLength,
    }),
    raw,
  })
}

/** Register the complete mission operator surface as one bounded model tool. */
export function apply(ctx: Context, host: MissionToolHost): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_mission',
    description: 'Plan, inspect, resume, mark, or rerun a durable file-backed sequential prompt queue. Plan is a dry run that creates the canonical DAG envelope; harden that plan with autopilot_flow before resume.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['plan', 'status', 'resume', 'mark', 'rerun', 'audit'],
      },
      path: { type: 'string', description: 'Workspace-relative Markdown file; required only for plan.' },
      missionId: { type: 'string', description: 'Exact durable mission id for status/resume/mark/rerun.' },
      taskId: { type: 'string', description: 'Exact task-NNN id for mark/rerun.' },
      status: { type: 'string', enum: ['blocked', 'needs-human-review'], description: 'Operator state for mark.' },
      reason: { type: 'string', description: 'Required operator reason for mark.' },
      continueOnError: { type: 'boolean', description: 'Plan-time policy to continue later prompts after failure.' },
      limit: { type: 'number', description: 'Audit tail length, 1-200.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      if (args.action === 'plan') {
        if (args.path === undefined) throw new Error('autopilot_mission plan requires path')
        const loaded = await readMissionSource(ctx, agent, args.path, exec.signal)
        const limits = ctx.autopilotMissions.limits
        const tasks = parseMissionMarkdown(loaded.raw, {
          maxTasks: limits.maxTasks,
          maxPromptChars: limits.maxPromptChars,
          maxTotalPromptChars: limits.maxTotalPromptChars,
        })
        return missionJson(await ctx.autopilotMissions.plan(agent, {
          source: loaded.source,
          tasks,
          ...(args.continueOnError === undefined ? {} : { continueOnError: args.continueOnError }),
        }))
      }
      if (args.action === 'audit') {
        const limit = args.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          throw new Error('autopilot_mission audit limit must be an integer from 1 to 200')
        }
        return ctx.autopilotMissions.history(String(agent.id)).slice(-limit).map(record => ({
          operation: record.operation,
          time: record.time,
          missionId: record.snapshot.missionId,
          revision: record.snapshot.revision,
          phase: record.snapshot.phase,
        }))
      }
      if (args.action === 'status' && args.missionId === undefined) {
        const lease = ctx.autonomy.get(agent)
        if (lease === undefined) return []
        return ctx.autopilotMissions.listRun(String(agent.id), lease.id, lease.generation).map(missionJson)
      }
      if (args.missionId === undefined) throw new Error(`autopilot_mission ${args.action} requires missionId`)
      if (args.action === 'status') {
        const mission = ctx.autopilotMissions.status(agent, args.missionId)
        return mission === undefined ? { status: 'missing', missionId: args.missionId } : missionJson(mission)
      }
      const policy = {
        routes: host.routes,
        routingPreference: host.routingPreference,
        toolAllowlist: host.toolAllowlist,
        startSubagent: host.startSubagent,
        signal: exec.signal,
      }
      if (args.action === 'resume') {
        return missionJson(await ctx.autopilotMissions.resume(agent, args.missionId, policy))
      }
      if (args.taskId === undefined) throw new Error(`autopilot_mission ${args.action} requires taskId`)
      if (args.action === 'rerun') {
        return missionJson(await ctx.autopilotMissions.rerun(agent, args.missionId, args.taskId, policy))
      }
      if (args.status === undefined || args.reason === undefined) {
        throw new Error('autopilot_mission mark requires status and reason')
      }
      return missionJson(await ctx.autopilotMissions.mark(agent, {
        missionId: args.missionId,
        taskId: args.taskId,
        status: args.status,
        reason: args.reason,
      }))
    },
  })))
}
