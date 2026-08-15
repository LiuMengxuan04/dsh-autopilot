/** Continuable-team service over DSH native durable subagent conversations. */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentDescendantListEntry,
  SubagentReportDelivery,
} from '@deepseek-ai/dsh-subagent'
import s from '@deepseek-ai/schemastery'
import type { AutonomyLeaseView } from './service.ts'
import {
  acceptTeamMessage,
  acceptTeamStart,
  bindAcceptedTeamStartAttention,
  failTeamMessage,
  failTeamStart,
  interruptTeamThread,
  markTeamThreadAttention,
  parseTeamChildLabel,
  prepareTeamMessage,
  prepareTeamThread,
  settleTeamThread,
  TEAM_STATE_VERSION,
  TEAM_TASK_ID_PATTERN,
  teamChildLabel,
} from './team-state.ts'
import type {
  TeamEvidence,
  TeamOrphanRecord,
  TeamTaskReport,
  TeamThreadSnapshot,
} from './team-state.ts'
import { DurableTeamStore } from './team-store.ts'

/** Conservative inherited tools available to a continuable task worker. */
export const DEFAULT_TEAM_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  'bash',
  'pwsh',
  'str_replace_editor',
  'glob',
  'grep',
  'lsp',
  'skill',
  'web_search',
  'web_fetch',
  'read_image',
  'todo_write',
  'job_output',
  'job_list',
  'job_kill',
])

/** Deployment-owned route and capability policy for continuable workers. */
export interface ContinuableTeamConfig {
  /** DSH transport with `prepareContinuable` support. */
  readonly provider?: string
  /** Optional LLM provider route persisted in each child descriptor. */
  readonly agentProvider?: string
  /** Optional LLM model route persisted in each child descriptor. */
  readonly agentModel?: string
  /** Optional child persona persisted for every cold activation. */
  readonly persona?: string
  /** Exact inherited global tools a continuable task worker may see. */
  readonly toolAllowlist?: readonly string[]
  /** Scheduling policy for accepted structured reports. */
  readonly reportDelivery?: SubagentReportDelivery
}

interface ResolvedContinuableTeamConfig {
  readonly provider: string
  readonly agentOptions?: AgentOptions | undefined
  readonly persona: string
  readonly toolAllowlist: readonly string[]
  readonly reportDelivery: SubagentReportDelivery
}

/** Request to atomically claim and start one dependency-ready DAG task. */
export interface ContinuableTeamStartRequest {
  readonly taskId: string
  readonly role: string
  readonly prompt: string
  readonly signal: AbortSignal
  /** Host-owned provenance wrapper shared with every admitted Autopilot subagent start. */
  readonly startContinuable: ManagedContinuableStart
}

/** Exact Host callback that admits a continuable start under managed-start provenance. */
export type ManagedContinuableStart = (spec: ContinuableStartSpec) => Promise<ContinuableStart>

/** Request for a later FIFO message, including a cold child. */
export interface ContinuableTeamFollowupRequest {
  readonly taskId: string
  readonly message: string
  readonly signal: AbortSignal
}

/** Reconciliation result for one exact parent run generation. */
export interface ContinuableTeamReconcileResult {
  readonly inspected: number
  readonly resumedSettlements: number
  readonly orphaned: number
  readonly issues: readonly string[]
}

/** Stable continuable-team API failure. */
export class ContinuableTeamError extends Error {
  /** Machine-routable failure category. */
  readonly code:
    | 'AUTOPILOT_TEAM_INVALID'
    | 'AUTOPILOT_TEAM_MISSING'
    | 'AUTOPILOT_TEAM_CONFLICT'
    | 'AUTOPILOT_TEAM_UNCERTAIN'

  /**
   * @param message - Actionable failure detail.
   * @param code - Stable failure category.
   */
  constructor(message: string, code: ContinuableTeamError['code']) {
    super(message)
    this.name = 'ContinuableTeamError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotTeam: ContinuableTeamService
  }
}

/** Host service that owns durable team attribution, mailbox delivery, and DAG settlement. */
export class ContinuableTeamService extends Service {
  static inject = ['agents', 'autonomy', 'goals', 'storageDomain', 'subagents', 'tools']

  static Config = s.object({
    provider: s.string().default('spawn'),
    agentProvider: s.string(),
    agentModel: s.string(),
    persona: s.string().default(
      'You are a continuable Autopilot task worker. Work only on the assigned DAG task, preserve evidence, '
      + 'and use autopilot_team_report exactly once when the task has a final outcome.',
    ),
    toolAllowlist: s.array(s.string()).default([...DEFAULT_TEAM_TOOL_ALLOWLIST]),
    reportDelivery: s.union(['quiet', 'wakeup'] as const).default('wakeup'),
  }) as s<ContinuableTeamConfig>

