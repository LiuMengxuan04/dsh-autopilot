/** Managed deployment-profile workflows over the DSH workflow capability seam. */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import s from '@deepseek-ai/schemastery'
import type {
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import type { AutonomyLeaseView } from './service.ts'
import {
  applyManagedWorkflowTask,
  claimManagedWorkflow,
  failManagedWorkflow,
  finishManagedWorkflow,
  finishManagedWorkflowCancel,
  isManagedWorkflowTerminal,
  managedWorkflowTaskOutcomeSchema,
  markManagedWorkflowUncertain,
  prepareManagedWorkflow,
  requestManagedWorkflowCancel,
  settleManagedWorkflow,
  startManagedWorkflow,
  WORKFLOW_PROFILE_ID_PATTERN,
} from './workflow-state.ts'
import type {
  ManagedWorkflowSnapshot,
  ManagedWorkflowTaskOutcome,
  ManagedWorkflowTerminalPhase,
} from './workflow-state.ts'
import { DurableManagedWorkflowStore } from './workflow-store.ts'

/** Maximum deployment-authored script retained in one profile. */
export const MAX_WORKFLOW_PROFILE_SCRIPT_CHARS = 262_144 as const

/** Deployment-authored workflow profile unavailable for model mutation. */
export interface ManagedWorkflowProfileConfig {
  readonly id: string
  readonly description: string
  readonly script: string
  readonly whenToUse?: string | undefined
  readonly phases?: readonly {
    readonly title: string
    readonly detail?: string | undefined
    readonly provider?: string | undefined
    readonly model?: string | undefined
  }[] | undefined
  readonly subagentProvider?: string | undefined
  readonly maxTotalAgents: number
  readonly maxArgsBytes?: number | undefined
}

/** Managed workflow service configuration. */
export interface ManagedWorkflowServiceConfig {
  readonly profiles?: readonly ManagedWorkflowProfileConfig[] | undefined
}

/** Detached deployment profile view without executable source. */
export interface ManagedWorkflowProfileView {
  readonly id: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly maxTotalAgents: number
  readonly maxArgsBytes: number
  readonly sha256: string
}

/** Host callback that opens a workflow inside managed subagent provenance. */
export type ManagedWorkflowStart = (request: WorkflowStartRequest) => WorkflowRun

/** One model-safe managed-workflow request. */
export interface ManagedWorkflowRunRequest {
  readonly profileId: string
  readonly taskIds: readonly string[]
  readonly args?: Readonly<Record<string, unknown>> | undefined
  readonly signal: AbortSignal
  /** Host-owned provenance wrapper; this service never calls the engine directly. */
  readonly startWorkflow: ManagedWorkflowStart
}

/** Restart reconciliation summary for one parent Agent. */
export interface ManagedWorkflowReconcileResult {
  readonly inspected: number
  readonly uncertain: number
  readonly issues: readonly string[]
}

/** Stable managed-workflow service failure. */
export class ManagedWorkflowError extends Error {
  /** Machine-routable failure category. */
  readonly code:
    | 'AUTOPILOT_WORKFLOW_INVALID'
    | 'AUTOPILOT_WORKFLOW_PROFILE_MISSING'
    | 'AUTOPILOT_WORKFLOW_CONFLICT'
    | 'AUTOPILOT_WORKFLOW_BUDGET'
    | 'AUTOPILOT_WORKFLOW_UNCERTAIN'

  /**
   * @param message - Actionable failure detail.
   * @param code - Stable error category.
   */
  constructor(message: string, code: ManagedWorkflowError['code']) {
    super(message)
    this.name = 'ManagedWorkflowError'
    this.code = code
  }
}

interface ResolvedManagedWorkflowProfile {
  readonly id: string
  readonly description: string
  readonly script: string
  readonly meta: WorkflowMeta
  readonly subagentProvider?: string | undefined
  readonly maxTotalAgents: number
  readonly maxArgsBytes: number
  readonly sha256: string
}

interface ActiveManagedWorkflow {
  readonly parent: Agent
  readonly workflowId: string
  readonly runId: string
  readonly generation: number
  readonly controller: AbortController
  readonly done: Promise<void>
  resolveDone(): void
  run?: WorkflowRun | undefined
  cancellation?: Promise<void> | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotWorkflows: ManagedWorkflowService
  }
}

/** Host service that claims exact DAG tasks and durably owns workflow runs. */
export class ManagedWorkflowService extends Service {
  static inject = ['agents', 'autonomy', 'goals', 'storageDomain']

