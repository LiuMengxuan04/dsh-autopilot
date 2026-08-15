/** Explicit model tools for project memory and durable handoff summaries. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { registerRecoveryContribution } from './recovery-coordinator.ts'
import type { AutonomyLeaseView } from './service.ts'

export const name = 'dsh-autopilot-tool-memory'
export const inject = ['autonomy', 'autopilotMemory', 'goals', 'tools']

/** Require the Agent attached by the DSH tool runtime. */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Autopilot memory tools require an Agent-backed session')
  return exec.agent
}

/** Resolve the project namespace from the immutable Session header. */
function workspaceOf(agent: Agent): string {
  const workspace = agent.session.header.cwd
  if (workspace === undefined) throw new Error('Autopilot project memory requires a workspace-backed session')
  return workspace
}

/** Reject memory mutation outside the exact active Goal/lease pair. */
function requireAuthorizedMutation(
  ctx: Context,
  agent: Agent,
): { readonly goal: GoalView; readonly lease: AutonomyLeaseView } {
  const goal = ctx.goals.get(agent)
  const lease = ctx.autonomy.get(agent)
  if (goal === undefined || lease === undefined || goal.id !== lease.goalId
    || goal.phase !== 'active' || goal.activation !== 'armed'
    || lease.phase !== 'running' || lease.activation !== 'armed') {
    throw new Error('project memory mutation requires the current armed Goal and its running Autopilot lease')
  }
  return { goal, lease }
}

/** Resolve an exact run/Goal pair for a read-only handoff snapshot, including safe phases. */
function requireHandoffState(
  ctx: Context,
  agent: Agent,
): { readonly goal: GoalView; readonly lease: AutonomyLeaseView } {
  const goal = ctx.goals.get(agent)
  const lease = ctx.autonomy.get(agent)
  if (goal === undefined || lease === undefined || goal.id !== lease.goalId) {
    throw new Error('Autopilot handoff requires a durable run and its exact native Goal')
  }
  return { goal, lease }
}