  private store: DurableTeamStore | undefined
  private readonly config: ResolvedContinuableTeamConfig
  private observerTail: Promise<void> = Promise.resolve()
  private readonly reconciliations = new Map<string, Promise<ContinuableTeamReconcileResult>>()
  private readonly queuedReconciliations = new Set<string>()

  /**
   * @param ctx - Host context carrying Autonomy, storage-domain, tools, agents, and subagents.
   * @param config - Deployment-fixed child route and tool policy.
   */
  constructor(ctx: Context, config: ContinuableTeamConfig = {}) {
    super(ctx, 'autopilotTeam')
    this.config = resolveConfig(config)
  }

  /** Open durable state and install lifecycle reconciliation. */
  protected async [Service.init](): Promise<void> {
    const store = await DurableTeamStore.open(this.ctx)
    this.store = store
    this.ctx.effect(() => async () => {
      await this.observerTail
      /* v8 ignore else -- this effect exclusively owns the opened store slot. */
      if (this.store === store) this.store = undefined
      await store.close()
    }, 'dsh-autopilot.continuableTeamClose')

    this.ctx.on('agent/created', ({ agent }) => {
      const lease = this.ctx.autonomy.get(agent)
      if (lease !== undefined && (lease.phase === 'running' || lease.phase === 'verifying')) {
        this.enqueueRunReconciliation(agent, lease)
      }
    })
    this.ctx.on('autonomy/changed', async ({ agent, operation, view }) => {
      if (view.phase === 'running' || view.phase === 'verifying') {
        if (operation === 'resume') {
          await this.reconcileRun(agent, view, new AbortController().signal)
        }
        return
      }
      await this.interruptRunChildren(agent, view, `Autopilot run entered ${view.phase}`)
    })
    for (const agent of this.ctx.agents.roots()) {
      const lease = this.ctx.autonomy.get(agent)
      if (lease !== undefined && (lease.phase === 'running' || lease.phase === 'verifying')) {
        this.enqueueRunReconciliation(agent, lease)
      }
    }
  }

  /** Atomically claim one task before creating its durable continuable child. */
  async start(parent: Agent, request: ContinuableTeamStartRequest): Promise<TeamThreadSnapshot> {
    const taskId = normalizedTaskId(request.taskId)
    const role = boundedText(request.role, 'team role', 256)
    const prompt = boundedText(request.prompt, 'team prompt', 32_000)
    const preflight = await this.reconcile(parent, request.signal)
    if (preflight.issues.length > 0) {
      throw new ContinuableTeamError(
        `team start blocked by reconciliation: ${preflight.issues.join('; ')}`,
        'AUTOPILOT_TEAM_UNCERTAIN',
      )
    }
    const before = this.requireRunningLease(parent)
    const identity = runTaskIdentity(parent, before, taskId)
    if (this.requireStore().get(identity) !== undefined) {
      throw new ContinuableTeamError(`task "${taskId}" already has a continuable-team ledger`, 'AUTOPILOT_TEAM_CONFLICT')
    }

    const claimed = await this.ctx.autonomy.claimTasks(parent, [taskId])
    const label = teamChildLabel(claimed.id, claimed.generation, taskId)
    const prepared = prepareTeamThread({
      parentSessionId: String(parent.id),
      runId: claimed.id,
      generation: claimed.generation,
      runRevisionAtClaim: claimed.revision,
      maxAuditRecords: claimed.maxAuditRecords,
      maxAuditBytes: claimed.maxAuditBytes,
      taskId,
      provider: this.config.provider,
      label,
      role,
      promptSha256: sha256(prompt),
    }, Date.now())
    try {
      await this.requireStore().append('prepare', prepared)
    } catch (error: unknown) {
      await this.markAutonomyAttention(
        parent,
        this.ctx.autonomy.get(parent) ?? claimed,
        `claimed team task could not persist its start intent: ${errorMessage(error)}`,
      )
      throw error
    }
    let accepted: ContinuableStart | undefined
    try {
      const activitySignal = this.ctx.autonomy.signal(parent)
      accepted = await request.startContinuable({
        provider: this.config.provider,
        label,
        request: {
          parent,
          prompt: [{ type: 'text', text: taskPrompt(prepared, prompt) }],
          maxDepth: 1,
          toolFilter: { allow: this.allowedInheritedTools(parent) },
          persona: this.config.persona,
          ...(this.config.agentOptions === undefined ? {} : { agentOptions: this.config.agentOptions }),
        },
        signal: AbortSignal.any([request.signal, activitySignal]),
      })
      const current = this.exactThread(prepared)
      const started = acceptTeamStart(current, String(accepted.childId), String(accepted.messageId), Date.now())
      return await this.requireStore().append('start', started)
    } catch (error: unknown) {
      const reason = errorMessage(error)
      if (accepted !== undefined) {
        await this.recordAcceptedStartFailure(parent, prepared, accepted, reason)
      } else {
        await this.recordRejectedStart(parent, prepared, reason)
      }
      throw error
    }
  }