  static Config = s.object({
    profiles: s.array(s.object({
      id: s.string(),
      description: s.string(),
      script: s.string(),
      whenToUse: s.string(),
      phases: s.array(s.object({
        title: s.string(),
        detail: s.string(),
        provider: s.string(),
        model: s.string(),
      })),
      subagentProvider: s.string(),
      maxTotalAgents: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      maxArgsBytes: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32_768),
    })).default([]),
  }) as s<ManagedWorkflowServiceConfig>

  private readonly profiles: ReadonlyMap<string, ResolvedManagedWorkflowProfile>
  private store: DurableManagedWorkflowStore | undefined
  private readonly active = new Map<string, ActiveManagedWorkflow>()
  private observerTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Host context carrying Autonomy, Goal, Agent, and storage services.
   * @param config - Deployment-fixed executable profiles.
   */
  constructor(ctx: Context, config: ManagedWorkflowServiceConfig = {}) {
    super(ctx, 'autopilotWorkflows')
    this.profiles = resolveProfiles(config.profiles ?? [])
  }

  /** Open durable state and install cancellation and restart reconciliation. */
  protected async [Service.init](): Promise<void> {
    const store = await DurableManagedWorkflowStore.open(this.ctx)
    this.store = store
    this.ctx.effect(() => async () => {
      const cancellations = [...this.active.values()].map(entry =>
        this.requestCancellation(entry, 'managed workflow service disposed'))
      await Promise.allSettled(cancellations)
      await Promise.allSettled([...this.active.values()].map(entry => entry.done))
      await this.observerTail
      /* v8 ignore else -- this effect exclusively owns the opened store slot. */
      if (this.store === store) this.store = undefined
      await store.close()
    }, 'dsh-autopilot.managedWorkflowClose')

    this.ctx.on('agent/created', ({ agent }) => {
      this.enqueueObserver(async () => { await this.reconcile(agent) })
    })
    this.ctx.on('autonomy/changed', async ({ agent, operation, view }) => {
      if (view.phase === 'running' || view.phase === 'verifying') {
        if (operation === 'resume') await this.reconcile(agent)
        return
      }
      await this.cancelGeneration(agent, view, `Autopilot run entered ${view.phase}`)
    })

    for (const agent of this.ctx.agents.list()) {
      this.enqueueObserver(async () => { await this.reconcile(agent) })
    }
  }

  /** List executable profile metadata without exposing scripts. */
  listProfiles(): readonly ManagedWorkflowProfileView[] {
    return Object.freeze([...this.profiles.values()].map(profile => Object.freeze({
      id: profile.id,
      description: profile.description,
      ...(profile.meta.whenToUse === undefined ? {} : { whenToUse: profile.meta.whenToUse }),
      maxTotalAgents: profile.maxTotalAgents,
      maxArgsBytes: profile.maxArgsBytes,
      sha256: profile.sha256,
    })))
  }

  /** List durable workflows for the exact current Autopilot run generation. */
  list(parent: Agent): readonly ManagedWorkflowSnapshot[] {
    const lease = this.ctx.autonomy.get(parent)
    if (lease === undefined) return Object.freeze([])
    return this.listRun(String(parent.id), lease.id, lease.generation)
  }

  /** Return exact run-generation Workflow rows without requiring a live parent handle. */
  listRun(parentSessionId: string, runId: string, generation: number): readonly ManagedWorkflowSnapshot[] {
    return this.requireStore().list({ parentSessionId, runId, generation, includeTerminal: true })
  }

  /** Read append-only workflow history for one parent Agent. */
  history(parent: Agent): readonly import('./workflow-state.ts').ManagedWorkflowAuditRecord[] {
    return this.requireStore().history(String(parent.id))
  }

  /** Claim exact DAG tasks and run one deployment-fixed fan-out/fan-in profile. */
  async run(parent: Agent, request: ManagedWorkflowRunRequest): Promise<ManagedWorkflowSnapshot> {
    const profile = this.requireProfile(request.profileId)
    const taskIds = normalizeTaskIds(request.taskIds)
    const args = materializeArgs(request.args ?? {}, profile.maxArgsBytes)
    const preflight = await this.reconcile(parent)
    if (preflight.issues.length > 0) {
      throw new ManagedWorkflowError(
        `workflow start blocked by reconciliation: ${preflight.issues.join('; ')}`,
        'AUTOPILOT_WORKFLOW_UNCERTAIN',
      )
    }
    const before = this.requireRunningPair(parent)
    this.assertBudget(before, profile, taskIds.length)
    if (this.requireStore().list({
      parentSessionId: String(parent.id),
      runId: before.id,
      generation: before.generation,
    }).length > 0) {
      throw new ManagedWorkflowError(
        'one non-terminal managed workflow already owns this run generation',
        'AUTOPILOT_WORKFLOW_CONFLICT',
      )
    }

    const intent = prepareManagedWorkflow({
      workflowId: randomUUID(),
      parentSessionId: String(parent.id),
      runId: before.id,
      generation: before.generation,
      goalId: String(before.goalId),
      maxAuditRecords: before.maxAuditRecords,
      maxAuditBytes: before.maxAuditBytes,
      profileId: profile.id,
      profileSha256: profile.sha256,
      argsSha256: sha256(args.json),
      taskIds,
      maxTotalAgents: profile.maxTotalAgents,
      subagentsStartedBefore: before.subagentsStarted,
    }, Date.now())
    await this.requireStore().create(intent)

    const entry = activeEntry(parent, intent)
    this.active.set(intent.workflowId, entry)
    const activitySignal = this.ctx.autonomy.signal(parent)
    const signal = AbortSignal.any([request.signal, activitySignal, entry.controller.signal])
    const onAbort = (): void => {
      void this.requestCancellation(entry, errorMessage(signal.reason)).catch((error: unknown) => {
        this.ctx.logger.error(`dsh-autopilot managed-workflow cancellation failed: ${errorMessage(error)}`)
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (signal.aborted) {
        await this.requestCancellation(entry, 'managed workflow cancelled before task claim')
        return await this.finishPrestartCancellation(parent, entry)
      }
      let claimed: AutonomyLeaseView
      try {
        claimed = await this.ctx.autonomy.claimTasks(parent, taskIds)
        const additional = profile.maxTotalAgents - taskIds.length
        if (additional > 0) claimed = await this.ctx.autonomy.recordSubagentStarts(parent, additional)
      } catch (error: unknown) {
        return await this.failClaim(parent, entry, error)
      }
      let current = this.exact(intent)
      current = await this.requireStore().appendIfCurrent(
        'claim',
        current,
        claimManagedWorkflow(current, claimed.revision, Date.now()),
      )
      if (signal.aborted) {
        await this.requestCancellation(entry, 'managed workflow cancelled before engine start')
        return await this.finishPrestartCancellation(parent, entry)
      }

      let engineRun: WorkflowRun
      try {
        engineRun = request.startWorkflow({
          script: profile.script,
          meta: cloneMeta(profile.meta),
          args: Object.freeze({ taskIds, input: args.value }),
          ...(profile.subagentProvider === undefined ? {} : { subagentProvider: profile.subagentProvider }),
          maxTotalAgents: profile.maxTotalAgents,
          parent,
          signal,
        })
        entry.run = engineRun
      } catch (error: unknown) {
        return await this.failClaimedBeforeRun(parent, entry, error)
      }
      try {
        const started = startManagedWorkflow(this.exact(current), String(engineRun.id), Date.now())
        current = await this.requireStore().appendIfCurrent('start', current, started)
      } catch (error: unknown) {
        engineRun.cancel('workflow run identity could not be persisted')
        await engineRun.dispose().catch(() => undefined)
        await this.markUncertain(parent, this.latest(entry.workflowId),
          `published workflow run could not be persisted: ${errorMessage(error)}`)
        throw error
      }

      let result: WorkflowResult | undefined
      let resultError: unknown
      try {
        result = await engineRun.result
      } catch (error: unknown) {
        resultError = error
      }
      let disposeError: unknown
      try {
        await engineRun.dispose()
      } catch (error: unknown) {
        disposeError = error
      }
      if (resultError !== undefined || disposeError !== undefined) {
        const failures = [resultError, disposeError].filter(error => error !== undefined)
        const reason = failures.map(error => errorMessage(error)).join('; ')
        await this.markUncertain(parent, this.latest(entry.workflowId),
          `workflow result or cleanup violated the public seam contract: ${reason}`)
        throw failures.length === 1 ? failures[0] : new AggregateError(failures, reason)
      }
      if (entry.cancellation !== undefined) await entry.cancellation
      /* v8 ignore next -- a non-rejecting result promise assigns before this branch. */
      if (result === undefined) throw new Error('workflow settled without a result')
      return await this.settleResult(parent, entry, result)
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.active.delete(entry.workflowId)
      entry.resolveDone()
    }
  }

  /** Mark every cold non-terminal workflow uncertain; never restart scripts. */
  async reconcile(parent: Agent): Promise<ManagedWorkflowReconcileResult> {
    const workflows = this.requireStore().list({ parentSessionId: String(parent.id) })
      .filter(snapshot => !this.active.has(snapshot.workflowId))
    const issues: string[] = []
    let uncertain = 0
    for (const workflow of workflows) {
      const reason = `workflow ${workflow.workflowId} was ${workflow.phase} across a process or activation boundary`
      try {
        await this.markUncertain(parent, workflow, reason)
        uncertain += 1
        issues.push(reason)
      } catch (error: unknown) {
        issues.push(`${reason}; reconciliation failed: ${errorMessage(error)}`)
      }
    }
    return Object.freeze({ inspected: workflows.length, uncertain, issues: Object.freeze(issues) })
  }

  private async settleResult(
    parent: Agent,
    entry: ActiveManagedWorkflow,
    result: WorkflowResult,
  ): Promise<ManagedWorkflowSnapshot> {
    let current = this.latest(entry.workflowId)
    if (isManagedWorkflowTerminal(current.phase)) return current
    if (result.agentsStarted > current.maxTotalAgents) {
      const reason = `workflow engine reported ${result.agentsStarted} agents beyond reserved cap ${current.maxTotalAgents}`
      await this.markUncertain(parent, current, reason)
      throw new ManagedWorkflowError(reason, 'AUTOPILOT_WORKFLOW_UNCERTAIN')
    }
    const exactActive = this.isExactRunningPair(parent, current)
    if (!exactActive) {
      const reason = current.reason ?? result.error ?? `workflow stopped as ${result.stopReason}`
      const cancelled = finishManagedWorkflowCancel(current, reason, Date.now())
      return await this.requireStore().appendIfCurrent('finish', current, cancelled)
    }

    const settlement = settlementFor(current, result)
    current = await this.requireStore().appendIfCurrent(
      'settle',
      current,
      settleManagedWorkflow(current, settlement, Date.now()),
    )
    for (const outcome of current.outcomes) {
      try {
        await this.applyOutcome(parent, current, outcome)
        const latest = this.exact(current)
        current = await this.requireStore().appendIfCurrent(
          'task-applied',
          latest,
          applyManagedWorkflowTask(latest, outcome.taskId, Date.now()),
        )
      } catch (error: unknown) {
        const reason = `workflow task ${outcome.taskId} settlement became uncertain: ${errorMessage(error)}`
        await this.markUncertain(parent, this.latest(entry.workflowId), reason)
        throw new ManagedWorkflowError(reason, 'AUTOPILOT_WORKFLOW_UNCERTAIN')
      }
    }
    const finished = finishManagedWorkflow(current, Date.now())
    return await this.requireStore().appendIfCurrent('finish', current, finished)
  }

  private async applyOutcome(
    parent: Agent,
    workflow: ManagedWorkflowSnapshot,
    outcome: ManagedWorkflowTaskOutcome,
  ): Promise<void> {
    const lease = this.requireRunningPair(parent)
    this.assertWorkflowRun(workflow, lease)
    const task = lease.plan?.tasks.find(candidate => candidate.id === outcome.taskId)
    if (task?.status !== 'in_progress') {
      throw new ManagedWorkflowError(
        `workflow task "${outcome.taskId}" changed to ${task?.status ?? 'missing'} before settlement`,
        'AUTOPILOT_WORKFLOW_CONFLICT',
      )
    }
    if (outcome.status === 'completed') {
      await this.ctx.autonomy.updateTask(parent, outcome.taskId, 'complete', {
        evidence: outcome.evidence.map(item => ({ ...item })),
      })
    } else {
      await this.ctx.autonomy.updateTask(
        parent,
        outcome.taskId,
        outcome.status === 'blocked' ? 'block' : 'fail',
        { reason: outcome.summary },
      )
    }
  }

  private async failClaim(
    parent: Agent,
    entry: ActiveManagedWorkflow,
    error: unknown,
  ): Promise<ManagedWorkflowSnapshot> {
    const current = this.latest(entry.workflowId)
    const lease = this.ctx.autonomy.get(parent)
    const expectedUse = current.subagentsStartedBefore
    if (lease !== undefined && lease.id === current.runId && lease.generation === current.generation
      && lease.subagentsStarted === expectedUse) {
      const failed = failManagedWorkflow(current, `workflow claim rejected: ${errorMessage(error)}`, Date.now())
      await this.requireStore().appendIfCurrent('finish', current, failed)
    } else {
      await this.markUncertain(parent, current,
        `workflow claim or budget reservation may have partially committed: ${errorMessage(error)}`)
    }
    throw error
  }

  private async failClaimedBeforeRun(
    parent: Agent,
    entry: ActiveManagedWorkflow,
    error: unknown,
  ): Promise<ManagedWorkflowSnapshot> {
    const current = this.latest(entry.workflowId)
    try {
      for (const taskId of current.taskIds) {
        await this.ctx.autonomy.updateTask(parent, taskId, 'fail', {
          reason: `workflow engine rejected fixed profile: ${errorMessage(error)}`,
        })
      }
      const failed = failManagedWorkflow(current, `workflow engine start failed: ${errorMessage(error)}`, Date.now())
      await this.requireStore().appendIfCurrent('finish', current, failed)
    } catch (settlementError: unknown) {
      await this.markUncertain(parent, this.latest(entry.workflowId),
        `workflow engine start and DAG settlement failed: ${errorMessage(settlementError)}`)
    }
    throw error
  }

  private async finishPrestartCancellation(
    parent: Agent,
    entry: ActiveManagedWorkflow,
  ): Promise<ManagedWorkflowSnapshot> {
    let current = this.latest(entry.workflowId)
    const reason = current.reason ?? 'workflow cancelled before engine start'
    if (current.phase !== 'prepared' && this.isExactRunningPair(parent, current)) {
      for (const taskId of current.taskIds) {
        const task = this.ctx.autonomy.get(parent)?.plan?.tasks.find(candidate => candidate.id === taskId)
        if (task?.status === 'in_progress') {
          await this.ctx.autonomy.updateTask(parent, taskId, 'block', { reason })
        }
      }
      current = this.latest(entry.workflowId)
    }
    if (current.phase !== 'cancelling') {
      current = await this.requireStore().appendIfCurrent(
        'cancel-request',
        current,
        requestManagedWorkflowCancel(current, reason, Date.now()),
      )
    }
    return await this.requireStore().appendIfCurrent(
      'finish',
      current,
      finishManagedWorkflowCancel(current, reason, Date.now()),
    )
  }

  private requestCancellation(entry: ActiveManagedWorkflow, reason: string): Promise<void> {
    if (entry.cancellation !== undefined) return entry.cancellation
    const task = Promise.resolve().then(async () => {
      entry.controller.abort(reason)
      const failures: unknown[] = []
      try {
        await this.requireStore().reduceCurrent(entry.workflowId, current => {
          if (current === undefined || isManagedWorkflowTerminal(current.phase)
            || current.phase === 'cancelling') return undefined
          return {
            operation: 'cancel-request',
            snapshot: requestManagedWorkflowCancel(current, reason, Date.now()),
          }
        })
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        entry.run?.cancel(reason)
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        if (entry.run !== undefined) await entry.run.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
      if (failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, failures.map(error => errorMessage(error)).join('; '))
      }
    })
    entry.cancellation = task.catch(async (error: unknown) => {
      await this.markUncertain(entry.parent, this.latest(entry.workflowId),
        `workflow cancellation failed: ${errorMessage(error)}`)
      throw error
    })
    return entry.cancellation
  }

  private async cancelGeneration(
    parent: Agent,
    lease: AutonomyLeaseView,
    reason: string,
  ): Promise<void> {
    const entries = [...this.active.values()].filter(entry => entry.parent === parent
      && entry.runId === lease.id && entry.generation === lease.generation)
    await Promise.allSettled(entries.map(entry => this.requestCancellation(entry, reason)))
  }

  private async markUncertain(
    parent: Agent,
    workflow: ManagedWorkflowSnapshot,
    reason: string,
  ): Promise<void> {
    const current = this.requireStore().get(workflow.workflowId)
    if (current === undefined || isManagedWorkflowTerminal(current.phase)) return
    await this.requireStore().appendIfCurrent(
      'uncertain',
      current,
      markManagedWorkflowUncertain(current, reason, Date.now()),
    )
    const lease = this.ctx.autonomy.get(parent)
    if (lease === undefined || lease.id !== current.runId || lease.generation !== current.generation
      || (lease.phase !== 'running' && lease.phase !== 'verifying')) return
    await this.ctx.autonomy.markNeedsAttention({
      sessionId: String(parent.id),
      runId: lease.id,
      generation: lease.generation,
      revision: lease.revision,
    }, reason)
  }

  private requireRunningPair(parent: Agent): AutonomyLeaseView {
    const lease = this.ctx.autonomy.get(parent)
    const goal = this.ctx.goals.get(parent)
    if (lease === undefined || goal === undefined || String(goal.id) !== String(lease.goalId)
      || lease.activation !== 'armed' || goal.activation !== 'armed'
      || lease.phase !== 'running' || goal.phase !== 'active') {
      throw new ManagedWorkflowError(
        'managed workflow mutation requires the exact active armed Goal and Autopilot run',
        'AUTOPILOT_WORKFLOW_INVALID',
      )
    }
    return lease
  }

  private isExactRunningPair(parent: Agent, workflow: ManagedWorkflowSnapshot): boolean {
    try {
      const lease = this.requireRunningPair(parent)
      return lease.id === workflow.runId && lease.generation === workflow.generation
        && String(lease.goalId) === workflow.goalId
    } catch {
      return false
    }
  }

  private assertWorkflowRun(workflow: ManagedWorkflowSnapshot, lease: AutonomyLeaseView): void {
    if (workflow.runId !== lease.id || workflow.generation !== lease.generation
      || workflow.goalId !== String(lease.goalId)) {
      throw new ManagedWorkflowError(
        'workflow belongs to a different Autopilot run generation',
        'AUTOPILOT_WORKFLOW_CONFLICT',
      )
    }
  }

  private assertBudget(
    lease: AutonomyLeaseView,
    profile: ResolvedManagedWorkflowProfile,
    taskCount: number,
  ): void {
    const remaining = lease.maxSubagents - lease.subagentsStarted
    if (taskCount > profile.maxTotalAgents) {
      throw new ManagedWorkflowError(
        `workflow profile ${profile.id} reserves ${profile.maxTotalAgents} agents for ${taskCount} tasks`,
        'AUTOPILOT_WORKFLOW_BUDGET',
      )
    }
    if (profile.maxTotalAgents > remaining) {
      throw new ManagedWorkflowError(
        `workflow profile ${profile.id} requires ${profile.maxTotalAgents} agents; ${remaining} remain`,
        'AUTOPILOT_WORKFLOW_BUDGET',
      )
    }
    if (profile.maxTotalAgents > lease.maxConcurrentSubagents) {
      throw new ManagedWorkflowError(
        `workflow profile ${profile.id} can fan out ${profile.maxTotalAgents} agents beyond concurrency ceiling ${lease.maxConcurrentSubagents}`,
        'AUTOPILOT_WORKFLOW_BUDGET',
      )
    }
  }

  private requireProfile(profileId: string): ResolvedManagedWorkflowProfile {
    const normalized = profileId.trim()
    const profile = this.profiles.get(normalized)
    if (profile === undefined) {
      throw new ManagedWorkflowError(
        `managed workflow profile "${normalized}" is not configured`,
        'AUTOPILOT_WORKFLOW_PROFILE_MISSING',
      )
    }
    return profile
  }

  private requireStore(): DurableManagedWorkflowStore {
    if (this.store === undefined) {
      throw new ManagedWorkflowError(
        'managed workflow storage is not initialized',
        'AUTOPILOT_WORKFLOW_INVALID',
      )
    }
    return this.store
  }

  private latest(workflowId: string): ManagedWorkflowSnapshot {
    const current = this.requireStore().get(workflowId)
    if (current === undefined) {
      throw new ManagedWorkflowError(`workflow "${workflowId}" disappeared`, 'AUTOPILOT_WORKFLOW_CONFLICT')
    }
    return current
  }

  private exact(expected: ManagedWorkflowSnapshot): ManagedWorkflowSnapshot {
    const current = this.latest(expected.workflowId)
    if (current.revision !== expected.revision) {
      throw new ManagedWorkflowError(
        `workflow "${expected.workflowId}" changed during an external operation`,
        'AUTOPILOT_WORKFLOW_CONFLICT',
      )
    }
    return current
  }

  private enqueueObserver(task: () => Promise<void>): void {
    const observed = this.observerTail.then(task)
    this.observerTail = observed.catch((error: unknown) => {
      this.ctx.logger.error(`dsh-autopilot managed-workflow observer failed: ${errorMessage(error)}`)
    })
  }
}

function resolveProfiles(
  configured: readonly ManagedWorkflowProfileConfig[],
): ReadonlyMap<string, ResolvedManagedWorkflowProfile> {
  const profiles = new Map<string, ResolvedManagedWorkflowProfile>()
  for (const item of configured) {
    const id = item.id.trim()
    const description = boundedText(item.description, 'workflow profile description', 2_000)
    const script = boundedText(item.script, 'workflow profile script', MAX_WORKFLOW_PROFILE_SCRIPT_CHARS)
    if (!WORKFLOW_PROFILE_ID_PATTERN.test(id)) {
      throw new TypeError(`workflow profile id "${id}" is invalid`)
    }
    if (profiles.has(id)) throw new TypeError(`workflow profile id "${id}" is duplicated`)
    if (!Number.isSafeInteger(item.maxTotalAgents) || item.maxTotalAgents < 1) {
      throw new TypeError(`workflow profile ${id} maxTotalAgents must be a positive safe integer`)
    }
    const maxArgsBytes = item.maxArgsBytes ?? 32_768
    if (!Number.isSafeInteger(maxArgsBytes) || maxArgsBytes < 1) {
      throw new TypeError(`workflow profile ${id} maxArgsBytes must be a positive safe integer`)
    }
    const whenToUse = optionalText(item.whenToUse, 'workflow profile whenToUse', 2_000)
    const subagentProvider = optionalText(item.subagentProvider, 'workflow subagentProvider', 128)
    const phases = item.phases?.map((phase, index) => {
      const detail = optionalText(phase.detail, `workflow phase ${index + 1} detail`, 1_000)
      const provider = optionalText(phase.provider, `workflow phase ${index + 1} provider`, 128)
      const model = optionalText(phase.model, `workflow phase ${index + 1} model`, 256)
      return Object.freeze({
        title: boundedText(phase.title, `workflow phase ${index + 1} title`, 256),
        ...(detail === undefined ? {} : { detail }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
      })
    })
    if (phases !== undefined && new Set(phases.map(phase => phase.title)).size !== phases.length) {
      throw new TypeError(`workflow profile ${id} phase titles must be unique`)
    }
    const meta: WorkflowMeta = Object.freeze({
      name: id,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      ...(phases === undefined ? {} : { phases: phases.map(phase => ({ ...phase })) }),
    })
    const digestValue = JSON.stringify({
      id,
      description,
      script,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      ...(phases === undefined ? {} : { phases }),
      ...(subagentProvider === undefined ? {} : { subagentProvider }),
      maxTotalAgents: item.maxTotalAgents,
      maxArgsBytes,
    })
    profiles.set(id, Object.freeze({
      id,
      description,
      script,
      meta,
      ...(subagentProvider === undefined ? {} : { subagentProvider }),
      maxTotalAgents: item.maxTotalAgents,
      maxArgsBytes,
      sha256: sha256(digestValue),
    }))
  }
  return profiles
}

function materializeArgs(
  args: Readonly<Record<string, unknown>>,
  maxBytes: number,
): { readonly value: Readonly<Record<string, unknown>>; readonly json: string } {
  if (Array.isArray(args) || (Object.getPrototypeOf(args) !== Object.prototype
    && Object.getPrototypeOf(args) !== null)) {
    throw new ManagedWorkflowError('workflow args must be a plain JSON object', 'AUTOPILOT_WORKFLOW_INVALID')
  }
  assertJsonValue(args)
  const json = JSON.stringify(args)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new ManagedWorkflowError(
      `workflow args exceed the profile's ${maxBytes}-byte limit`,
      'AUTOPILOT_WORKFLOW_INVALID',
    )
  }
  return Object.freeze({ value: Object.freeze(JSON.parse(json) as Record<string, unknown>), json })
}

function assertJsonValue(root: unknown): void {
  const pending: unknown[] = [root]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number' && Number.isFinite(value)) continue
    if (typeof value !== 'object') {
      throw new ManagedWorkflowError('workflow args must contain only JSON values', 'AUTOPILOT_WORKFLOW_INVALID')
    }
    if (seen.has(value)) {
      throw new ManagedWorkflowError('workflow args must not contain cycles or aliases', 'AUTOPILOT_WORKFLOW_INVALID')
    }
    seen.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new ManagedWorkflowError('workflow args objects must have plain prototypes', 'AUTOPILOT_WORKFLOW_INVALID')
    }
    pending.push(...Object.values(value))
  }
}