/** Render canonical JSON for the generic DSH tool card. */
function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Detach readonly service values into the tool runtime's JSON vocabulary. */
function memoryEntryJson(entry: ReturnType<Context['autopilotMemory']['read']>) {
  if (entry === undefined) return null
  return {
    version: entry.version,
    workspace: entry.workspace,
    key: entry.key,
    revision: entry.revision,
    value: entry.value,
    tags: [...entry.tags],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

/** Bound one untrusted prose field retained in a handoff summary. */
function clipped(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Assemble a bounded, revision-addressed handoff artifact from durable Autopilot state. */
function handoffValue(
  goal: GoalView,
  lease: AutonomyLeaseView,
  summary: string,
  nextAction: string,
): string {
  const tasks = lease.plan?.tasks.slice(0, 32).map(task => ({
      id: task.id,
      title: clipped(task.title, 240),
      status: task.status,
      dependencies: task.dependencies.slice(0, 16),
      acceptanceCriteria: task.acceptanceCriteria.slice(0, 5).map(value => clipped(value, 300)),
      evidence: task.evidence.slice(-3).map(item => ({
        kind: item.kind,
        ref: clipped(item.ref, 300),
        summary: clipped(item.summary, 300),
      })),
      attempts: task.attempts,
      ...(task.reason === undefined ? {} : { reason: clipped(task.reason) }),
    })) ?? []
  const payload = {
    version: 2,
    run: {
      id: lease.id,
      generation: lease.generation,
      revision: lease.revision,
      phase: lease.phase,
      activation: lease.activation,
      autoResume: lease.autoResume,
      grantedAt: lease.grantedAt,
      updatedAt: lease.updatedAt,
      ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt }),
      remainingActiveMs: lease.remainingActiveMs,
      maxActiveMs: lease.maxActiveMs,
      ...(lease.reason === undefined ? {} : { reason: clipped(lease.reason) }),
    },
    goal: {
      id: lease.goalId,
      revision: goal.revision,
      objective: clipped(goal.objective, 2000),
      phase: goal.phase,
      activation: goal.activation,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
    },
    summary,
    nextSafeAction: nextAction,
    budgets: {
      maxVerificationAttempts: lease.maxVerificationAttempts,
      maxDynamicPackages: lease.maxDynamicPackages,
      maxSubagents: lease.maxSubagents,
      maxConcurrentSubagents: lease.maxConcurrentSubagents,
      maxTasks: lease.maxTasks,
      maxTaskAttempts: lease.maxTaskAttempts,
      maxEvidenceItems: lease.maxEvidenceItems,
      maxSnapshotBytes: lease.maxSnapshotBytes,
      maxAuditRecords: lease.maxAuditRecords,
      maxAuditBytes: lease.maxAuditBytes,
      maxDynamicSourceChars: lease.maxDynamicSourceChars,
    },
    usage: {
      verificationAttempts: lease.verificationAttempts,
      dynamicPackages: lease.dynamicPackages,
      subagentsStarted: lease.subagentsStarted,
    },
    verificationBaseline: lease.verificationBaseline === undefined ? null : {
      kind: lease.verificationBaseline.kind,
      frozenAt: lease.verificationBaseline.frozenAt,
      manifests: lease.verificationBaseline.manifests,
      checks: lease.verificationBaseline.checks.map(check => check.id),
    },
    planRevision: lease.plan?.revision ?? null,
    planIntent: lease.plan?.intent ?? null,
    acceptanceCriteria: lease.plan?.acceptanceCriteria.slice(0, 12).map(value => clipped(value, 300)) ?? [],
    tasks,
    omittedTaskCount: Math.max(0, (lease.plan?.tasks.length ?? 0) - tasks.length),
    verificationHistory: lease.verificationHistory.slice(-5).map(record => ({
      attempt: record.attempt,
      verdict: record.verdict,
      summary: clipped(record.summary),
      findings: record.findings.slice(0, 10).map(value => clipped(value)),
      checks: record.checks,
      reviewers: record.reviewers.map(reviewer => ({
        role: reviewer.role,
        verdict: reviewer.verdict,
        summary: clipped(reviewer.summary),
        findings: reviewer.findings.slice(0, 5).map(value => clipped(value)),
      })),
    })),
    dynamicExtensions: lease.dynamicExtensions.map(extension => ({
      logicalId: extension.logicalId,
      version: extension.version,
      sourceSha256: extension.sourceSha256,
      status: extension.status,
    })),
    recordedAt: Date.now(),
  }
  const complete = JSON.stringify({ ...payload, truncated: false }, null, 2)
  if (complete.length <= 30_000) return complete
  return JSON.stringify({
    ...payload,
    truncated: true,
    acceptanceCriteria: payload.acceptanceCriteria.slice(0, 4),
    tasks: payload.tasks.slice(0, 16).map(task => ({
      id: task.id,
      title: clipped(task.title, 160),
      status: task.status,
      dependencies: task.dependencies.slice(0, 8),
      evidence: task.evidence.slice(-1),
      attempts: task.attempts,
      ...(task.reason === undefined ? {} : { reason: clipped(task.reason, 160) }),
    })),
    omittedTaskCount: payload.omittedTaskCount + Math.max(0, payload.tasks.length - 16),
    verificationHistory: payload.verificationHistory.slice(-3).map(record => ({
      attempt: record.attempt,
      verdict: record.verdict,
      summary: clipped(record.summary, 240),
      findings: record.findings.slice(0, 3).map(value => clipped(value, 240)),
    })),
  }, null, 2)
}

/** Register explicit project-memory and handoff tools. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_memory',
    description: 'Explicitly list, read, write, or delete bounded project memory. Reads are never injected automatically; writes require the active Autopilot authorization.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'read', 'write', 'delete'] },
      key: { type: 'string' },
      value: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      expectedRevision: { type: 'number' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const workspace = workspaceOf(agent)
      if (args.action === 'list') {
        return {
          entries: ctx.autopilotMemory.list(workspace).map(entry => ({
            key: entry.key,
            revision: entry.revision,
            tags: [...entry.tags],
            updatedAt: entry.updatedAt,
            preview: entry.preview,
          })),
        }
      }
      if (args.key === undefined) throw new Error(`autopilot_memory ${args.action} requires key`)
      if (args.action === 'read') return { entry: memoryEntryJson(ctx.autopilotMemory.read(workspace, args.key)) }
      requireAuthorizedMutation(ctx, agent)
      if (args.action === 'write') {
        if (args.value === undefined) throw new Error('autopilot_memory write requires value')
        return {
          entry: memoryEntryJson(await ctx.autopilotMemory.write(
            workspace,
            args.key,
            args.value,
            args.tags ?? [],
            args.expectedRevision,
          )),
        }
      }
      return { deleted: await ctx.autopilotMemory.delete(workspace, args.key, args.expectedRevision) }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_handoff',
    description: 'Persist a bounded, revision-addressed handoff containing the exact Goal/run refs, budgets, next safe action, task evidence, verification policy, and managed Cordis versions. Safe paused and attention states may be recorded.',
    parameters: {
      summary: { type: 'string', required: true },
      nextAction: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const { goal, lease } = requireHandoffState(ctx, agent)
      const summary = args.summary.trim()
      const nextAction = args.nextAction.trim()
      if (summary.length === 0) throw new Error('handoff summary must not be empty')
      if (nextAction.length === 0) throw new Error('handoff nextAction must not be empty')
      if (summary.length > 4000 || nextAction.length > 2000) {
        throw new Error('handoff summary or nextAction exceeds its bounded prose limit')
      }
      const entry = await ctx.autopilotMemory.write(
        workspaceOf(agent),
        `handoff:${lease.id}:${lease.generation}:${lease.revision}`,
        handoffValue(goal, lease, summary, nextAction),
        ['handoff', 'run-state'],
      )
      return { key: entry.key, revision: entry.revision, runId: lease.id }
    },
  })))
  registerRecoveryContribution(ctx, 'tool-memory')
}