  /** Deliver a later FIFO message; DSH cold-resumes an absent durable child. */
  async followup(parent: Agent, request: ContinuableTeamFollowupRequest): Promise<TeamThreadSnapshot> {
    let lease = this.requireRunningLease(parent)
    const taskId = normalizedTaskId(request.taskId)
    const message = boundedText(request.message, 'team followup', 32_000)
    const current = this.requireThread(parent, lease, taskId)
    const task = lease.plan?.tasks.find(candidate => candidate.id === taskId)
    if (task?.status === 'pending') {
      await this.ctx.autonomy.updateTask(parent, taskId, 'start')
      lease = this.requireRunningLease(parent)
    } else if (task?.status !== 'in_progress') {
      throw new ContinuableTeamError(
        `task "${taskId}" cannot receive a followup while DAG status is ${task?.status ?? 'missing'}`,
        'AUTOPILOT_TEAM_CONFLICT',
      )
    }
    this.assertThreadRun(current, lease)
    if (current.childSessionId === undefined) {
      throw new ContinuableTeamError(`task "${taskId}" has no accepted child`, 'AUTOPILOT_TEAM_MISSING')
    }
    const content: ContentBlock[] = [{ type: 'text', text: message }]
    const prepared = prepareTeamMessage(current, {
      kind: 'followup',
      contentSha256: sha256(message),
      preparedAt: Date.now(),
    }, Date.now())
    await this.requireStore().append('followup-prepare', prepared)
    let deliveryAccepted = false
    try {
      const messageId = await this.ctx.subagents.followup(
        parent,
        SessionId(current.childSessionId),
        content,
        {
          source: { kind: 'plugin', plugin: 'dsh-autopilot-team' },
          signal: AbortSignal.any([request.signal, this.ctx.autonomy.signal(parent)]),
        },
      )
      deliveryAccepted = true
      const accepted = acceptTeamMessage(this.exactThread(prepared), String(messageId), Date.now())
      return await this.requireStore().append('followup-accepted', accepted)
    } catch (error: unknown) {
      if (deliveryAccepted) {
        await this.failClosedThread(
          parent,
          prepared,
          `accepted team followup could not be persisted: ${errorMessage(error)}`,
        )
      } else {
        const latest = this.exactThread(prepared)
        const failed = failTeamMessage(latest, errorMessage(error), Date.now())
        await this.requireStore().append('followup-failed', failed)
      }
      throw error
    }
  }

  /** Interrupt only the child's current turn and retain its durable conversation. */
  async interrupt(parent: Agent, taskIdInput: string, reasonInput: string): Promise<TeamThreadSnapshot> {
    const lease = this.requireRunningLease(parent)
    const taskId = normalizedTaskId(taskIdInput)
    const reason = boundedText(reasonInput, 'team interrupt reason', 8192)
    const current = this.requireThread(parent, lease, taskId)
    if (current.phase === 'interrupted') return current
    if (current.phase !== 'active' || current.childSessionId === undefined) {
      throw new ContinuableTeamError(
        `task "${taskId}" cannot be interrupted while ${current.phase}`,
        'AUTOPILOT_TEAM_CONFLICT',
      )
    }
    this.ctx.subagents.interrupt(SessionId(current.childSessionId), {
      kind: 'user',
      parentSessionId: parent.id,
    })
    const interrupted = interruptTeamThread(current, reason, Date.now())
    return await this.requireStore().append('interrupt', interrupted)
  }