function settlementFor(
  workflow: ManagedWorkflowSnapshot,
  result: WorkflowResult,
): {
  readonly stopReason: 'completed' | 'cancelled' | 'error'
  readonly agentsStarted: number
  readonly targetPhase: ManagedWorkflowTerminalPhase
  readonly outcomes: readonly ManagedWorkflowTaskOutcome[]
  readonly reason?: string | undefined
} {
  if (result.stopReason === 'completed') {
    try {
      const outcomes = normalizeOutcomes(result.value, workflow.taskIds)
      const failed = outcomes.filter(outcome => outcome.status !== 'completed')
      if (failed.length === 0) {
        return Object.freeze({
          stopReason: result.stopReason,
          agentsStarted: result.agentsStarted,
          targetPhase: 'completed',
          outcomes,
        })
      }
      return Object.freeze({
        stopReason: result.stopReason,
        agentsStarted: result.agentsStarted,
        targetPhase: 'partial-failure',
        outcomes,
        reason: failed.map(outcome => `${outcome.taskId}: ${outcome.summary}`).join('; ').slice(0, 8_192),
      })
    } catch (error: unknown) {
      const reason = `workflow profile returned invalid task outcomes: ${errorMessage(error)}`
      return Object.freeze({
        stopReason: 'error',
        agentsStarted: result.agentsStarted,
        targetPhase: 'error',
        outcomes: failureOutcomes(workflow.taskIds, reason, 'failed'),
        reason,
      })
    }
  }
  const reason = result.error ?? `workflow stopped as ${result.stopReason}`
  return Object.freeze({
    stopReason: result.stopReason,
    agentsStarted: result.agentsStarted,
    targetPhase: result.stopReason,
    outcomes: failureOutcomes(
      workflow.taskIds,
      reason,
      result.stopReason === 'cancelled' ? 'blocked' : 'failed',
    ),
    reason,
  })
}