  /** Apply a child-authenticated structured report to its exact DAG task. */
  async report(
    child: Agent,
    input: Omit<TeamTaskReport, 'submittedAt'>,
    signal: AbortSignal,
  ): Promise<TeamThreadSnapshot> {
    const thread = this.requireStore().getByChild(String(child.id))
    if (thread === undefined) {
      throw new ContinuableTeamError(`child "${child.id}" has no team attribution`, 'AUTOPILOT_TEAM_MISSING')
    }
    if (this.ctx.agents.get(child.id) !== child) {
      throw new ContinuableTeamError('team report requires the exact live child Agent', 'AUTOPILOT_TEAM_CONFLICT')
    }
    const parent = this.ctx.agents.get(SessionId(thread.parentSessionId))
    if (parent === undefined) {
      throw new ContinuableTeamError('team report requires the exact live parent Agent', 'AUTOPILOT_TEAM_MISSING')
    }
    const lease = this.requireRunningLease(parent)
    this.assertThreadRun(thread, lease)
    const report = normalizedReport(input, Date.now())
    const reportText = JSON.stringify({
      kind: 'autopilot-team-report',
      runId: thread.runId,
      generation: thread.generation,
      taskId: thread.taskId,
      childSessionId: thread.childSessionId,
      status: report.status,
      summary: report.summary,
      evidence: report.evidence,
    })
    const prepared = prepareTeamMessage(thread, {
      kind: 'report',
      contentSha256: sha256(reportText),
      preparedAt: Date.now(),
      report,
    }, Date.now())
    await this.requireStore().append('report-prepare', prepared)
    let accepted = false
    let acceptedPersisted = false
    try {
      const messageId = await this.ctx.subagents.reportFrom(child, [{ type: 'text', text: reportText }], {
        delivery: this.config.reportDelivery,
        signal,
      })
      accepted = true
      const reported = acceptTeamMessage(this.exactThread(prepared), String(messageId), Date.now())
      await this.requireStore().append('report-accepted', reported)
      acceptedPersisted = true
      return await this.settleAcceptedReport(parent, reported)
    } catch (error: unknown) {
      if (!accepted) {
        const latest = this.exactThread(prepared)
        const failed = failTeamMessage(latest, errorMessage(error), Date.now())
        await this.requireStore().append('report-failed', failed)
      } else if (!acceptedPersisted) {
        await this.failClosedThread(parent, prepared, `accepted team report could not be persisted: ${errorMessage(error)}`)
      }
      throw error
    }
  }

  /** Return current durable team rows for one parent without resuming children. */
  list(parent: Agent): readonly TeamThreadSnapshot[] {
    const lease = this.ctx.autonomy.get(parent)
    if (lease === undefined) return Object.freeze([])
    return this.listRun(String(parent.id), lease.id, lease.generation)
  }

  /** Return exact run-generation team rows without requiring a live parent handle. */
  listRun(parentSessionId: string, runId: string, generation: number): readonly TeamThreadSnapshot[] {
    return this.requireStore().list({ parentSessionId, runId, generation })
  }

  /** Return durable orphan observations for operational inspection. */
  orphans(parent: Agent): readonly TeamOrphanRecord[] {
    return this.requireStore().orphans(String(parent.id))
  }

  /** Reconcile cold accepted reports and reject every unattributed continuable descendant. */
  reconcile(parent: Agent, signal: AbortSignal): Promise<ContinuableTeamReconcileResult> {
    const lease = this.ctx.autonomy.get(parent)
    if (lease === undefined) return Promise.resolve(emptyReconcileResult())
    return this.reconcileRun(parent, lease, signal)
  }

  private reconcileRun(
    parent: Agent,
    expected: Pick<AutonomyLeaseView, 'id' | 'generation'>,
    signal: AbortSignal,
  ): Promise<ContinuableTeamReconcileResult> {
    const key = reconciliationKey(parent, expected)
    const running = this.reconciliations.get(key)
    if (running !== undefined) return running
    const task = this.reconcileOnce(parent, expected, signal)
    this.reconciliations.set(key, task)
    const release = () => {
      /* v8 ignore else -- same-key reconciliation cannot be replaced while this task occupies the map. */
      if (this.reconciliations.get(key) === task) this.reconciliations.delete(key)
    }
    void task.then(release, release)
    return task
  }

  /** Drain lifecycle observations; useful for deterministic host shutdown and tests. */
  async whenObserversIdle(): Promise<void> {
    await this.observerTail
  }

  private async reconcileOnce(
    parent: Agent,
    expected: Pick<AutonomyLeaseView, 'id' | 'generation'>,
    signal: AbortSignal,
  ): Promise<ContinuableTeamReconcileResult> {
    const lease = this.ctx.autonomy.get(parent)
    if (!isExactRun(lease, expected)) return staleReconcileResult(0)
    let rows: readonly SubagentDescendantListEntry[]
    try {
      rows = await this.ctx.subagents.listDescendants(parent.id, signal)
    } catch (error: unknown) {
      const reason = `continuable-team descendant audit failed: ${errorMessage(error)}`
      await this.markAutonomyAttention(parent, lease, reason)
      throw new ContinuableTeamError(reason, 'AUTOPILOT_TEAM_UNCERTAIN')
    }
    const current = this.ctx.autonomy.get(parent)
    if (!isExactRun(current, expected)) return staleReconcileResult(rows.length)
    const issues: string[] = []
    let orphaned = 0
    let resumedSettlements = 0
    for (const row of rows) {
      if (row.kind !== 'child' || row.mode !== 'continuable') continue
      const known = this.requireStore().getByChild(String(row.id))
      if (known !== undefined) {
        if (known.parentSessionId !== String(parent.id) || row.parentId !== parent.id || row.depth !== 1
          || row.label !== known.label) {
          issues.push(`child ${row.id} does not match its direct-parent team attribution`)
        }
        continue
      }
      const reason = `continuable descendant ${row.id} is not attributed to a team task`
      issues.push(reason)
      orphaned += 1
      await this.recordOrphan(parent, current, String(row.id), reason, {
        label: row.label,
        parentId: String(row.parentId),
        depth: row.depth,
      })
      if (!isExactRun(this.ctx.autonomy.get(parent), expected)) return staleReconcileResult(rows.length)
      this.ctx.subagents.interrupt(row.id, { kind: 'user', parentSessionId: parent.id })
    }

    const threads = this.requireStore().list({
      parentSessionId: String(parent.id),
      runId: current.id,
      generation: current.generation,
    })
    for (const thread of threads) {
      if (thread.phase === 'starting') {
        issues.push(`task ${thread.taskId} has an unfinished child-start intent`)
      } else if (thread.pendingMessage !== undefined) {
        issues.push(`task ${thread.taskId} has an inbox delivery with unknown acceptance`)
      } else if (thread.phase === 'reporting' && thread.report !== undefined
        && (lease.phase === 'running' || lease.phase === 'verifying')) {
        await this.settleAcceptedReport(parent, thread)
        resumedSettlements += 1
      }
    }
    if (issues.length > 0) {
      const latest = this.ctx.autonomy.get(parent)
      if (!isExactRun(latest, expected)) return staleReconcileResult(rows.length)
      const reason = `continuable-team reconciliation requires attention: ${issues.join('; ')}`
      for (const thread of threads) {
        if (['active', 'interrupted', 'reporting'].includes(thread.phase)) {
          const latest = this.exactThread(thread)
          const attention = markTeamThreadAttention(latest, reason, Date.now())
          await this.requireStore().append('attention', attention)
        }
      }
      const attentionLease = this.ctx.autonomy.get(parent)
      if (!isExactRun(attentionLease, expected)) return staleReconcileResult(rows.length)
      await this.markAutonomyAttention(parent, attentionLease, reason)
    }
    return Object.freeze({
      inspected: rows.length,
      resumedSettlements,
      orphaned,
      issues: Object.freeze(issues),
    })
  }

  private async recordOrphan(
    parent: Agent,
    run: Pick<AutonomyLeaseView, 'id' | 'generation'>,
    childSessionId: string,
    reason: string,
    details: {
      readonly label: string
      readonly initialMessageId?: string | undefined
      readonly parentId: string
      readonly depth: number
    },
  ): Promise<TeamOrphanRecord> {
    const parsed = parseTeamChildLabel(details.label)
    const attribution = parsed === undefined
      ? reason
      : `${reason}; label names run ${parsed.runId} generation ${parsed.generation} task ${parsed.taskId}`
    const record: TeamOrphanRecord = Object.freeze({
      version: TEAM_STATE_VERSION,
      parentSessionId: String(parent.id),
      runId: run.id,
      generation: run.generation,
      childSessionId,
      observedAt: Date.now(),
      reason: attribution,
      label: details.label,
      ...(details.initialMessageId === undefined ? {} : { initialMessageId: details.initialMessageId }),
      parentId: details.parentId,
      depth: details.depth,
    })
    return await this.requireStore().recordOrphan(record)
  }