function normalizeOutcomes(value: unknown, taskIds: readonly string[]): readonly ManagedWorkflowTaskOutcome[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Array.isArray((value as { outcomes?: unknown }).outcomes)) {
    throw new TypeError('result must be an object with an outcomes array')
  }
  const outcomes = (value as { outcomes: unknown[] }).outcomes.map(item => {
    const parsed = managedWorkflowTaskOutcomeSchema.parse(item)
    return Object.freeze({
      ...parsed,
      summary: parsed.summary.trim(),
      evidence: Object.freeze(parsed.evidence.map(evidence => Object.freeze({
        ...evidence,
        ref: evidence.ref.trim(),
        summary: evidence.summary.trim(),
      }))),
    })
  })
  const expected = new Set(taskIds)
  const actual = new Set(outcomes.map(outcome => outcome.taskId))
  if (actual.size !== outcomes.length || actual.size !== expected.size
    || taskIds.some(id => !actual.has(id))) {
    throw new TypeError('result outcomes must address every claimed task exactly once')
  }
  return Object.freeze(taskIds.map(id => {
    const outcome = outcomes.find(candidate => candidate.taskId === id)
    /* v8 ignore next -- exact-set validation proves every requested task exists. */
    if (outcome === undefined) throw new TypeError(`missing outcome for ${id}`)
    return outcome
  }))
}