  private async recordAcceptedStartFailure(
    parent: Agent,
    prepared: TeamThreadSnapshot,
    accepted: ContinuableStart,
    reason: string,
  ): Promise<void> {
    await this.recordOrphan(parent, { id: prepared.runId, generation: prepared.generation }, String(accepted.childId),
      `accepted team child could not be bound to its task ledger: ${reason}`, {
        label: prepared.label,
        initialMessageId: String(accepted.messageId),
        parentId: String(parent.id),
        depth: 1,
      })
    this.ctx.subagents.interrupt(accepted.childId, { kind: 'user', parentSessionId: parent.id })
    const attentionReason = `accepted child binding failed: ${reason}`
    const current = this.exactThread(prepared)
    const attention = bindAcceptedTeamStartAttention(
      current,
      String(accepted.childId),
      String(accepted.messageId),
      attentionReason,
      Date.now(),
    )
    await this.requireStore().append('attention', attention)
    const lease = this.ctx.autonomy.get(parent)
    /* v8 ignore else -- Autonomy retains every claimed run even after revocation. */
    if (lease !== undefined) await this.markAutonomyAttention(parent, lease, attentionReason)
  }

  private async recordRejectedStart(
    parent: Agent,
    prepared: TeamThreadSnapshot,
    reason: string,
  ): Promise<void> {
    const latest = this.exactThread(prepared)
    await this.requireStore().append('start-failed', failTeamStart(latest, reason, Date.now()))
    const lease = this.ctx.autonomy.get(parent)
    const task = lease?.plan?.tasks.find(candidate => candidate.id === prepared.taskId)
    if (lease !== undefined && lease.id === prepared.runId && lease.generation === prepared.generation
      && lease.phase === 'running' && task?.status === 'in_progress') {
      await this.ctx.autonomy.updateTask(parent, prepared.taskId, 'fail', { reason })
    }
  }

  private async settleAcceptedReport(parent: Agent, threadInput: TeamThreadSnapshot): Promise<TeamThreadSnapshot> {
    const persisted = this.requireStore().get(threadInput)
    if (persisted?.phase === 'settled') return persisted
    const thread = this.exactThread(threadInput)
    const report = thread.report
    if (thread.phase !== 'reporting' || report === undefined || thread.pendingMessage !== undefined) {
      throw new ContinuableTeamError('team report is not durably accepted for settlement', 'AUTOPILOT_TEAM_CONFLICT')
    }
    const lease = this.requireRunningLease(parent)
    this.assertThreadRun(thread, lease)
    const task = lease.plan?.tasks.find(candidate => candidate.id === thread.taskId)
    if (task === undefined) throw new ContinuableTeamError('team task disappeared from the DAG', 'AUTOPILOT_TEAM_CONFLICT')
    const expectedStatus = report.status === 'completed'
      ? 'completed'
      : report.status === 'blocked' ? 'blocked' : 'failed'
    if (task.status !== expectedStatus) {
      if (task.status !== 'in_progress') {
        throw new ContinuableTeamError(
          `team report ${report.status} conflicts with DAG status ${task.status}`,
          'AUTOPILOT_TEAM_CONFLICT',
        )
      }
      if (report.status === 'completed') {
        await this.ctx.autonomy.updateTask(parent, thread.taskId, 'complete', {
          evidence: report.evidence.map(item => ({ ...item })),
        })
      } else {
        await this.ctx.autonomy.updateTask(parent, thread.taskId, report.status === 'blocked' ? 'block' : 'fail', {
          reason: report.summary,
        })
      }
    }
    const persistedLatest = this.requireStore().get(thread)
    if (persistedLatest?.phase === 'settled') return persistedLatest
    const latest = this.exactThread(thread)
    const settled = settleTeamThread(latest, Date.now())
    return await this.requireStore().append('settle', settled)
  }

  private async failClosedThread(parent: Agent, thread: TeamThreadSnapshot, reason: string): Promise<void> {
    const latest = this.requireStore().get(thread)
    if (latest !== undefined && ['active', 'interrupted', 'reporting'].includes(latest.phase)) {
      await this.requireStore().append('attention', markTeamThreadAttention(latest, reason, Date.now()))
    }
    const lease = this.ctx.autonomy.get(parent)
    if (lease !== undefined) await this.markAutonomyAttention(parent, lease, reason)
  }

  private async markAutonomyAttention(
    parent: Agent,
    lease: AutonomyLeaseView,
    reason: string,
  ): Promise<void> {
    if (lease.phase === 'completed' || lease.phase === 'revoked' || lease.phase === 'needs-attention') return
    await this.ctx.autonomy.markNeedsAttention({
      sessionId: String(parent.id),
      runId: lease.id,
      generation: lease.generation,
      revision: lease.revision,
    }, reason)
  }

  private async interruptRunChildren(
    parent: Agent,
    lease: AutonomyLeaseView,
    reason: string,
  ): Promise<void> {
    const threads = this.requireStore().list({
      parentSessionId: String(parent.id),
      runId: lease.id,
      generation: lease.generation,
    })
    for (const thread of threads) {
      if (thread.childSessionId === undefined) continue
      if (thread.phase === 'settled') continue
      this.ctx.subagents.interrupt(SessionId(thread.childSessionId), {
        kind: 'user',
        parentSessionId: parent.id,
      })
      if (thread.phase === 'active') {
        const interrupted = interruptTeamThread(this.exactThread(thread), reason, Date.now())
        await this.requireStore().append('interrupt', interrupted)
      }
    }
  }

  private enqueueObserver(task: () => Promise<void>): void {
    const observed = this.observerTail.then(task)
    this.observerTail = observed.catch((error: unknown) => {
      this.ctx.logger.error(`dsh-autopilot continuable-team observer failed: ${errorMessage(error)}`)
    })
  }

  private enqueueRunReconciliation(
    parent: Agent,
    expected: Pick<AutonomyLeaseView, 'id' | 'generation'>,
  ): void {
    const key = reconciliationKey(parent, expected)
    if (this.queuedReconciliations.has(key)) return
    this.queuedReconciliations.add(key)
    this.enqueueObserver(async () => {
      try {
        const current = this.ctx.autonomy.get(parent)
        if (this.ctx.agents.get(parent.id) !== parent || !isExactRun(current, expected)
          || (current.phase !== 'running' && current.phase !== 'verifying')) return
        await this.reconcileRun(parent, expected, new AbortController().signal)
      } finally {
        this.queuedReconciliations.delete(key)
      }
    })
  }

  private requireStore(): DurableTeamStore {
    if (this.store === undefined) {
      throw new ContinuableTeamError('continuable-team storage is not initialized', 'AUTOPILOT_TEAM_INVALID')
    }
    return this.store
  }

  private requireRunningLease(parent: Agent): AutonomyLeaseView {
    const lease = this.ctx.autonomy.get(parent)
    const goal = this.ctx.goals.get(parent)
    if (lease === undefined || goal === undefined || goal.id !== lease.goalId
      || lease.activation !== 'armed' || goal.activation !== 'armed'
      || (lease.phase !== 'running' && lease.phase !== 'verifying') || goal.phase !== 'active') {
      throw new ContinuableTeamError(
        'continuable-team mutation requires the exact armed Goal and Autopilot run',
        'AUTOPILOT_TEAM_INVALID',
      )
    }
    return lease
  }

  private requireThread(parent: Agent, lease: AutonomyLeaseView, taskId: string): TeamThreadSnapshot {
    const thread = this.requireStore().get(runTaskIdentity(parent, lease, taskId))
    if (thread === undefined) {
      throw new ContinuableTeamError(`task "${taskId}" has no continuable-team child`, 'AUTOPILOT_TEAM_MISSING')
    }
    return thread
  }

  private exactThread(thread: TeamThreadSnapshot): TeamThreadSnapshot {
    const current = this.requireStore().get(thread)
    if (current === undefined || current.revision !== thread.revision) {
      throw new ContinuableTeamError(
        `team task "${thread.taskId}" changed during an external operation`,
        'AUTOPILOT_TEAM_CONFLICT',
      )
    }
    return current
  }

  private assertThreadRun(thread: TeamThreadSnapshot, lease: AutonomyLeaseView): void {
    if (thread.runId !== lease.id || thread.generation !== lease.generation) {
      throw new ContinuableTeamError('team child belongs to a different run generation', 'AUTOPILOT_TEAM_CONFLICT')
    }
  }

  private allowedInheritedTools(parent: Agent): readonly string[] {
    const configured = new Set(this.config.toolAllowlist)
    return Object.freeze(this.ctx.tools.schemas(parent)
      .map(tool => tool.name)
      .filter(name => configured.has(name)))
  }
}