function failureOutcomes(
  taskIds: readonly string[],
  reason: string,
  status: 'blocked' | 'failed',
): readonly ManagedWorkflowTaskOutcome[] {
  const summary = boundedText(reason, 'workflow failure summary', 8_192)
  return Object.freeze(taskIds.map(taskId => Object.freeze({
    taskId,
    status,
    summary,
    evidence: Object.freeze([]),
  })))
}

function normalizeTaskIds(taskIds: readonly string[]): readonly string[] {
  const normalized = taskIds.map(id => id.trim())
  if (normalized.length === 0 || normalized.length > 256
    || new Set(normalized).size !== normalized.length
    || normalized.some(id => !/^[a-z][a-z0-9-]{0,63}$/u.test(id))) {
    throw new ManagedWorkflowError(
      'workflow requires 1-256 unique Autopilot task ids',
      'AUTOPILOT_WORKFLOW_INVALID',
    )
  }
  return Object.freeze(normalized)
}

function cloneMeta(meta: WorkflowMeta): WorkflowMeta {
  return {
    name: meta.name,
    description: meta.description,
    ...(meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }),
    ...(meta.phases === undefined ? {} : { phases: meta.phases.map(phase => ({ ...phase })) }),
  }
}

function activeEntry(parent: Agent, workflow: ManagedWorkflowSnapshot): ActiveManagedWorkflow {
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  return {
    parent,
    workflowId: workflow.workflowId,
    runId: workflow.runId,
    generation: workflow.generation,
    controller: new AbortController(),
    done,
    /* v8 ignore next -- Promise executor runs synchronously and initializes the resolver. */
    resolveDone: () => { resolveDone?.() },
  }
}

function optionalText(value: string | undefined, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum)
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${label} must contain 1-${maximum} characters`)
  }
  return normalized
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '<unrenderable thrown value>'
  }
}

export default ManagedWorkflowService