function resolveConfig(config: ContinuableTeamConfig): ResolvedContinuableTeamConfig {
  const provider = nonEmptyConfig(config.provider ?? 'spawn', 'continuable-team provider')
  const agentProvider = optionalConfig(config.agentProvider, 'continuable-team agentProvider')
  const agentModel = optionalConfig(config.agentModel, 'continuable-team agentModel')
  const persona = nonEmptyConfig(
    config.persona
      ?? 'You are a continuable Autopilot task worker. Work only on the assigned DAG task, preserve evidence, and use autopilot_team_report exactly once when the task has a final outcome.',
    'continuable-team persona',
  )
  const toolAllowlist = (config.toolAllowlist ?? DEFAULT_TEAM_TOOL_ALLOWLIST).map(tool =>
    nonEmptyConfig(tool, 'continuable-team tool name'))
  if (new Set(toolAllowlist).size !== toolAllowlist.length) {
    throw new TypeError('continuable-team tool allowlist must not contain duplicates')
  }
  const reportDelivery = config.reportDelivery ?? 'wakeup'
  if (reportDelivery !== 'quiet' && reportDelivery !== 'wakeup') {
    throw new TypeError('continuable-team reportDelivery must be quiet or wakeup')
  }
  const agentOptions = agentProvider === undefined && agentModel === undefined
    ? undefined
    : Object.freeze({
      ...(agentProvider === undefined ? {} : { provider: agentProvider }),
      ...(agentModel === undefined ? {} : { model: agentModel }),
    })
  return Object.freeze({
    provider,
    ...(agentOptions === undefined ? {} : { agentOptions }),
    persona,
    toolAllowlist: Object.freeze(toolAllowlist),
    reportDelivery,
  })
}

function optionalConfig(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : nonEmptyConfig(value, field)
}

function nonEmptyConfig(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${field} must not be empty`)
  return normalized
}

function normalizedTaskId(taskId: string): string {
  const normalized = taskId.trim()
  if (!TEAM_TASK_ID_PATTERN.test(normalized)) {
    throw new ContinuableTeamError('team task id must match the Autopilot task-id format', 'AUTOPILOT_TEAM_INVALID')
  }
  return normalized
}

function boundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ContinuableTeamError(`${field} must contain 1-${maximum} characters`, 'AUTOPILOT_TEAM_INVALID')
  }
  return normalized
}

function normalizedReport(input: Omit<TeamTaskReport, 'submittedAt'>, now: number): TeamTaskReport {
  const summary = boundedText(input.summary, 'team report summary', 8192)
  if (!['completed', 'blocked', 'failed'].includes(input.status)) {
    throw new ContinuableTeamError('team report status is invalid', 'AUTOPILOT_TEAM_INVALID')
  }
  if (input.evidence.length > 128 || (input.status === 'completed' && input.evidence.length === 0)) {
    throw new ContinuableTeamError(
      'completed team reports require 1-128 evidence items',
      'AUTOPILOT_TEAM_INVALID',
    )
  }
  const evidence: TeamEvidence[] = input.evidence.map(item => Object.freeze({
    kind: item.kind,
    ref: boundedText(item.ref, 'team evidence ref', 4096),
    summary: boundedText(item.summary, 'team evidence summary', 4096),
  }))
  return Object.freeze({ status: input.status, summary, evidence: Object.freeze(evidence), submittedAt: now })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function taskPrompt(thread: TeamThreadSnapshot, prompt: string): string {
  return [
    `Autopilot run: ${thread.runId}`,
    `Generation: ${thread.generation}`,
    `Task: ${thread.taskId}`,
    `Role: ${thread.role}`,
    '',
    prompt,
    '',
    'When the task reaches a final outcome, call autopilot_team_report once with a structured status, summary, and evidence.',
  ].join('\n')
}

function emptyReconcileResult(): ContinuableTeamReconcileResult {
  return Object.freeze({
    inspected: 0,
    resumedSettlements: 0,
    orphaned: 0,
    issues: Object.freeze([]),
  })
}

function staleReconcileResult(inspected: number): ContinuableTeamReconcileResult {
  return Object.freeze({
    inspected,
    resumedSettlements: 0,
    orphaned: 0,
    issues: Object.freeze(['Autopilot run changed during continuable-team reconciliation']),
  })
}

function isExactRun(
  lease: AutonomyLeaseView | undefined,
  expected: Pick<AutonomyLeaseView, 'id' | 'generation'>,
): lease is AutonomyLeaseView {
  return lease !== undefined && lease.id === expected.id && lease.generation === expected.generation
}

function reconciliationKey(
  parent: Agent,
  run: Pick<AutonomyLeaseView, 'id' | 'generation'>,
): string {
  return JSON.stringify([String(parent.id), run.id, run.generation])
}

function runTaskIdentity(parent: Agent, lease: AutonomyLeaseView, taskId: string) {
  return {
    parentSessionId: String(parent.id),
    runId: lease.id,
    generation: lease.generation,
    taskId,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default ContinuableTeamService
