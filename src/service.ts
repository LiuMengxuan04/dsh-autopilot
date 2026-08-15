/** Durable Autopilot authorization, budgets, task graph, and live activity control. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import type { GoalId } from '@deepseek-ai/dsh-goal/types'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  addRunTasks,
  isRunPlanComplete,
  interruptRunTasks,
  MAX_PLAN_REVIEW_ATTEMPTS,
  readyRunTasks,
  reorderRunTasks,
  replaceRunPlan,
  MAX_COMPLETION_DELIVERY_ATTEMPTS,
  RUN_STATE_VERSION,
  RunStateError,
  updateRunTask,
} from './run-state.ts'
import type {
  AutopilotFlowState,
  AutopilotInterviewArtifact,
  AutopilotPlanReviewVerdict,
  DynamicExtensionVersion,
  PlannedTaskInput,
  RunIntent,
  RunAuditRecord,
  RunEvidence,
  RunOperation,
  RunPlan,
  RunSnapshot,
  RunTaskAction,
  VerificationBaseline,
  VerificationCandidate,
  VerificationPolicy,
  VerificationRecord,
} from './run-state.ts'
import { DurableRunStore } from './run-store.ts'
import {
  AutopilotRecovery,
  completionMessage,
  foldCompletionDelivery,
  recoveryRunRef,
} from './recovery.ts'
import type {
  CompletionDeliveryRegistration,
  RecoveryActivationResult,
  RecoveryConvergenceResult,
  RecoveryLifecycleIntent,
  RecoveryAttemptReadiness,
  RecoveryReadinessAdmission,
  RecoveryReport,
  RecoveryRun,
  RecoveryRunRef,
} from './recovery.ts'

/** Default active lease duration: seven days. */
export const DEFAULT_MAX_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000

/** Deployment ceiling for one active lease: thirty days. */
export const DEFAULT_ACTIVE_MS_CEILING = 30 * 24 * 60 * 60 * 1000

/** Default Goal round budget. */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/** Deployment ceiling for Goal rounds requested through `/autopilot`. */
export const DEFAULT_GOAL_ROUNDS_CEILING = 1024

/** Default durable task count ceiling. */
export const DEFAULT_MAX_TASKS = 256

/** Default aggregate durable task-attempt ceiling. */
export const DEFAULT_MAX_TASK_ATTEMPTS = 2048

/** Default aggregate durable evidence-record ceiling. */
export const DEFAULT_MAX_EVIDENCE_ITEMS = 4096

/** Default maximum UTF-8 bytes in one durable run snapshot. */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 512 * 1024

/** Default maximum immutable revisions in one run generation. */
export const DEFAULT_MAX_AUDIT_RECORDS = 8192

/** Default maximum aggregate UTF-8 bytes in one run's audit history. */
export const DEFAULT_MAX_AUDIT_BYTES = 256 * 1024 * 1024

/** Default aggregate character ceiling for retained dynamic Host source. */
export const DEFAULT_MAX_DYNAMIC_SOURCE_CHARS = 256 * 1024

/** Largest delay accepted reliably by Node timers. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Dynamic Cordis capability available to an autonomous run. */
export type SelfModificationMode = 'off' | 'host-only' | 'client-approved'

/** Durable lifecycle of an Autopilot run. */
export type AutonomyLeasePhase = RunSnapshot['phase']

/** Process-local authorization to execute a durable run. */
export type AutonomyActivation = 'armed' | 'disarmed'

/** Stable machine-readable autonomy failures. */
export type AutonomyErrorCode =
  | 'AUTONOMY_ALREADY_ACTIVE'
  | 'AUTONOMY_INVALID_DURATION'
  | 'AUTONOMY_INVALID_ROUNDS'
  | 'AUTONOMY_INVALID_TRANSITION'
  | 'AUTONOMY_LEASE_MISSING'
  | 'AUTONOMY_PLAN_INCOMPLETE'
  | 'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED'
  | 'AUTONOMY_VERIFICATION_EXHAUSTED'

/** Autonomy domain failure. */
export class AutonomyError extends Error {
  /** Machine-readable failure classification. */
  readonly code: AutonomyErrorCode

  /**
   * @param message - Human-readable failure.
   * @param code - Stable failure classification.
   */
  constructor(message: string, code: AutonomyErrorCode) {
    super(message)
    this.name = 'AutonomyError'
    this.code = code
  }
}

/** Deployment configuration for the autonomy service. */
export interface AutonomyServiceConfig {
  /** Goal rounds used when `/autopilot start` omits a round budget. */
  defaultMaxGoalRounds?: number
  /** Maximum Goal rounds a user may authorize through this deployment. */
  maxGoalRounds?: number
  /** Active duration used when `/autopilot start` omits a duration. */
  defaultMaxActiveMs?: number
  /** Maximum active duration a user may authorize through this deployment. */
  maxActiveMs?: number
  /** Maximum verifier attempts across the complete durable run. */
  maxVerificationAttempts?: number
  /** Maximum successful dynamic Package definitions across the complete run. */
  maxDynamicPackages?: number
  /** Maximum subagent starts across the complete run. */
  maxSubagents?: number
  /** Maximum subagents the Autopilot orchestrator may run concurrently. */
  maxConcurrentSubagents?: number
  /** Maximum tasks retained in one durable graph. */
  maxTasks?: number
  /** Maximum task-attempt records retained across one run. */
  maxTaskAttempts?: number
  /** Maximum evidence records retained across tasks and attempts. */
  maxEvidenceItems?: number
  /** Maximum UTF-8 bytes in one durable run snapshot. */
  maxSnapshotBytes?: number
  /** Maximum immutable audit revisions in one run generation. */
  maxAuditRecords?: number
  /** Maximum aggregate UTF-8 bytes in one run's audit history. */
  maxAuditBytes?: number
  /** Maximum aggregate characters retained as dynamic Host source. */
  maxDynamicSourceChars?: number
  /** Dynamic Cordis capability exposed during an active lease. */
  selfModification?: SelfModificationMode
  /** Record explicit crash-only cold-recovery authorization on newly started runs. */
  autoResume?: boolean
}

/** Fully validated deployment limits. */
export interface AutonomyLimits {
  readonly defaultMaxGoalRounds: number
  readonly maxGoalRounds: number
  readonly defaultMaxActiveMs: number
  readonly maxActiveMs: number
  readonly maxVerificationAttempts: number
  readonly maxDynamicPackages: number
  readonly maxSubagents: number
  readonly maxConcurrentSubagents: number
  readonly maxTasks: number
  readonly maxTaskAttempts: number
  readonly maxEvidenceItems: number
  readonly maxSnapshotBytes: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly maxDynamicSourceChars: number
  readonly selfModification: SelfModificationMode
  readonly autoResume: boolean
}

/** Detached current run view. */
export interface AutonomyLeaseView {
  readonly id: string
  readonly generation: number
  readonly revision: number
  readonly goalId: GoalId
  readonly phase: AutonomyLeasePhase
  readonly activation: AutonomyActivation
  readonly grantedAt: number
  readonly updatedAt: number
  readonly expiresAt?: number
  readonly remainingActiveMs: number
  readonly maxActiveMs: number
  readonly verificationAttempts: number
  readonly dynamicPackages: number
  readonly subagentsStarted: number
  readonly maxVerificationAttempts: number
  readonly maxDynamicPackages: number
  readonly maxSubagents: number
  readonly maxConcurrentSubagents: number
  readonly maxTasks: number
  readonly maxTaskAttempts: number
  readonly maxEvidenceItems: number
  readonly maxSnapshotBytes: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly maxDynamicSourceChars: number
  readonly selfModification: SelfModificationMode
  readonly autoResume: boolean
  readonly dynamicExtensions: readonly DynamicExtensionVersion[]
  readonly verificationPolicy?: VerificationPolicy
  readonly verificationBaseline?: VerificationBaseline
  readonly flow: AutopilotFlowState
  readonly plan?: RunPlan
  readonly verificationHistory: readonly VerificationRecord[]
  readonly completionReported: boolean
  readonly completionDeliveryAttempts?: number | undefined
  readonly completionDeliveryExhausted?: boolean | undefined
  readonly completionDeliveryExhaustionNotified?: boolean | undefined
  readonly reason?: string
}

/** One deterministic completion notice pending host delivery. */
export interface CompletionNotice {
  readonly id: string
  readonly runId: string
  readonly goalId: GoalId
  readonly summary: string
}

/** Completed Goal and sidecar state plus its pending user notice. */
export interface CompletionFinalization {
  readonly goal: GoalView
  readonly view: AutonomyLeaseView
  readonly notice: CompletionNotice
}

/** Request to authorize one Goal. */
export interface AutonomyStartRequest {
  readonly goalId: GoalId
  readonly maxActiveMs?: number
}

/** Source-addressed Host-only Cordis version proposed by the model. */
export interface DynamicExtensionRequest {
  readonly logicalId: string
  readonly name: string
  readonly purpose: string
  readonly hostCode: string
  readonly sourceSha256: string
}

interface RuntimeLease {
  readonly runId: string
  readonly goalId: GoalId
  readonly activity: AbortController
  timer?: NodeJS.Timeout | undefined
}

interface PendingCompletionDelivery {
  run: RecoveryRunRef
  readonly agent: Agent
  readonly session: Agent['session']
  readonly messageId: MessageId
  claimedTurn?: number | undefined
  admitted?: boolean | undefined
  assistantText?: boolean | undefined
  deliveryComplete?: boolean | undefined
  acknowledging?: Promise<void> | undefined
  retrying?: Promise<void> | undefined
  redeliveryPending?: boolean | undefined
  exhaustionNoticePending?: boolean | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autonomy: AutonomyService
  }

  interface Events {
    /**
     * A durable run mutation committed; lifecycle consumers finish before the mutation API returns.
     * @param payload.agent - Exact owning Agent.
     * @param payload.operation - Committed operation.
     * @param payload.view - Detached post-mutation state.
     * @mode parallel
     */
    'autonomy/changed'(payload: {
      agent: Agent
      operation: RunOperation
      view: AutonomyLeaseView
    }): Promise<void> | void
  }
}

/** Resolve and validate a positive safe integer. */
function positiveSafeInteger(value: number, field: string, code: AutonomyErrorCode): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AutonomyError(`${field} must be a positive safe integer`, code)
  }
  return value
}

/** Render parallel-listener aggregates with their actionable inner failures. */
function errorDetails(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(inner => errorDetails(inner))].join(': ')
  }
  return String(error)
}

/** Encode all compare-and-set identity fields for process-local delivery tracking. */
function recoveryRefKey(ref: RecoveryRunRef): string {
  return `${ref.sessionId}\u0000${ref.runId}\u0000${ref.generation}\u0000${ref.revision}`
}

/** Detach and recursively freeze completion-critical deployment policy. */
function freezeVerificationPolicyValue(policy: VerificationPolicy): VerificationPolicy {
  const freezeRoute = (route: VerificationPolicy['reviewers'][number]['primary']) => Object.freeze({
    subagentProvider: route.subagentProvider,
    ...(route.provider === undefined ? {} : { provider: route.provider }),
    ...(route.model === undefined ? {} : { model: route.model }),
  })
  return Object.freeze({
    ...policy,
    fixedChecks: Object.freeze(policy.fixedChecks.map(check => Object.freeze({ ...check }))),
    projectChecks: Object.freeze([...policy.projectChecks]),
    reviewers: Object.freeze(policy.reviewers.map(reviewer => Object.freeze({
      ...reviewer,
      primary: freezeRoute(reviewer.primary),
      fallbacks: Object.freeze(reviewer.fallbacks.map(freezeRoute)),
    }))),
  })
}

function sameVerificationPolicy(left: VerificationPolicy, right: VerificationPolicy): boolean {
  const { frozenAt: _leftFrozenAt, ...leftComparable } = left
  const { frozenAt: _rightFrozenAt, ...rightComparable } = right
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable)
}

/** Detach and recursively freeze a baseline before it enters the durable cache. */
function freezeVerificationBaselineValue(baseline: VerificationBaseline): VerificationBaseline {
  const manifests = Object.freeze(baseline.manifests.map(manifest => Object.freeze({ ...manifest })))
  if (baseline.kind === 'reviewer-only') {
    return Object.freeze({
      kind: baseline.kind,
      frozenAt: baseline.frozenAt,
      manifests,
      checks: Object.freeze([]),
      reason: baseline.reason,
    })
  }
  return Object.freeze({
    kind: baseline.kind,
    workspace: baseline.workspace,
    frozenAt: baseline.frozenAt,
    manifests,
    checks: Object.freeze(baseline.checks.map(check => Object.freeze({
      ...check,
      argv: Object.freeze([...check.argv]) as unknown as readonly [string, ...string[]],
    }))),
  })
}

function sameVerificationBaseline(left: VerificationBaseline, right: VerificationBaseline): boolean {
  const { frozenAt: _leftFrozenAt, ...leftComparable } = left
  const { frozenAt: _rightFrozenAt, ...rightComparable } = right
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable)
}

/** Freeze deployment configuration into one resolved object. */
export function resolveAutonomyLimits(config: AutonomyServiceConfig): AutonomyLimits {
  const limits: AutonomyLimits = {
    defaultMaxGoalRounds: positiveSafeInteger(
      config.defaultMaxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
      'defaultMaxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    ),
    maxGoalRounds: positiveSafeInteger(
      config.maxGoalRounds ?? DEFAULT_GOAL_ROUNDS_CEILING,
      'maxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    ),
    defaultMaxActiveMs: positiveSafeInteger(
      config.defaultMaxActiveMs ?? DEFAULT_MAX_ACTIVE_MS,
      'defaultMaxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    ),
    maxActiveMs: positiveSafeInteger(
      config.maxActiveMs ?? DEFAULT_ACTIVE_MS_CEILING,
      'maxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    ),
    maxVerificationAttempts: positiveSafeInteger(
      config.maxVerificationAttempts ?? 3,
      'maxVerificationAttempts',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxDynamicPackages: positiveSafeInteger(
      config.maxDynamicPackages ?? 8,
      'maxDynamicPackages',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxSubagents: positiveSafeInteger(
      config.maxSubagents ?? 32,
      'maxSubagents',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxConcurrentSubagents: positiveSafeInteger(
      config.maxConcurrentSubagents ?? 4,
      'maxConcurrentSubagents',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxTasks: positiveSafeInteger(
      config.maxTasks ?? DEFAULT_MAX_TASKS,
      'maxTasks',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxTaskAttempts: positiveSafeInteger(
      config.maxTaskAttempts ?? DEFAULT_MAX_TASK_ATTEMPTS,
      'maxTaskAttempts',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxEvidenceItems: positiveSafeInteger(
      config.maxEvidenceItems ?? DEFAULT_MAX_EVIDENCE_ITEMS,
      'maxEvidenceItems',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxSnapshotBytes: positiveSafeInteger(
      config.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
      'maxSnapshotBytes',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxAuditRecords: positiveSafeInteger(
      config.maxAuditRecords ?? DEFAULT_MAX_AUDIT_RECORDS,
      'maxAuditRecords',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxAuditBytes: positiveSafeInteger(
      config.maxAuditBytes ?? DEFAULT_MAX_AUDIT_BYTES,
      'maxAuditBytes',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    maxDynamicSourceChars: positiveSafeInteger(
      config.maxDynamicSourceChars ?? DEFAULT_MAX_DYNAMIC_SOURCE_CHARS,
      'maxDynamicSourceChars',
      'AUTONOMY_INVALID_TRANSITION',
    ),
    selfModification: config.selfModification ?? 'off',
    autoResume: config.autoResume ?? false,
  }
  if (limits.defaultMaxGoalRounds > limits.maxGoalRounds) {
    throw new AutonomyError(
      'defaultMaxGoalRounds must not exceed maxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    )
  }
  if (limits.defaultMaxActiveMs > limits.maxActiveMs) {
    throw new AutonomyError(
      'defaultMaxActiveMs must not exceed maxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    )
  }
  if (limits.maxConcurrentSubagents > limits.maxSubagents) {
    throw new AutonomyError(
      'maxConcurrentSubagents must not exceed maxSubagents',
      'AUTONOMY_INVALID_TRANSITION',
    )
  }
  return Object.freeze(limits)
}

/** Convert a Goal view to its compare-and-set reference. */
function goalRef(goal: GoalView): { id: GoalId; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

/** Durable run policy and process-local activation layered over DSH Goal. */
export class AutonomyService extends Service {
  static inject = ['agents', 'goals', 'sessions', 'storageDomain']

  static Config: z<AutonomyServiceConfig> = z.object({
    defaultMaxGoalRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_GOAL_ROUNDS),
    maxGoalRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_GOAL_ROUNDS_CEILING),
    defaultMaxActiveMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_ACTIVE_MS),
    maxActiveMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_ACTIVE_MS_CEILING),
    maxVerificationAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
    maxDynamicPackages: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    maxSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32),
    maxConcurrentSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4),
    maxTasks: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TASKS),
    maxTaskAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_TASK_ATTEMPTS),
    maxEvidenceItems: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_EVIDENCE_ITEMS),
    maxSnapshotBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_SNAPSHOT_BYTES),
    maxAuditRecords: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_AUDIT_RECORDS),
    maxAuditBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_AUDIT_BYTES),
    maxDynamicSourceChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_DYNAMIC_SOURCE_CHARS),
    selfModification: z.union(['off', 'host-only', 'client-approved'] as const).default('off'),
    autoResume: z.boolean().default(false),
  })

  /** Validated deployment policy used only when a human starts a new run. */
  readonly limits: AutonomyLimits

  private store?: DurableRunStore | undefined
  private recovery?: AutopilotRecovery | undefined
  private recoveryStart?: Promise<readonly RecoveryReport[]> | undefined
  private readonly recoveryIdleWaiters = new Set<() => void>()
  private readonly runtimes = new Map<Agent, RuntimeLease>()
  private readonly pendingCompletionReports = new Map<string, PendingCompletionDelivery>()
  private readonly maxTokenStops = new WeakSet<Agent>()

  /**
   * @param ctx - Cordis context that owns the service.
   * @param config - Deployment limits.
   */
  constructor(ctx: Context, config: AutonomyServiceConfig = {}) {
    super(ctx, 'autonomy')
    this.limits = resolveAutonomyLimits(config)

    ctx.on('agent/session-start', ({ agent, source }) => {
      const runtime = this.runtimes.get(agent)
      if (runtime === undefined) {
        const recovery = this.recovery
        if (recovery === undefined) return
        void agent.runMaintenance(async () => {
          const report = await recovery.recoverSession(String(agent.id))
          if (report !== undefined) this.logRecoveryReport(report)
        }).catch((error: unknown) => {
          this.ctx.logger.error(`dsh-autopilot: same-host recovery failed: ${errorDetails(error)}`)
        })
        return
      }
      if (source === 'compact' && this.continueAfterCompaction(agent, runtime)) return
      this.disarmRuntime(agent, runtime, 'session lifecycle restarted; explicit human resume is required')
      void this.pausePersistedRun(agent, 'session lifecycle restarted; explicit human resume is required')
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const runtime = this.runtimes.get(agent)
      if (runtime !== undefined) this.disarmRuntime(agent, runtime, 'Agent disposed')
    })
    ctx.on('agent/error', ({ agent, turn, error }) => {
      const pending = this.pendingCompletionReports.get(String(agent.id))
      if (pending?.agent === agent && pending.claimedTurn === turn) {
        this.retryCompletionDelivery(
          pending,
          `final-report turn ${turn} emitted agent/error: ${errorDetails(error)}`,
        )
      }
      const snapshot = this.store?.get(String(agent.id))
      if (snapshot === undefined || (snapshot.phase !== 'running' && snapshot.phase !== 'verifying')) return
      const reason = `agent loop failed: ${errorDetails(error)}`
      const runtime = this.runtimes.get(agent)
      if (runtime !== undefined) this.disarmRuntime(agent, runtime, reason)
      void this.markNeedsAttention(recoveryRunRef(snapshot), reason).catch((attentionError: unknown) => {
        this.ctx.logger.error(
          `dsh-autopilot: failed to persist agent-error needs-attention: ${errorDetails(attentionError)}`,
        )
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'running') {
        this.maxTokenStops.delete(agent)
        return
      }
      this.resumePendingCompletion(agent)
      this.reconcileIdleAgent(agent)
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const pending = this.pendingCompletionReports.get(String(agent.id))
      if (pending?.agent !== agent || pending.messageId !== message.id) return
      pending.redeliveryPending = false
      pending.claimedTurn = turn
      pending.admitted = false
      pending.assistantText = false
      pending.deliveryComplete = false
    })
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session.id)
      if (event.type === 'turn/end' && event.data.reason?.kind === 'max-tokens') {
        const agent = this.ctx.agents.get(session.id)
        if (agent?.session === session) this.maxTokenStops.add(agent)
      }
      const pending = this.pendingCompletionReports.get(sessionId)
      if (pending?.session !== session) return
      if (event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === pending.messageId)) {
        pending.redeliveryPending = false
      }
      if (pending.deliveryComplete === true) {
        this.acknowledgeCompletion(pending)
        return
      }
      if (pending.claimedTurn === undefined) return
      if (event.type === 'user/message' && event.data.id === pending.messageId) {
        pending.admitted = true
        return
      }
      if (event.type === 'assistant/message' && event.data.turn === pending.claimedTurn) {
        if (event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0)) {
          pending.assistantText = true
        }
        return
      }
      if (event.type !== 'turn/end' || event.data.turn !== pending.claimedTurn) return
      if (event.data.reason.kind === 'completed' && pending.admitted === true
        && pending.assistantText === true) {
        pending.deliveryComplete = true
        this.acknowledgeCompletion(pending)
        return
      }
      const reason = event.data.reason.kind !== 'completed'
        ? `final-report turn ${event.data.turn} ended with ${event.data.reason.kind}`
        : pending.admitted !== true
          ? `final-report turn ${event.data.turn} completed without admitting the notice`
          : `final-report turn ${event.data.turn} completed without a non-empty assistant report`
      this.retryCompletionDelivery(pending, reason)
    })
    ctx.effect(() => async () => {
      for (const [agent, runtime] of this.runtimes) {
        this.disarmRuntime(agent, runtime, 'autonomy service disposed')
        const goal = this.ctx.goals.get(agent)
        if (goal?.id === runtime.goalId && goal.activation === 'armed') {
          this.ctx.goals.disarm(agent)
        }
      }
      this.runtimes.clear()
      this.pendingCompletionReports.clear()
    })
  }

  /** Open and validate the plugin-owned DSH storage domain before consumers load. */
  protected async [Service.init](): Promise<void> {
    const store = await DurableRunStore.open(this.ctx)
    this.store = store
    this.ctx.effect(() => async () => {
      if (this.store === store) this.store = undefined
      await store.close()
    }, 'dsh-autopilot.runStoreClose')

  }

  /**
   * Start the initial cold-recovery scan after the complete Host bundle is ready.
   * Repeated calls share one scan and one same-host recovery owner.
   * @param readinessAdmission - Optional fresh-generation factory for additive bundle admission.
   * @returns Contained reports from the one cold scan.
   */
  startRecovery(readinessAdmission?: RecoveryReadinessAdmission): Promise<readonly RecoveryReport[]> {
    const active = this.recoveryStart
    if (active !== undefined) return active
    if (this.ctx.get('sessionPersistence') === undefined) {
      return Promise.reject(new Error('Autopilot cold recovery requires sessionPersistence'))
    }
    const recovery = new AutopilotRecovery(this.ctx, this, readinessAdmission)
    this.recovery = recovery
    const task = recovery.recover().then((reports) => {
      for (const report of reports) this.logRecoveryReport(report)
      return reports
    }).catch((error: unknown) => {
      this.ctx.logger.error(`dsh-autopilot: cold recovery scan failed: ${String(error)}`)
      return Object.freeze([])
    })
    this.recoveryStart = task
    void task.then(() => {
      for (const resolve of this.recoveryIdleWaiters) resolve()
      this.recoveryIdleWaiters.clear()
    })
    this.ctx.effect(() => async () => {
      await task
      if (this.recovery === recovery) this.recovery = undefined
      await recovery.dispose()
    }, 'dsh-autopilot.coldRecovery')
    return task
  }

  /**
   * Wait until the explicitly started initial cold-recovery scan settles.
   * Calling this before {@link startRecovery} waits for a later explicit start.
   * @returns A barrier that also settles after a contained scan failure.
   */
  whenRecoveryIdle(): Promise<void> {
    const active = this.recoveryStart
    if (active !== undefined) return active.then(() => {})
    return new Promise((resolve) => { this.recoveryIdleWaiters.add(resolve) })
  }

  /** Expose recovery attention/failure instead of silently dropping scan reports. */
  private logRecoveryReport(report: import('./recovery.ts').RecoveryReport): void {
    if (report.outcome !== 'needs-attention' && report.outcome !== 'failed') return
    const sessionId = 'sessionId' in report ? report.sessionId : report.run.sessionId
    this.ctx.logger.error(`dsh-autopilot: recovery ${report.outcome} for ${sessionId}: ${report.reason}`)
  }

  /** Fail closed when the native Goal driver stops without settling the active sidecar. */
  private reconcileIdleAgent(agent: Agent): void {
    const snapshot = this.store?.get(String(agent.id))
    if (snapshot === undefined || (snapshot.phase !== 'running' && snapshot.phase !== 'verifying')) return
    const runtime = this.runtimes.get(agent)
    const goal = this.ctx.goals.get(agent)
    const runtimeMatches = runtime?.runId === snapshot.runId && String(runtime.goalId) === snapshot.goalId
    const goalMatches = goal !== undefined && String(goal.id) === snapshot.goalId
    if (runtimeMatches && goalMatches && goal.phase === 'active' && goal.activation === 'armed') return

    const maxTokens = this.maxTokenStops.has(agent)
    if (maxTokens && snapshot.phase === 'running' && runtime !== undefined && runtimeMatches && goalMatches
      && goal.phase === 'active' && goal.activation === 'disarmed'
      && goal.roundsStarted < goal.maxGoalRounds) {
      this.maxTokenStops.delete(agent)
      try {
        const resumed = this.ctx.goals.resume(agent, goalRef(goal))
        const authoritative = this.requireStore().get(snapshot.sessionId)
        const liveGoal = this.ctx.goals.get(agent)
        const liveRuntime = this.runtimes.get(agent)
        if (!this.matchesRecoveryRef(authoritative, recoveryRunRef(snapshot))
          || liveRuntime !== runtime || liveGoal?.id !== resumed.id
          || liveGoal.revision !== resumed.revision || liveGoal.phase !== 'active'
          || liveGoal.activation !== 'armed') {
          throw new Error('the run or Goal changed while rearming the max-tokens continuation')
        }
        return
      } catch (error: unknown) {
        const reason = `max-tokens Goal continuation failed: ${errorDetails(error)}`
        this.disarmRuntime(agent, runtime, reason)
        const liveGoal = this.ctx.goals.get(agent)
        if (String(liveGoal?.id) === snapshot.goalId && liveGoal?.activation === 'armed') {
          this.ctx.goals.disarm(agent)
        }
        void this.markNeedsAttention(recoveryRunRef(snapshot), reason).catch((attentionError: unknown) => {
          this.ctx.logger.error(
            `dsh-autopilot: failed to persist max-tokens continuation needs-attention: ${errorDetails(attentionError)}`,
          )
        })
        return
      }
    }
    const reason = maxTokens && goalMatches && goal.phase === 'active'
      && goal.roundsStarted >= goal.maxGoalRounds
      ? 'agent became idle after a max-tokens turn with the native Goal round budget exhausted'
      : maxTokens
        ? 'agent became idle after a max-tokens turn; the native Goal driver disarmed before Autopilot completed'
        : 'agent became idle after its native Goal silently disarmed or diverged from the active Autopilot runtime'
    if (runtime !== undefined) this.disarmRuntime(agent, runtime, reason)
    if (goalMatches && goal.activation === 'armed') this.ctx.goals.disarm(agent)
    void this.markNeedsAttention(recoveryRunRef(snapshot), reason).catch((error: unknown) => {
      this.ctx.logger.error(
        `dsh-autopilot: failed to persist idle-agent needs-attention: ${errorDetails(error)}`,
      )
    })
  }

  /**
   * Read the current durable run plus process-local activation.
   * @param agent - Exact live Agent.
   * @returns Current run, or `undefined` before authorization.
   */
  get(agent: Agent): AutonomyLeaseView | undefined {
    const snapshot = this.requireStore().get(String(agent.id))
    return snapshot === undefined ? undefined : this.view(agent, snapshot)
  }

  /** Read immutable append-only audit records for one Agent. */
  history(agent: Agent): readonly RunAuditRecord[] {
    return this.requireStore().history(String(agent.id))
  }

  /** Return one latest sidecar row per session for the cold-recovery scanner. */
  currentRuns(): readonly RecoveryRun[] {
    return Object.freeze(this.requireStore().currentRuns().map(snapshot => Object.freeze({
      runId: snapshot.runId,
      generation: snapshot.generation,
      revision: snapshot.revision,
      sessionId: snapshot.sessionId,
      goalId: snapshot.goalId,
      phase: snapshot.phase,
      autoResume: snapshot.autoResume,
      ...(snapshot.finalization === undefined ? {} : { finalization: snapshot.finalization }),
      completionReported: snapshot.completionReported,
    })))
  }

  /** Return complete current snapshots for trusted read-only Host diagnostics. */
  currentSnapshots(): readonly RunSnapshot[] {
    return this.requireStore().currentRuns()
  }

  /**
   * Disarm every active generation and atomically move its latest durable row to needs-attention.
   * @param reason - Actionable bundle-readiness failure shared by the affected runs.
   */
  async failRecoveryReadiness(reason: string): Promise<void> {
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0) {
      throw new AutonomyError('bundle-readiness failure reason must not be empty', 'AUTONOMY_INVALID_TRANSITION')
    }
    const store = this.requireStore()
    const candidates = store.currentRuns().filter(snapshot => snapshot.phase === 'running'
      || snapshot.phase === 'verifying')
    const disarm = (snapshot: RunSnapshot): Agent | undefined => {
      const agent = this.ctx.agents.get(SessionId(snapshot.sessionId))
      if (agent === undefined) return undefined
      const runtime = this.runtimes.get(agent)
      if (runtime?.runId === snapshot.runId) this.disarmRuntime(agent, runtime, normalizedReason)
      const goal = this.ctx.goals.get(agent)
      if (String(goal?.id) === snapshot.goalId && goal?.activation === 'armed') this.ctx.goals.disarm(agent)
      agent.cancel(
        { kind: 'hook', reason: 'dsh-autopilot bundle readiness lost' },
        { keepInbox: true },
      )
      return agent
    }
    for (const snapshot of candidates) disarm(snapshot)
    const results = await Promise.allSettled(candidates.map(async (candidate) => {
      this.pendingCompletionReports.delete(candidate.sessionId)
      const stored = await store.reduceCurrent(candidate.sessionId, (latest) => {
        if (latest === undefined || latest.runId !== candidate.runId
          || latest.generation !== candidate.generation
          || (latest.phase !== 'running' && latest.phase !== 'verifying')) return undefined
        return {
          operation: 'needs-attention',
          snapshot: this.mutate(latest, {
            phase: 'needs-attention',
            remainingActiveMs: this.remaining(latest),
            ...(latest.plan === undefined
              ? {}
              : { plan: interruptRunTasks(latest.plan, Date.now(), normalizedReason).plan }),
            reason: normalizedReason,
            clearExpiresAt: true,
            clearCandidate: true,
            clearFinalization: true,
          }),
        }
      })
      if (stored === undefined) return
      const agent = disarm(stored)
      if (agent !== undefined) await this.publishChanged(agent, 'needs-attention', stored)
    }))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'could not fail closed after bundle readiness was lost')
    }
  }

  /** Settle one durable command/run whose command/done never reached storage. */
  async settleInterruptedLifecycle(
    expected: RecoveryRunRef,
    agent: Agent,
    intent: RecoveryLifecycleIntent,
  ): Promise<RecoveryConvergenceResult> {
    if (String(agent.id) !== expected.sessionId) {
      throw new AutonomyError('lifecycle recovery Agent does not own the expected session', 'AUTONOMY_INVALID_TRANSITION')
    }
    const initial = this.requireStore().get(expected.sessionId)
    if (!this.isSameRecoveryRun(initial, expected)) {
      return { kind: 'superseded', reason: 'the durable run changed before lifecycle recovery' }
    }
    if (intent.command.kind === 'start') {
      return { kind: 'superseded', reason: 'an existing run already materialized the interrupted start' }
    }
    const goal = this.ctx.goals.get(agent)
    if (intent.command.kind === 'stop' && initial.phase === 'revoked' && goal === undefined) {
      return { kind: 'settled', run: recoveryRunRef(initial) }
    }
    if (goal === undefined || String(goal.id) !== initial.goalId) {
      const reason = 'interrupted lifecycle command does not match the live Goal'
      await this.markNeedsAttention(recoveryRunRef(initial), reason)
      return { kind: 'needs-attention', reason }
    }

    if (intent.command.kind === 'resume') {
      if (initial.phase === 'finalizing') {
        const finalized = await this.finalizeCompletion(agent, goalRef(goal))
        return { kind: 'settled', run: {
          runId: finalized.view.id,
          generation: finalized.view.generation,
          revision: finalized.view.revision,
          sessionId: expected.sessionId,
        } }
      }
      // A running row means the interrupted command may already have persisted
      // its duration grant. Rearm that materialized grant without applying the
      // command's optional extension a second time.
      const resumed = await this.resume(
        agent,
        goal.id,
        initial.phase === 'running' ? undefined : intent.command.maxActiveMs,
      )
      const currentGoal = this.ctx.goals.get(agent)
      if (currentGoal === undefined || currentGoal.id !== goal.id) {
        const reason = 'Goal disappeared while interrupted resume was settling'
        await this.markNeedsAttention({
          runId: resumed.id,
          generation: resumed.generation,
          revision: resumed.revision,
          sessionId: expected.sessionId,
        }, reason)
        return { kind: 'needs-attention', reason }
      }
      if (currentGoal.activation === 'disarmed') this.ctx.goals.resume(agent, goalRef(currentGoal))
      await this.requireDurableSession(agent)
      return { kind: 'recovered', run: {
        runId: resumed.id,
        generation: resumed.generation,
        revision: resumed.revision,
        sessionId: expected.sessionId,
      } }
    }

    const runtime = this.runtimes.get(agent)
    if (runtime !== undefined) this.disarmRuntime(agent, runtime, `interrupted ${intent.command.kind} recovered`)
    if (goal.activation === 'armed') this.ctx.goals.disarm(agent)
    const view = intent.command.kind === 'pause'
      ? initial.phase === 'paused' || initial.phase === 'exhausted'
        ? this.view(agent, initial)
        : await this.pause(agent, 'paused by interrupted human command')
      : initial.phase === 'revoked'
        ? this.view(agent, initial)
        : await this.revoke(agent, 'stopped by interrupted human command')
    const stoppedGoal = this.ctx.goals.get(agent)
    if (stoppedGoal !== undefined && stoppedGoal.id === goal.id && stoppedGoal.phase !== 'complete') {
      if (intent.command.kind === 'stop') this.ctx.goals.clear(agent, goalRef(stoppedGoal))
      else if (stoppedGoal.phase === 'active') this.ctx.goals.pause(agent, goalRef(stoppedGoal))
    } else {
      // The Goal-side command already settled or a concurrent owner replaced it.
    }
    await this.requireDurableSession(agent)
    return { kind: 'settled', run: {
      runId: view.id,
      generation: view.generation,
      revision: view.revision,
      sessionId: expected.sessionId,
    } }
  }

  /** Finish a Goal pause/block after its sidecar already reached a safe phase. */
  async convergeSafetyState(
    expected: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
  ): Promise<RecoveryConvergenceResult> {
    const current = this.requireStore().get(expected.sessionId)
    if (!this.isSameRecoveryRun(current, expected)
      || (current.phase !== 'paused' && current.phase !== 'revoked'
        && current.phase !== 'exhausted' && current.phase !== 'needs-attention')) {
      return { kind: 'superseded', reason: 'the safe sidecar changed before Goal convergence' }
    }
    const live = this.ctx.goals.get(agent)
    if (live === undefined || live.id !== goal.id || live.revision !== goal.revision
      || String(live.id) !== current.goalId
      || (current.phase === 'revoked'
        ? live.phase === 'complete'
        : live.phase !== 'active')) {
      return { kind: 'needs-attention', reason: 'the live Goal changed before safety convergence' }
    }
    if (live.activation === 'armed') this.ctx.goals.disarm(agent)
    if (current.phase === 'revoked') {
      this.ctx.goals.clear(agent, goal)
    } else if (current.phase === 'needs-attention') {
      this.ctx.goals.block(agent, goal, {
        code: 'autopilot-needs-attention',
        message: current.reason ?? 'Autopilot requires human reconciliation',
      })
    } else {
      this.ctx.goals.pause(agent, goal)
    }
    await this.requireDurableSession(agent)
    return { kind: 'settled', run: recoveryRunRef(current) }
  }

  /** Finish the Goal completion that precedes an already-completed sidecar. */
  async convergeCompletedGoal(
    expected: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
  ): Promise<RecoveryConvergenceResult> {
    const current = this.requireStore().get(expected.sessionId)
    if (!this.isSameRecoveryRun(current, expected) || current.phase !== 'completed') {
      return { kind: 'superseded', reason: 'the completed sidecar changed before Goal convergence' }
    }
    const live = this.ctx.goals.get(agent)
    if (live === undefined || live.id !== goal.id || live.revision !== goal.revision
      || String(live.id) !== current.goalId || live.phase !== 'active') {
      return { kind: 'needs-attention', reason: 'the live Goal changed before completion convergence' }
    }
    this.ctx.goals.complete(agent, goal)
    await this.requireDurableSession(agent)
    return { kind: 'settled', run: recoveryRunRef(current) }
  }

  /** Auditably return crash-interrupted task attempts to retryable pending state. */
  async recoverInterruptedTasks(
    expected: RecoveryRunRef,
    agent: Agent,
    reason: string,
  ): Promise<import('./recovery.ts').RecoveryTaskResult> {
    if (String(agent.id) !== expected.sessionId) {
      throw new AutonomyError('task recovery Agent does not own the expected session', 'AUTONOMY_INVALID_TRANSITION')
    }
    const store = this.requireStore()
    const current = store.get(expected.sessionId)
    if (!this.matchesRecoveryRef(current, expected)) {
      return { kind: 'superseded', reason: 'the durable run changed before task recovery' }
    }
    if (current.plan === undefined) return { kind: 'unchanged', run: expected }
    const recovered = interruptRunTasks(current.plan, Date.now(), reason)
    if (recovered.taskIds.length === 0) return { kind: 'unchanged', run: expected }
    const next = this.mutate(current, { plan: recovered.plan })
    const stored = await store.appendIfCurrent('task-interrupt', expected, next)
    if (stored === undefined) {
      return { kind: 'superseded', reason: 'the durable run changed during task recovery' }
    }
    await this.publishChanged(agent, 'task-interrupt', stored)
    return {
      kind: 'recovered',
      run: recoveryRunRef(stored),
      taskIds: recovered.taskIds,
    }
  }

  /** Converge one exact finalizing run and expose its pending completion notice. */
  async finalizeRecovered(
    expected: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
  ): Promise<import('./recovery.ts').RecoveryFinalizationResult> {
    if (String(agent.id) !== expected.sessionId) {
      throw new AutonomyError('finalization Agent does not own the expected session', 'AUTONOMY_INVALID_TRANSITION')
    }
    const current = this.requireStore().get(expected.sessionId)
    if (!this.matchesRecoveryRef(current, expected) || current.phase !== 'finalizing') {
      return { kind: 'superseded', reason: 'the durable finalization changed before recovery' }
    }
    try {
      const result = await this.finalizeCompletion(agent, goal)
      return {
        kind: 'finalized',
        run: {
          runId: result.view.id,
          generation: result.view.generation,
          revision: result.view.revision,
          sessionId: String(agent.id),
        },
        notice: result.notice,
      }
    } catch (error: unknown) {
      const after = this.requireStore().get(expected.sessionId)
      if (after?.phase === 'needs-attention') {
        return {
          kind: 'needs-attention',
          /* v8 ignore next -- needs-attention writes always require a non-empty reason. */
          reason: after.reason ?? String(error),
        }
      }
      if (!this.matchesRecoveryRef(after, expected)) {
        return { kind: 'superseded', reason: 'the durable finalization changed during recovery' }
      }
      throw error
    }
  }

  /**
   * Rearm one crash-disarmed run using an exact sidecar and Goal reference.
   * Concurrent pause/revoke wins through the store's serialized revision CAS.
   */
  async activateRecovered(
    expected: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
    readiness?: RecoveryAttemptReadiness,
  ): Promise<RecoveryActivationResult> {
    if (String(agent.id) !== expected.sessionId) {
      throw new AutonomyError('recovery Agent does not own the expected session', 'AUTONOMY_INVALID_TRANSITION')
    }
    const store = this.requireStore()
    const current = store.get(expected.sessionId)
    if (!this.matchesRecoveryRef(current, expected)) {
      return { kind: 'superseded', reason: 'the durable run changed before recovery activation' }
    }
    if (!current.autoResume || (current.phase !== 'running' && current.phase !== 'verifying')) {
      return { kind: 'superseded', reason: 'the run is no longer authorized for automatic recovery' }
    }
    const rejectReadiness = async (stage: string): Promise<RecoveryActivationResult | undefined> => {
      if (readiness === undefined) return undefined
      try {
        readiness.assertCurrent()
        return undefined
      } catch (error: unknown) {
        const reason = `bundle readiness changed ${stage}: ${errorDetails(error)}`
        await this.failRecoveryReadiness(reason)
        return { kind: 'needs-attention', reason }
      }
    }
    const beforeActivation = await rejectReadiness('before recovery activation')
    if (beforeActivation !== undefined) return beforeActivation
    if (current.goalId !== String(goal.id)) {
      const reason = `recovery Goal "${goal.id}" does not match sidecar Goal "${current.goalId}"`
      await this.markNeedsAttention(expected, reason)
      return { kind: 'needs-attention', reason }
    }
    if (this.isArmed(agent, current)) {
      const liveGoal = this.ctx.goals.get(agent)
      if (liveGoal === undefined || liveGoal.id !== goal.id || liveGoal.revision !== goal.revision
        || liveGoal.phase !== 'active') {
        const reason = 'the live Goal changed before recovery could confirm the armed run'
        await this.markNeedsAttention(expected, reason)
        return { kind: 'needs-attention', reason }
      }
      if (liveGoal.activation === 'disarmed') {
        try {
          this.ctx.goals.resume(agent, goal)
        } catch (error: unknown) {
          const reason = `Goal rearm failed while confirming the armed run: ${String(error)}`
          await this.markNeedsAttention(expected, reason)
          return { kind: 'needs-attention', reason }
        }
      }
      const afterConfirmedGoal = await rejectReadiness('while confirming the recovered Goal')
      if (afterConfirmedGoal !== undefined) return afterConfirmedGoal
      return { kind: 'recovered' }
    }

    const remaining = this.remaining(current)
    if (remaining < 1) {
      const reason = 'the active-time budget expired before cold recovery'
      await this.markNeedsAttention(expected, reason)
      return { kind: 'needs-attention', reason }
    }
    const now = Date.now()
    const next = this.mutate(current, {
      phase: 'running',
      remainingActiveMs: remaining,
      expiresAt: now + remaining,
      clearReason: true,
      clearCandidate: true,
      at: now,
    })
    const stored = await store.appendIfCurrent('resume', expected, next)
    if (stored === undefined) {
      return { kind: 'superseded', reason: 'the durable run changed during recovery activation' }
    }
    const goalCheckpoint = this.ctx.goals.get(agent)
    await this.publishChanged(agent, 'resume', stored)
    const activatedRef = recoveryRunRef(stored)
    const authoritative = store.get(stored.sessionId)
    if (!this.matchesRecoveryRef(authoritative, activatedRef) || authoritative.phase !== 'running') {
      this.disarmAfterRearmRace(agent, stored, authoritative, 'recovery observers changed the durable run')
      if (this.isSameRunAttention(authoritative, activatedRef)) {
        return {
          kind: 'needs-attention',
          reason: authoritative!.reason!,
        }
      }
      return { kind: 'superseded', reason: 'the durable run changed during recovery observers' }
    }
    const afterSidecar = await rejectReadiness('after sidecar recovery activation')
    if (afterSidecar !== undefined) return afterSidecar
    const liveGoal = this.ctx.goals.get(agent)
    if (goalCheckpoint === undefined || goalCheckpoint.id !== goal.id
      || goalCheckpoint.revision !== goal.revision || goalCheckpoint.phase !== 'active'
      || !this.matchesGoalCheckpoint(liveGoal, goalCheckpoint, stored.goalId)) {
      const reason = 'the live Goal changed during recovery observers before runtime rearm'
      await this.markNeedsAttention(activatedRef, reason)
      return { kind: 'needs-attention', reason }
    }
    this.armRuntime(agent, authoritative)
    try {
      if (liveGoal.activation === 'disarmed') this.ctx.goals.resume(agent, goalRef(liveGoal))
    } catch (error: unknown) {
      const runtime = this.runtimes.get(agent)
      if (runtime !== undefined) this.disarmRuntime(agent, runtime, 'cold-recovery Goal rearm failed')
      const reason = `Goal rearm failed after sidecar activation: ${String(error)}`
      try {
        await this.markNeedsAttention(activatedRef, reason)
      } catch (attentionError: unknown) {
        throw new AggregateError(
          [error, attentionError],
          'Goal rearm and needs-attention persistence both failed',
        )
      }
      return { kind: 'needs-attention', reason }
    }
    const afterGoal = await rejectReadiness('after recovered Goal rearm')
    if (afterGoal !== undefined) return afterGoal
    return { kind: 'recovered' }
  }

  /** Persist a fail-closed recovery state using an exact expected sidecar revision. */
  async markNeedsAttention(expected: RecoveryRunRef, reason: string): Promise<void> {
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0) {
      throw new AutonomyError('needs-attention reason must not be empty', 'AUTONOMY_INVALID_TRANSITION')
    }
    const store = this.requireStore()
    const current = store.get(expected.sessionId)
    if (!this.isSameRecoveryRun(current, expected)) {
      throw new AutonomyError('cannot mark a stale recovery run needs-attention', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (current.phase === 'needs-attention') return
    const agent = this.ctx.agents.get(SessionId(expected.sessionId))
    if (agent !== undefined) {
      const runtime = this.runtimes.get(agent)
      if (runtime !== undefined) this.disarmRuntime(agent, runtime, normalizedReason)
      const liveGoal = this.ctx.goals.get(agent)
      if (liveGoal?.id === current.goalId && liveGoal.activation === 'armed') this.ctx.goals.disarm(agent)
    }
    this.pendingCompletionReports.delete(expected.sessionId)
    let converged = false
    const stored = await store.reduceCurrent(expected.sessionId, (latest) => {
      if (this.isSameRunAttention(latest, expected)) {
        converged = true
        return undefined
      }
      if (!this.isSameRecoveryRun(latest, expected)) {
        throw new AutonomyError('cannot mark a stale recovery run needs-attention', 'AUTONOMY_INVALID_TRANSITION')
      }
      if (latest.phase === 'revoked' || latest.phase === 'completed') {
        converged = true
        return undefined
      }
      return {
        operation: 'needs-attention',
        snapshot: this.mutate(latest, {
          phase: 'needs-attention',
          remainingActiveMs: this.remaining(latest),
          ...(latest.plan === undefined
            ? {}
            : { plan: interruptRunTasks(latest.plan, Date.now(), normalizedReason).plan }),
          reason: normalizedReason,
          clearExpiresAt: true,
          clearCandidate: true,
          clearFinalization: true,
        }),
      }
    })
    if (stored === undefined) {
      if (converged) return
      throw new AutonomyError('needs-attention mutation did not commit', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (agent !== undefined) await this.publishChanged(agent, 'needs-attention', stored)
  }

  /** Authorize one new Goal and durably materialize all run budgets. */
  async start(agent: Agent, request: AutonomyStartRequest): Promise<AutonomyLeaseView> {
    const current = this.requireStore().get(String(agent.id))
    if (current !== undefined && current.phase !== 'completed' && current.phase !== 'revoked') {
      throw new AutonomyError('an Autopilot run is already present; pause, resume, or stop it', 'AUTONOMY_ALREADY_ACTIVE')
    }
    const duration = this.resolveDuration(request.maxActiveMs)
    const now = Date.now()
    const snapshot: RunSnapshot = Object.freeze({
      version: RUN_STATE_VERSION,
      runId: `run-${randomUUID()}`,
      generation: (current?.generation ?? 0) + 1,
      revision: 1,
      sessionId: String(agent.id),
      goalId: String(request.goalId),
      phase: 'running',
      autoResume: this.limits.autoResume,
      grantedAt: now,
      updatedAt: now,
      expiresAt: now + duration,
      remainingActiveMs: duration,
      maxActiveMs: duration,
      selfModification: this.limits.selfModification,
      budgets: Object.freeze({
        maxVerificationAttempts: this.limits.maxVerificationAttempts,
        maxDynamicPackages: this.limits.maxDynamicPackages,
        maxSubagents: this.limits.maxSubagents,
        maxConcurrentSubagents: this.limits.maxConcurrentSubagents,
        maxTasks: this.limits.maxTasks,
        maxTaskAttempts: this.limits.maxTaskAttempts,
        maxEvidenceItems: this.limits.maxEvidenceItems,
        maxSnapshotBytes: this.limits.maxSnapshotBytes,
        maxAuditRecords: this.limits.maxAuditRecords,
        maxAuditBytes: this.limits.maxAuditBytes,
        maxDynamicSourceChars: this.limits.maxDynamicSourceChars,
      }),
      usage: Object.freeze({ verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 0 }),
      dynamicExtensions: Object.freeze([]),
      verificationHistory: Object.freeze([]),
      flow: Object.freeze({
        revision: 1,
        stage: 'interview',
        cycle: 1,
        planReviewAttempts: 0,
        updatedAt: now,
      }),
      completionReported: false,
      completionDeliveryAttempts: 0,
      completionDeliveryExhausted: false,
      completionDeliveryExhaustionNotified: false,
    })
    this.pendingCompletionReports.delete(String(agent.id))
    const goalCheckpoint = this.ctx.goals.get(agent)
    await this.commit(agent, 'start', snapshot)
    const authoritative = this.requireStore().get(snapshot.sessionId)
    const liveGoal = this.ctx.goals.get(agent)
    if (!this.matchesRecoveryRef(authoritative, recoveryRunRef(snapshot)) || authoritative.phase !== 'running'
      || !this.matchesGoalCheckpoint(liveGoal, goalCheckpoint, snapshot.goalId)) {
      const reason = 'the run or Goal changed during start observers before runtime activation'
      this.disarmAfterRearmRace(agent, snapshot, authoritative, reason)
      if (this.matchesRecoveryRef(authoritative, recoveryRunRef(snapshot))) {
        await this.markNeedsAttention(recoveryRunRef(snapshot), reason)
      }
      throw new AutonomyError(reason, 'AUTONOMY_INVALID_TRANSITION')
    }
    this.armRuntime(agent, authoritative)
    return this.view(agent, authoritative)
  }

  /**
   * Freeze completion-critical deployment configuration before model work.
   * A resumed process with a different policy is moved to needs-attention
   * rather than permitting a weaker verifier to replace the durable policy.
   */
  async freezeVerificationPolicy(
    agent: Agent,
    policy: VerificationPolicy,
  ): Promise<AutonomyLeaseView> {
    const proposed = freezeVerificationPolicyValue(policy)
    const store = this.requireStore()
    for (;;) {
      const current = store.get(String(agent.id))
      if (current === undefined) {
        throw new AutonomyError('Autopilot run is missing', 'AUTONOMY_LEASE_MISSING')
      }
      if (current.verificationPolicy !== undefined) {
        if (!sameVerificationPolicy(current.verificationPolicy, proposed)) {
          const reason = 'verification policy drift: frozen deployment fingerprint '
            + `${current.verificationPolicy.sha256} does not match ${proposed.sha256}`
          await this.markNeedsAttention(recoveryRunRef(current), reason)
          throw new AutonomyError(reason, 'AUTONOMY_INVALID_TRANSITION')
        }
        return this.view(agent, current)
      }
      if (current.phase !== 'running' || !this.isArmed(agent, current)) {
        throw this.transitionError(agent, current, 'freeze verification policy')
      }
      const next = this.mutate(current, { verificationPolicy: proposed })
      const stored = await store.appendIfCurrent('verification-policy', current, next)
      if (stored === undefined) continue
      await this.publishChanged(agent, 'verification-policy', stored)
      return this.view(agent, stored)
    }
  }

  /**
   * Freeze the project verification decision using a durable revision compare-and-set.
   * Concurrent first-step preparation converges on one identical baseline; a different
   * winner is rejected instead of silently rediscovering project checks.
   */
  async freezeVerificationBaseline(
    agent: Agent,
    baseline: VerificationBaseline,
  ): Promise<AutonomyLeaseView> {
    const proposed = freezeVerificationBaselineValue(baseline)
    const store = this.requireStore()
    for (;;) {
      const current = store.get(String(agent.id))
      if (current === undefined) {
        throw new AutonomyError('Autopilot run is missing', 'AUTONOMY_LEASE_MISSING')
      }
      if (current.verificationBaseline !== undefined) {
        if (!sameVerificationBaseline(current.verificationBaseline, proposed)) {
          throw new AutonomyError(
            'the verification baseline was already frozen from different project state',
            'AUTONOMY_INVALID_TRANSITION',
          )
        }
        return this.view(agent, current)
      }
      if (current.phase !== 'running' || !this.isArmed(agent, current)) {
        throw this.transitionError(agent, current, 'freeze verification baseline')
      }
      const next = this.mutate(current, { verificationBaseline: proposed })
      const stored = await store.appendIfCurrent('verification-baseline', current, next)
      if (stored === undefined) continue
      await this.publishChanged(agent, 'verification-baseline', stored)
      return this.view(agent, stored)
    }
  }

  /** Pause an active run without resetting any run-lifetime budget. */
  async pause(agent: Agent, reason?: string): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase !== 'running' && snapshot.phase !== 'verifying') {
      throw this.transitionError(agent, snapshot, 'pause')
    }
    const runtime = this.runtimes.get(agent)
    if (runtime !== undefined) this.disarmRuntime(agent, runtime, reason ?? 'Autopilot paused')
    const pauseReason = reason ?? 'paused by user'
    let operation: RunOperation = 'pause'
    const stored = await this.requireStore().reduceCurrent(String(agent.id), (latest) => {
      if (latest === undefined || latest.runId !== snapshot.runId || latest.generation !== snapshot.generation) {
        throw new AutonomyError('the Autopilot run changed before pause committed', 'AUTONOMY_INVALID_TRANSITION')
      }
      if (latest.phase !== 'running' && latest.phase !== 'verifying') {
        throw this.transitionError(agent, latest, 'pause')
      }
      const remainingActiveMs = this.remaining(latest)
      operation = remainingActiveMs > 0 ? 'pause' : 'expire'
      return {
        operation,
        snapshot: this.mutate(latest, {
          phase: remainingActiveMs > 0 ? 'paused' : 'exhausted',
          remainingActiveMs,
          ...(latest.plan === undefined
            ? {}
            : { plan: interruptRunTasks(latest.plan, Date.now(), pauseReason).plan }),
          reason: pauseReason,
          clearExpiresAt: true,
          clearCandidate: latest.phase === 'verifying',
        }),
      }
    })
    /* v8 ignore next -- a validated active snapshot always produces a mutation or throws. */
    if (stored === undefined) throw new Error('pause mutation did not commit')
    await this.publishChanged(agent, operation, stored)
    return this.view(agent, stored)
  }

  /** Resume a paused or crash-disarmed run while preserving every durable counter. */
  async resume(agent: Agent, goalId: GoalId, maxActiveMs?: number): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.goalId !== goalId) {
      throw new AutonomyError('the Autopilot run belongs to a different Goal', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (snapshot.phase === 'finalizing') {
      const goal = this.ctx.goals.get(agent)
      if (goal === undefined || goal.id !== goalId) {
        throw new AutonomyError('the finalizing Goal is unavailable', 'AUTONOMY_INVALID_TRANSITION')
      }
      return (await this.finalizeCompletion(agent, goalRef(goal))).view
    }
    if (this.isArmed(agent, snapshot)) throw this.transitionError(agent, snapshot, 'resume')
    if (snapshot.phase === 'completed' || snapshot.phase === 'revoked') {
      throw this.transitionError(agent, snapshot, 'resume')
    }
    const requested = maxActiveMs === undefined ? undefined : this.resolveDuration(maxActiveMs)
    if (requested !== undefined && requested > this.limits.maxActiveMs - snapshot.maxActiveMs) {
      throw new AutonomyError(
        `active-time extension ${requested} exceeds the remaining deployment allowance `
        + `${this.limits.maxActiveMs - snapshot.maxActiveMs}`,
        'AUTONOMY_INVALID_DURATION',
      )
    }
    const remaining = snapshot.expiresAt === undefined ? snapshot.remainingActiveMs : this.remaining(snapshot)
    const duration = requested ?? remaining
    if (duration < 1) {
      throw new AutonomyError(
        'the active-time budget is exhausted; a human must resume with an explicit --duration extension',
        'AUTONOMY_INVALID_DURATION',
      )
    }
    const now = Date.now()
    const next = this.mutate(snapshot, {
      phase: 'running',
      remainingActiveMs: duration,
      expiresAt: now + duration,
      maxActiveMs: requested === undefined ? snapshot.maxActiveMs : snapshot.maxActiveMs + requested,
      clearReason: true,
      clearCandidate: true,
    })
    const stored = await this.requireStore().appendIfCurrent('resume', snapshot, next)
    if (stored === undefined) {
      throw new AutonomyError(
        'the Autopilot run changed before resume committed',
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    const goalCheckpoint = this.ctx.goals.get(agent)
    await this.publishChanged(agent, 'resume', stored)
    const resumedRef = recoveryRunRef(stored)
    const authoritative = this.requireStore().get(stored.sessionId)
    const liveGoal = this.ctx.goals.get(agent)
    if (!this.matchesRecoveryRef(authoritative, resumedRef) || authoritative.phase !== 'running'
      || !this.matchesGoalCheckpoint(liveGoal, goalCheckpoint, stored.goalId)) {
      const reason = 'the run or Goal changed during resume observers before runtime rearm'
      this.disarmAfterRearmRace(agent, stored, authoritative, reason)
      if (this.matchesRecoveryRef(authoritative, resumedRef)) {
        await this.markNeedsAttention(resumedRef, reason)
      }
      throw new AutonomyError(reason, 'AUTONOMY_INVALID_TRANSITION')
    }
    this.armRuntime(agent, authoritative)
    return this.view(agent, authoritative)
  }

  /** Revoke a non-terminal run without deleting its audit history. */
  async revoke(agent: Agent, reason?: string): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase === 'completed' || snapshot.phase === 'finalizing' || snapshot.phase === 'revoked') {
      throw this.transitionError(agent, snapshot, 'revoke')
    }
    const runtime = this.runtimes.get(agent)
    if (runtime !== undefined) this.disarmRuntime(agent, runtime, reason ?? 'Autopilot revoked')
    const revokeReason = reason ?? 'revoked by user'
    const stored = await this.requireStore().reduceCurrent(String(agent.id), (latest) => {
      if (latest === undefined || latest.runId !== snapshot.runId || latest.generation !== snapshot.generation) {
        throw new AutonomyError('the Autopilot run changed before revoke committed', 'AUTONOMY_INVALID_TRANSITION')
      }
      if (latest.phase === 'completed' || latest.phase === 'finalizing' || latest.phase === 'revoked') {
        throw this.transitionError(agent, latest, 'revoke')
      }
      return {
        operation: 'revoke',
        snapshot: this.mutate(latest, {
          phase: 'revoked',
          remainingActiveMs: this.remaining(latest),
          ...(latest.plan === undefined
            ? {}
            : { plan: interruptRunTasks(latest.plan, Date.now(), revokeReason, 'failed').plan }),
          reason: revokeReason,
          clearExpiresAt: true,
          clearCandidate: true,
        }),
      }
    })
    /* v8 ignore next -- a validated non-terminal snapshot always produces a mutation or throws. */
    if (stored === undefined) throw new Error('revoke mutation did not commit')
    await this.publishChanged(agent, 'revoke', stored)
    return this.view(agent, stored)
  }

  /** Persist the canonical objective interview before planning begins. */
  async recordInterview(
    agent: Agent,
    input: Omit<AutopilotInterviewArtifact, 'recordedAt'>,
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'record canonical interview')
    const flow = snapshot.flow
    if (flow.stage !== 'interview') {
      throw new AutonomyError('canonical interview is already complete', 'AUTONOMY_INVALID_TRANSITION')
    }
    const summary = input.summary.trim()
    const decisions = input.decisions.map(value => value.trim()).filter(value => value.length > 0)
    const openQuestions = input.openQuestions.map(value => value.trim()).filter(value => value.length > 0)
    if (summary.length === 0 || decisions.length === 0) {
      throw new AutonomyError(
        'canonical interview requires a summary and at least one decision',
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    const now = Date.now()
    const interview: AutopilotInterviewArtifact = Object.freeze({
      summary,
      decisions: Object.freeze(decisions),
      openQuestions: Object.freeze(openQuestions),
      recordedAt: now,
    })
    const next = this.mutate(snapshot, {
      flow: Object.freeze({
        ...flow,
        revision: flow.revision + 1,
        stage: 'planning',
        updatedAt: now,
        interview,
      }),
      at: now,
    })
    await this.commit(agent, 'flow', next)
    return this.view(agent, next)
  }

  /** Reserve one exact plan revision for the fixed Metis, Momus, and Oracle review. */
  async beginPlanReview(agent: Agent): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'begin plan review')
    const flow = snapshot.flow
    if (flow.stage !== 'planning' && flow.stage !== 'plan-review') {
      throw new AutonomyError('plan review requires canonical planning', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (snapshot.plan === undefined) {
      throw new AutonomyError('plan review requires a durable task plan', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (flow.stage === 'plan-review') return this.view(agent, snapshot)
    const now = Date.now()
    const next = this.mutate(snapshot, {
      flow: Object.freeze({
        ...flow,
        revision: flow.revision + 1,
        stage: 'plan-review',
        updatedAt: now,
      }),
      at: now,
    })
    await this.commit(agent, 'flow', next)
    return this.view(agent, next)
  }

  /** Settle the fixed plan-hardening quorum and open execution only on unanimous advice. */
  async settlePlanReview(
    agent: Agent,
    planRevision: number,
    reviewers: readonly AutopilotPlanReviewVerdict[],
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'settle plan review')
    const flow = snapshot.flow
    if (flow.stage !== 'plan-review' || snapshot.plan?.revision !== planRevision) {
      throw new AutonomyError('plan review no longer matches the current plan revision', 'AUTONOMY_INVALID_TRANSITION')
    }
    const roles = ['metis', 'momus', 'oracle'] as const
    if (reviewers.length !== roles.length
      || reviewers.some((reviewer, index) => reviewer.role !== roles[index])) {
      throw new AutonomyError('plan review requires ordered Metis, Momus, and Oracle verdicts', 'AUTONOMY_INVALID_TRANSITION')
    }
    const normalized = reviewers.map((reviewer): AutopilotPlanReviewVerdict => Object.freeze({
      ...reviewer,
      summary: reviewer.summary.trim(),
      findings: Object.freeze(reviewer.findings.map(value => value.trim()).filter(value => value.length > 0)),
      recommendations: Object.freeze(
        reviewer.recommendations.map(value => value.trim()).filter(value => value.length > 0),
      ),
    }))
    if (normalized.some(reviewer => reviewer.summary.length === 0)) {
      throw new AutonomyError('plan-review summaries must not be empty', 'AUTONOMY_INVALID_TRANSITION')
    }
    const passed = normalized.every(reviewer => reviewer.verdict === 'advice')
    const planReviewAttempts = flow.planReviewAttempts + 1
    const exhausted = !passed && planReviewAttempts >= MAX_PLAN_REVIEW_ATTEMPTS
    const now = Date.now()
    const reason = exhausted
      ? `canonical plan review did not converge after ${MAX_PLAN_REVIEW_ATTEMPTS} attempts`
      : 'canonical plan review requires revision'
    if (exhausted) {
      const runtime = this.runtimes.get(agent)!
      this.disarmRuntime(agent, runtime, reason)
      const goal = this.ctx.goals.get(agent)
      if (String(goal?.id) === snapshot.goalId && goal?.activation === 'armed') this.ctx.goals.disarm(agent)
    }
    const next = this.mutate(snapshot, {
      ...(exhausted
        ? {
            phase: 'needs-attention' as const,
            remainingActiveMs: this.remaining(snapshot),
            clearExpiresAt: true,
          }
        : {}),
      flow: Object.freeze({
        ...flow,
        revision: flow.revision + 1,
        stage: passed ? 'execution' : 'planning',
        cycle: passed || exhausted ? flow.cycle : flow.cycle + 1,
        planReviewAttempts,
        updatedAt: now,
        planReview: Object.freeze({
          cycle: flow.cycle,
          planRevision,
          passed,
          reviewers: Object.freeze(normalized),
          recordedAt: now,
        }),
      }),
      ...(passed ? { clearReason: true } : { reason }),
      at: now,
    })
    await this.commit(agent, exhausted ? 'needs-attention' : 'flow', next)
    return this.view(agent, next)
  }

  /** Advance a verified implementation from independent code review into deterministic QA. */
  async beginQualityAssurance(agent: Agent): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    const flow = snapshot.flow
    if (snapshot.phase !== 'verifying' || flow.stage !== 'code-review') {
      throw this.transitionError(agent, snapshot, 'begin canonical QA')
    }
    const now = Date.now()
    const next = this.mutate(snapshot, {
      flow: Object.freeze({
        ...flow,
        revision: flow.revision + 1,
        stage: 'qa',
        updatedAt: now,
      }),
      at: now,
    })
    await this.commit(agent, 'flow', next)
    return this.view(agent, next)
  }

  /** Create or replace a dependency graph before any current task starts. */
  async setPlan(
    agent: Agent,
    acceptanceCriteria: readonly string[],
    tasks: readonly PlannedTaskInput[],
    intent: RunIntent = 'implementation',
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'set plan')
    const now = Date.now()
    const plan = replaceRunPlan(snapshot.plan, acceptanceCriteria, tasks, now, intent)
    if (snapshot.flow.stage !== 'planning') {
      throw new AutonomyError('complete the canonical interview before creating a plan', 'AUTONOMY_INVALID_TRANSITION')
    }
    const next = this.mutate(snapshot, { plan, at: now, clearReason: true })
    await this.commit(agent, 'plan', next)
    return this.view(agent, next)
  }

  /** Append new pending tasks to the durable graph. */
  async addTasks(agent: Agent, tasks: readonly PlannedTaskInput[]): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'add tasks')
    if (snapshot.plan === undefined) {
      throw new RunStateError('set the initial plan before adding tasks', 'RUN_PLAN_INVALID')
    }
    if (snapshot.flow.stage !== 'planning' && snapshot.flow.stage !== 'execution') {
      throw new AutonomyError('tasks may be added only during planning or execution repair', 'AUTONOMY_INVALID_TRANSITION')
    }
    const now = Date.now()
    const plan = addRunTasks(snapshot.plan, tasks, now)
    const flow = snapshot.flow
    const next = this.mutate(snapshot, {
      plan,
      ...(flow.stage === 'execution'
        ? {
            flow: Object.freeze({
              ...flow,
              revision: flow.revision + 1,
              stage: 'planning' as const,
              cycle: flow.cycle + 1,
              planReviewAttempts: 0,
              updatedAt: now,
            }),
          }
        : {}),
      at: now,
    })
    await this.commit(agent, 'plan', next)
    return this.view(agent, next)
  }

  /** Reorder every task without changing dependency semantics. */
  async reorderTasks(agent: Agent, order: readonly string[]): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'reorder tasks')
    if (snapshot.plan === undefined) {
      throw new RunStateError('set the initial plan before reordering tasks', 'RUN_PLAN_INVALID')
    }
    if (snapshot.flow.stage !== 'planning') {
      throw new AutonomyError('task order may change only during canonical planning', 'AUTONOMY_INVALID_TRANSITION')
    }
    const now = Date.now()
    const next = this.mutate(snapshot, { plan: reorderRunTasks(snapshot.plan, order, now), at: now })
    await this.commit(agent, 'plan', next)
    return this.view(agent, next)
  }

  /** Apply one task transition and its evidence or blocker. */
  async updateTask(
    agent: Agent,
    taskId: string,
    action: RunTaskAction,
    options: { readonly evidence?: readonly RunEvidence[]; readonly reason?: string } = {},
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, `${action} task`)
    if (snapshot.plan === undefined) throw new RunStateError('the run has no task plan', 'RUN_PLAN_INVALID')
    if (snapshot.flow.stage !== 'execution') {
      throw new AutonomyError('task execution requires a passing canonical plan review', 'AUTONOMY_INVALID_TRANSITION')
    }
    const now = Date.now()
    const next = this.mutate(snapshot, {
      plan: updateRunTask(snapshot.plan, taskId, action, now, options),
      at: now,
    })
    await this.commit(agent, 'task', next)
    return this.view(agent, next)
  }

  /** Return dependency-ready tasks in stable plan order. */
  readyTasks(agent: Agent): readonly RunPlan['tasks'][number][] {
    const plan = this.requireSnapshot(agent).plan
    return plan === undefined ? [] : readyRunTasks(plan)
  }

  /** Atomically claim dependency-ready tasks and their subagent budget. */
  async claimTasks(agent: Agent, taskIds: readonly string[]): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'claim tasks')
    if (snapshot.plan === undefined) throw new RunStateError('the run has no task plan', 'RUN_PLAN_INVALID')
    if (snapshot.flow.stage !== 'execution') {
      throw new AutonomyError('task delegation requires a passing canonical plan review', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) {
      throw new RunStateError('task claims require one or more unique task ids', 'RUN_PLAN_INVALID')
    }
    const count = taskIds.length
    if (count > snapshot.budgets.maxConcurrentSubagents) {
      throw new AutonomyError(
        `task batch ${count} exceeds per-dispatch ceiling ${snapshot.budgets.maxConcurrentSubagents}`,
        'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
      )
    }
    if (snapshot.usage.subagentsStarted + count > snapshot.budgets.maxSubagents) {
      throw new AutonomyError(
        `subagent budget exhausted (${snapshot.budgets.maxSubagents})`,
        'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
      )
    }
    const now = Date.now()
    let plan = snapshot.plan
    for (const taskId of taskIds) plan = updateRunTask(plan, taskId, 'start', now)
    const next = this.mutate(snapshot, {
      plan,
      usage: Object.freeze({
        ...snapshot.usage,
        subagentsStarted: snapshot.usage.subagentsStarted + count,
      }),
      at: now,
    })
    await this.commit(agent, 'subagent', next)
    return this.view(agent, next)
  }

  /** Atomically reserve run-lifetime subagent budget before dispatch. */
  async recordSubagentStarts(agent: Agent, count: number): Promise<AutonomyLeaseView> {
    const snapshot = this.requireActive(agent, 'start subagents')
    const safeCount = positiveSafeInteger(count, 'subagent count', 'AUTONOMY_INVALID_TRANSITION')
    if (snapshot.usage.subagentsStarted + safeCount > snapshot.budgets.maxSubagents) {
      throw new AutonomyError(
        `subagent budget exhausted (${snapshot.budgets.maxSubagents})`,
        'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
      )
    }
    const next = this.mutate(snapshot, {
      usage: Object.freeze({ ...snapshot.usage, subagentsStarted: snapshot.usage.subagentsStarted + safeCount }),
    })
    await this.commit(agent, 'subagent', next)
    return this.view(agent, next)
  }

  /** Enter independent verification after the complete task graph has evidence. */
  async beginVerification(
    agent: Agent,
    candidate: Omit<VerificationCandidate, 'submittedAt'>,
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'begin verification')
    if (!isRunPlanComplete(snapshot.plan)) {
      throw new AutonomyError(
        'every planned task must be completed with evidence before verification',
        'AUTONOMY_PLAN_INCOMPLETE',
      )
    }
    if (snapshot.usage.verificationAttempts >= snapshot.budgets.maxVerificationAttempts) {
      throw new AutonomyError(
        `verification attempt budget exhausted (${snapshot.budgets.maxVerificationAttempts})`,
        'AUTONOMY_VERIFICATION_EXHAUSTED',
      )
    }
    if (snapshot.flow.stage !== 'execution') {
      throw new AutonomyError('verification requires the canonical execution stage', 'AUTONOMY_INVALID_TRANSITION')
    }
    const submittedAt = Date.now()
    const next = this.mutate(snapshot, {
      phase: 'verifying',
      flow: Object.freeze({
        ...snapshot.flow,
        revision: snapshot.flow.revision + 1,
        stage: 'code-review',
        updatedAt: submittedAt,
      }),
      candidate: Object.freeze({ ...candidate, submittedAt }),
      usage: Object.freeze({
        ...snapshot.usage,
        verificationAttempts: snapshot.usage.verificationAttempts + 1,
      }),
      at: submittedAt,
      clearReason: true,
    })
    await this.commit(agent, 'verification-start', next)
    return this.view(agent, next)
  }

  /** Return a failed or inconclusive verifier result to normal work. */
  async verificationFailed(agent: Agent, record: VerificationRecord): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase !== 'verifying') throw this.transitionError(agent, snapshot, 'settle failed verification')
    if (record.verdict !== 'fail' && record.verdict !== 'inconclusive') {
      throw new AutonomyError('verificationFailed requires a fail or inconclusive record', 'AUTONOMY_INVALID_TRANSITION')
    }
    const next = this.mutate(snapshot, {
      phase: 'running',
      flow: Object.freeze({
        ...snapshot.flow,
        revision: snapshot.flow.revision + 1,
        stage: 'execution' as const,
        updatedAt: Math.max(record.finishedAt, snapshot.flow.updatedAt),
      }),
      verificationHistory: Object.freeze([...snapshot.verificationHistory, record]),
      reason: record.summary,
      clearCandidate: true,
      at: record.finishedAt,
    })
    await this.commit(agent, 'verification-fail', next)
    return this.view(agent, next)
  }

  /** Pause after verifier infrastructure error while retaining its audit record. */
  async verificationErrored(agent: Agent, record: VerificationRecord): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase !== 'verifying') throw this.transitionError(agent, snapshot, 'settle verifier error')
    const runtime = this.runtimes.get(agent)
    if (runtime !== undefined) this.disarmRuntime(agent, runtime, record.summary)
    const stored = await this.requireStore().reduceCurrent(String(agent.id), (latest) => {
      if (latest === undefined || latest.runId !== snapshot.runId || latest.generation !== snapshot.generation
        || latest.phase !== 'verifying') {
        throw new AutonomyError(
          'the Autopilot run changed before verifier error could be persisted',
          'AUTONOMY_INVALID_TRANSITION',
        )
      }
      return {
        operation: 'verification-error',
        snapshot: this.mutate(latest, {
          phase: 'paused',
          remainingActiveMs: this.remaining(latest),
          verificationHistory: Object.freeze([...latest.verificationHistory, record]),
          reason: record.summary,
          clearCandidate: true,
          clearExpiresAt: true,
          at: record.finishedAt,
        }),
      }
    })
    /* v8 ignore next -- the reducer either returns a mutation or throws. */
    if (stored === undefined) throw new Error('verification-error mutation did not commit')
    await this.publishChanged(agent, 'verification-error', stored)
    return this.view(agent, stored)
  }

  /** Durably reserve a passing verification before either completion write. */
  async beginFinalization(agent: Agent, record: VerificationRecord): Promise<AutonomyLeaseView> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase !== 'verifying') throw this.transitionError(agent, snapshot, 'begin finalization')
    if (record.verdict !== 'pass') {
      throw new AutonomyError('finalization requires a passing verification record', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (record.attempt !== snapshot.usage.verificationAttempts) {
      throw new AutonomyError('finalization record does not match the current attempt', 'AUTONOMY_INVALID_TRANSITION')
    }
    const runtime = this.runtimes.get(agent)
    if (runtime !== undefined) this.disarmRuntime(agent, runtime, 'Autopilot finalization started')
    const next = this.mutate(snapshot, {
      phase: 'finalizing',
      ...(snapshot.flow.stage === 'code-review'
        ? {
            flow: Object.freeze({
              ...snapshot.flow,
              revision: snapshot.flow.revision + 1,
              stage: 'qa' as const,
              updatedAt: Math.max(record.finishedAt, snapshot.flow.updatedAt),
            }),
          }
        : {}),
      remainingActiveMs: this.remaining(snapshot),
      finalization: Object.freeze(record),
      clearCandidate: true,
      clearExpiresAt: true,
      clearReason: true,
      at: record.finishedAt,
    })
    try {
      const stored = await this.requireStore().appendIfCurrent('finalization-start', snapshot, next)
      if (stored === undefined) {
        throw new AutonomyError(
          'the Autopilot run changed before finalization could be reserved',
          'AUTONOMY_INVALID_TRANSITION',
        )
      }
      await this.publishChanged(agent, 'finalization-start', stored)
    } catch (error: unknown) {
      const failedGoal = this.ctx.goals.get(agent)
      /* v8 ignore else -- only the matching armed Goal has authorization left to disarm. */
      if (failedGoal?.id === snapshot.goalId && failedGoal.activation === 'armed') this.ctx.goals.disarm(agent)
      throw error
    }
    const goal = this.ctx.goals.get(agent)
    if (goal?.id === snapshot.goalId && goal.activation === 'armed') this.ctx.goals.disarm(agent)
    return this.view(agent, next)
  }

  /** Complete the exact Goal and converge a reserved passing run to completed. */
  async finalizeCompletion(agent: Agent, expectedGoal: GoalRef): Promise<CompletionFinalization> {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase !== 'finalizing' || snapshot.finalization?.verdict !== 'pass') {
      throw this.transitionError(agent, snapshot, 'finalize completion')
    }
    let goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.id !== expectedGoal.id || goal.id !== snapshot.goalId
      || goal.revision !== expectedGoal.revision
      || (goal.phase !== 'active' && goal.phase !== 'complete')) {
      const reason = 'Goal changed while durable completion finalization was pending'
      await this.markNeedsAttention(recoveryRunRef(snapshot), reason)
      throw new AutonomyError(reason, 'AUTONOMY_INVALID_TRANSITION')
    }
    if (goal.phase === 'active') goal = this.ctx.goals.complete(agent, expectedGoal)
    const next = this.mutate(snapshot, {
      phase: 'completed',
      flow: Object.freeze({
        ...snapshot.flow,
        revision: snapshot.flow.revision + 1,
        stage: 'completed' as const,
        updatedAt: Date.now(),
      }),
      verificationHistory: Object.freeze([...snapshot.verificationHistory, snapshot.finalization]),
      completionReported: false,
      completionDeliveryAttempts: 0,
      completionDeliveryExhausted: false,
      completionDeliveryExhaustionNotified: false,
      clearFinalization: true,
      clearReason: true,
      at: Date.now(),
    })
    const stored = await this.requireStore().appendIfCurrent('finalization-complete', snapshot, next)
    if (stored === undefined) {
      const current = this.requireStore().get(String(agent.id))
      if (current?.phase !== 'needs-attention') {
        const reason = 'sidecar changed after Goal completion but before finalization committed'
        /* v8 ignore next -- the append-only store cannot lose a row after the finalizing snapshot was read. */
        await this.markNeedsAttention(recoveryRunRef(current ?? snapshot), reason)
      }
      throw new AutonomyError(
        'sidecar changed while durable completion finalization was pending',
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    await this.publishChanged(agent, 'finalization-complete', stored)
    return Object.freeze({ goal, view: this.view(agent, stored), notice: this.notice(stored) })
  }

  /** Register one deterministic completion followup and its exact answering turn. */
  async registerCompletionDelivery(
    expected: RecoveryRunRef,
    agent: Agent,
    messageId: MessageId,
  ): Promise<CompletionDeliveryRegistration> {
    if (String(agent.id) !== expected.sessionId) {
      throw new AutonomyError('completion delivery Agent does not own the expected session', 'AUTONOMY_INVALID_TRANSITION')
    }
    const snapshot = this.requireStore().get(expected.sessionId)
    if (!this.matchesRecoveryRef(snapshot, expected)
      || snapshot.phase !== 'completed' || snapshot.completionReported) {
      throw new AutonomyError('completion delivery no longer matches a pending run', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (snapshot.completionDeliveryExhausted === true) {
      const pending: PendingCompletionDelivery = {
        run: recoveryRunRef(snapshot),
        agent,
        session: agent.session,
        messageId,
        exhaustionNoticePending: snapshot.completionDeliveryExhaustionNotified !== true,
      }
      this.pendingCompletionReports.set(expected.sessionId, pending)
      try {
        pending.run = recoveryRunRef(await this.ensureCompletionExhaustionNotice(pending.run, agent))
        pending.exhaustionNoticePending = false
        this.pendingCompletionReports.delete(expected.sessionId)
      } catch (error: unknown) {
        this.ctx.logger.error(
          `dsh-autopilot: failed to expose exhausted completion delivery in the Host: ${errorDetails(error)}`,
        )
      }
      this.ctx.logger.error(
        `dsh-autopilot: completion report delivery is exhausted for session ${JSON.stringify(expected.sessionId)}; ${snapshot.reason!}`,
      )
      throw new AutonomyError('completion delivery retries are exhausted', 'AUTONOMY_INVALID_TRANSITION')
    }
    const observed = foldCompletionDelivery(agent.session.events, messageId)
    if (observed.kind === 'answered') {
      if (!await this.ctx.sessions.flush(agent.session)) {
        throw new Error('completion acknowledgement requires configured session persistence')
      }
      await this.markCompletionReported(expected)
      return 'reported'
    }
    this.pendingCompletionReports.set(expected.sessionId, {
      run: recoveryRunRef(snapshot),
      agent,
      session: agent.session,
      messageId,
      redeliveryPending: observed.kind === 'absent' || observed.kind === 'pending',
      ...(observed.kind === 'claimed'
        ? { claimedTurn: observed.turn, admitted: observed.admitted, assistantText: false }
        : {}),
    })
    return 'registered'
  }

  /** Read the pending completion notice without acknowledging host delivery. */
  async completionNotice(expected: RecoveryRunRef): Promise<CompletionNotice | undefined> {
    const store = this.requireStore()
    const snapshot = store.get(expected.sessionId)
    if (!this.matchesRecoveryRef(snapshot, expected)) {
      throw new AutonomyError('cannot read notice for a stale run', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (snapshot.phase !== 'completed' || snapshot.completionReported) return undefined
    const record = snapshot.verificationHistory.at(-1)
    if (record?.verdict !== 'pass') {
      throw new AutonomyError('completed run has no passing verification record', 'AUTONOMY_INVALID_TRANSITION')
    }
    return this.notice(snapshot)
  }

  /** Acknowledge completion feedback only after the host durably exposes it. */
  async markCompletionReported(expected: RecoveryRunRef): Promise<void> {
    const store = this.requireStore()
    let converged: RunSnapshot | undefined
    const stored = await store.reduceCurrent(expected.sessionId, (latest) => {
      if (latest !== undefined && latest.runId === expected.runId
        && latest.generation === expected.generation && latest.phase === 'completed'
        && latest.completionReported) {
        converged = latest
        return undefined
      }
      if (!this.matchesRecoveryRef(latest, expected)) {
        throw new AutonomyError('cannot report completion for a stale run', 'AUTONOMY_INVALID_TRANSITION')
      }
      if (latest.phase !== 'completed' || latest.completionReported) {
        throw new AutonomyError('the completion notice is not pending', 'AUTONOMY_INVALID_TRANSITION')
      }
      return {
        operation: 'completion-reported',
        snapshot: this.mutate(latest, { completionReported: true, clearReason: true }),
      }
    })
    const completed = stored ?? converged
    /* v8 ignore next -- the reducer either commits, converges, or throws. */
    if (completed === undefined) throw new Error('completion acknowledgement did not converge')
    const pending = this.pendingCompletionReports.get(completed.sessionId)
    if (pending !== undefined && recoveryRefKey(pending.run) === recoveryRefKey(expected)) {
      this.pendingCompletionReports.delete(completed.sessionId)
    }
    if (stored === undefined) return
    const agent = this.ctx.agents.get(SessionId(stored.sessionId))
    if (agent !== undefined) await this.publishChanged(agent, 'completion-reported', stored)
  }

  /** Flush the exact answering turn before moving the sidecar outbox marker. */
  private acknowledgeCompletion(pending: PendingCompletionDelivery): void {
    if (pending.acknowledging !== undefined) return
    const task = (async () => {
      if (!await this.ctx.sessions.flush(pending.session)) {
        throw new Error('completion acknowledgement requires configured session persistence')
      }
      await this.markCompletionReported(pending.run)
    })()
    pending.acknowledging = task
    void task.catch((error: unknown) => {
      pending.acknowledging = undefined
      this.ctx.logger.error(`dsh-autopilot: failed to acknowledge completion feedback: ${errorDetails(error)}`)
    })
  }

  /** Persist one failed report turn before enqueueing the same deterministic notice again. */
  private retryCompletionDelivery(pending: PendingCompletionDelivery, reason: string): void {
    if (pending.claimedTurn === undefined || pending.retrying !== undefined) return
    pending.claimedTurn = undefined
    pending.admitted = false
    pending.assistantText = false
    pending.deliveryComplete = false
    const task = this.persistCompletionDeliveryFailure(pending, reason)
    pending.retrying = task
    void task.catch((error: unknown) => {
      this.ctx.logger.error(
        `dsh-autopilot: completion report delivery stalled while recording a failed turn: ${errorDetails(error)}`,
      )
    }).finally(() => { pending.retrying = undefined })
  }

  /** Retry a failed enqueue or terminal Host notice when the owning Agent next becomes idle. */
  private resumePendingCompletion(agent: Agent): void {
    const pending = this.pendingCompletionReports.get(String(agent.id))
    if (pending?.agent !== agent || pending.retrying !== undefined) return
    if (pending.exhaustionNoticePending === true) {
      const task = (async () => {
        pending.run = recoveryRunRef(await this.ensureCompletionExhaustionNotice(pending.run, agent))
        pending.exhaustionNoticePending = false
        this.pendingCompletionReports.delete(String(agent.id))
      })()
      pending.retrying = task
      void task.catch((error: unknown) => {
        this.ctx.logger.error(
          `dsh-autopilot: failed to expose exhausted completion delivery in the Host: ${errorDetails(error)}`,
        )
      }).finally(() => { pending.retrying = undefined })
      return
    }
    if (pending.redeliveryPending !== true) return
    try {
      this.enqueueCompletionDelivery(pending)
    } catch (error: unknown) {
      this.ctx.logger.error(`dsh-autopilot: completion report requeue failed: ${errorDetails(error)}`)
    }
  }

  /** Queue the deterministic report notice unless it is already pending. */
  private enqueueCompletionDelivery(pending: PendingCompletionDelivery): void {
    const snapshot = this.requireStore().get(pending.run.sessionId)
    if (!this.matchesRecoveryRef(snapshot, pending.run)
      || snapshot.phase !== 'completed' || snapshot.completionReported
      || snapshot.completionDeliveryExhausted === true) {
      this.pendingCompletionReports.delete(pending.run.sessionId)
      return
    }
    if (pending.agent.inbox.nextTurn.some(message => message.id === pending.messageId)
      || pending.agent.inbox.nextStep.some(message => message.id === pending.messageId)) {
      pending.redeliveryPending = false
      return
    }
    pending.redeliveryPending = true
    pending.agent.followup(completionMessage(this.notice(snapshot)))
    pending.redeliveryPending = false
  }

  /** Commit a delivery attempt and wake the Agent only while the durable outbox remains retryable. */
  private async persistCompletionDeliveryFailure(
    pending: PendingCompletionDelivery,
    reason: string,
  ): Promise<void> {
    const store = this.requireStore()
    const stored = await store.reduceCurrent(pending.run.sessionId, (latest) => {
      if (!this.matchesRecoveryRef(latest, pending.run)
        || latest.phase !== 'completed' || latest.completionReported
        || latest.completionDeliveryExhausted === true) {
        throw new AutonomyError('completion delivery failure no longer matches a pending run', 'AUTONOMY_INVALID_TRANSITION')
      }
      const attempts = (latest.completionDeliveryAttempts ?? 0) + 1
      return {
        operation: 'completion-delivery-failed',
        snapshot: this.mutate(latest, {
          completionDeliveryAttempts: attempts,
          completionDeliveryExhausted: attempts === MAX_COMPLETION_DELIVERY_ATTEMPTS,
          reason,
        }),
      }
    })
    /* v8 ignore next -- the exact reducer either commits or throws. */
    if (stored === undefined) throw new Error('completion delivery failure did not commit')
    pending.run = recoveryRunRef(stored)
    await this.publishChanged(pending.agent, 'completion-delivery-failed', stored)

    const authoritative = store.get(pending.run.sessionId)
    if (!this.matchesRecoveryRef(authoritative, pending.run)
      || authoritative.phase !== 'completed' || authoritative.completionReported) {
      this.pendingCompletionReports.delete(pending.run.sessionId)
      return
    }
    if (authoritative.completionDeliveryExhausted === true) {
      this.ctx.logger.error(
        `dsh-autopilot: completion report delivery exhausted after ${MAX_COMPLETION_DELIVERY_ATTEMPTS} attempts for session ${JSON.stringify(pending.run.sessionId)}; ${reason}`,
      )
      pending.exhaustionNoticePending = true
      pending.run = recoveryRunRef(await this.ensureCompletionExhaustionNotice(pending.run, pending.agent))
      pending.exhaustionNoticePending = false
      this.pendingCompletionReports.delete(pending.run.sessionId)
      return
    }
    pending.redeliveryPending = true
    this.enqueueCompletionDelivery(pending)
  }

  /** Flush one deterministic Host-visible terminal notice, then mark its durable outbox row. */
  private async ensureCompletionExhaustionNotice(
    expected: RecoveryRunRef,
    agent: Agent,
  ): Promise<RunSnapshot> {
    const store = this.requireStore()
    const snapshot = store.get(expected.sessionId)
    if (this.isSameRecoveryRun(snapshot, expected)
      && snapshot.phase === 'completed' && snapshot.completionDeliveryExhaustionNotified === true) {
      return snapshot
    }
    if (!this.matchesRecoveryRef(snapshot, expected)
      || snapshot.phase !== 'completed' || snapshot.completionDeliveryExhausted !== true
      || snapshot.completionReported) {
      throw new AutonomyError('completion exhaustion notice no longer matches its outbox', 'AUTONOMY_INVALID_TRANSITION')
    }
    const message = this.completionExhaustionMessage(snapshot)
    const existing = agent.session.events.find(event => event.type === 'user/message' && event.data.id === message.id)
    if (existing === undefined) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    } else {
      const { source } = existing.data as {
        readonly source: Partial<{ kind: string; plugin: string; form: string }>
      }
      if (source.kind !== 'plugin' || source.plugin !== 'dsh-autopilot' || source.form !== 'notice') {
        throw new Error(`completion exhaustion message id ${JSON.stringify(String(message.id))} is already in use`)
      }
    }
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new Error('completion exhaustion notice requires configured session persistence')
    }
    let converged: RunSnapshot | undefined
    const stored = await store.reduceCurrent(expected.sessionId, (latest) => {
      if (this.isSameRecoveryRun(latest, expected)
        && latest.phase === 'completed' && latest.completionDeliveryExhaustionNotified === true) {
        converged = latest
        return undefined
      }
      if (!this.matchesRecoveryRef(latest, expected)
        || latest.phase !== 'completed' || latest.completionDeliveryExhausted !== true
        || latest.completionReported) {
        throw new AutonomyError('completion exhaustion notice no longer matches its outbox', 'AUTONOMY_INVALID_TRANSITION')
      }
      return {
        operation: 'completion-delivery-exhaustion-notified',
        snapshot: this.mutate(latest, { completionDeliveryExhaustionNotified: true }),
      }
    })
    const notified = stored ?? converged
    /* v8 ignore next -- the reducer either commits, converges, or throws. */
    if (notified === undefined) throw new Error('completion exhaustion notice did not converge')
    if (stored !== undefined) await this.publishChanged(agent, 'completion-delivery-exhaustion-notified', stored)
    return notified
  }

  /** Build the bounded plugin-authored terminal report shown directly by the Host. */
  private completionExhaustionMessage(snapshot: RunSnapshot) {
    const notice = this.notice(snapshot)
    const summary = notice.summary.replace(/\s+/gu, ' ').trim().slice(0, 500)
    return freezeMessage({
      id: MessageId(`dsh-autopilot:${notice.id}:delivery-exhausted`),
      role: 'user' as const,
      content: [{
        type: 'text' as const,
        text: `Autopilot acceptance passed, but the model failed to produce a final user-facing report in ${MAX_COMPLETION_DELIVERY_ATTEMPTS} consecutive attempts. Verification summary: ${summary}. Use /autopilot audit to inspect the durable run history.`,
      }],
      source: {
        kind: 'plugin' as const,
        plugin: 'dsh-autopilot',
        form: 'notice',
        summary: 'Autopilot completion report delivery exhausted',
      },
    })
  }

  /** Compatibility wrapper that performs both durable finalization phases. */
  async complete(agent: Agent, record: VerificationRecord): Promise<AutonomyLeaseView> {
    await this.beginFinalization(agent, record)
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined) throw new AutonomyError('current Goal is missing', 'AUTONOMY_INVALID_TRANSITION')
    return (await this.finalizeCompletion(agent, goalRef(goal))).view
  }

  /** Count one successful dynamic Package definition against the durable run. */
  async recordDynamicPackage(agent: Agent): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'record dynamic Package')
    if (snapshot.usage.dynamicPackages >= snapshot.budgets.maxDynamicPackages) {
      throw new AutonomyError('dynamic Package budget exhausted', 'AUTONOMY_INVALID_TRANSITION')
    }
    const next = this.mutate(snapshot, {
      usage: Object.freeze({ ...snapshot.usage, dynamicPackages: snapshot.usage.dynamicPackages + 1 }),
    })
    await this.commit(agent, 'dynamic-package', next)
    return this.view(agent, next)
  }

  /** Reserve one durable Host-only extension version before evaluating model-supplied code. */
  async beginDynamicExtension(
    agent: Agent,
    request: DynamicExtensionRequest,
  ): Promise<{ readonly view: AutonomyLeaseView; readonly extension: DynamicExtensionVersion }> {
    const snapshot = this.requireRunning(agent, 'apply dynamic extension')
    if (snapshot.selfModification === 'off') {
      throw new AutonomyError('dynamic Cordis is disabled for this run', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (snapshot.usage.dynamicPackages >= snapshot.budgets.maxDynamicPackages) {
      throw new AutonomyError('dynamic Package budget exhausted', 'AUTONOMY_INVALID_TRANSITION')
    }
    const logicalId = request.logicalId.trim()
    const name = request.name.trim()
    const purpose = request.purpose.trim()
    const hostCode = request.hostCode.trim()
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(logicalId)) {
      throw new AutonomyError(
        'dynamic extension logicalId must be 1-32 lowercase letters, digits, or hyphens and start with a letter',
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    if (name.length === 0 || purpose.length === 0 || hostCode.length === 0) {
      throw new AutonomyError(
        'dynamic extension name, purpose, and hostCode must not be empty',
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    if (!/^[a-f0-9]{64}$/u.test(request.sourceSha256)) {
      throw new AutonomyError('dynamic extension sourceSha256 is invalid', 'AUTONOMY_INVALID_TRANSITION')
    }
    if (snapshot.dynamicExtensions.some(extension => extension.logicalId === logicalId
      && (extension.status === 'applying' || extension.status === 'removing'))) {
      throw new AutonomyError(
        `dynamic extension "${logicalId}" already has an applying version or a removing version`,
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    const version = Math.max(0, ...snapshot.dynamicExtensions
      .filter(extension => extension.logicalId === logicalId)
      .map(extension => extension.version)) + 1
    const now = Date.now()
    const extension: DynamicExtensionVersion = Object.freeze({
      logicalId,
      version,
      name,
      purpose,
      hostCode,
      sourceSha256: request.sourceSha256,
      status: 'applying',
      createdAt: now,
      updatedAt: now,
    })
    const next = this.mutate(snapshot, {
      dynamicExtensions: Object.freeze([...snapshot.dynamicExtensions, extension]),
      usage: Object.freeze({ ...snapshot.usage, dynamicPackages: snapshot.usage.dynamicPackages + 1 }),
      at: now,
    })
    await this.commit(agent, 'dynamic-apply', next)
    return Object.freeze({ view: this.view(agent, next), extension })
  }

  /** Settle one reserved extension version after define, activation, and health inspection. */
  async settleDynamicExtension(
    agent: Agent,
    logicalId: string,
    version: number,
    outcome: { readonly ok: true } | { readonly ok: false; readonly reason: string },
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'settle dynamic extension')
    const index = snapshot.dynamicExtensions.findIndex(extension => extension.logicalId === logicalId
      && extension.version === version)
    const target = snapshot.dynamicExtensions[index]
    if (index < 0 || target === undefined || target.status !== 'applying') {
      throw new AutonomyError(
        `dynamic extension "${logicalId}" version ${version} is not applying`,
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    const now = Date.now()
    const dynamicExtensions = snapshot.dynamicExtensions.map((extension, candidateIndex): DynamicExtensionVersion => {
      if (candidateIndex === index) {
        return Object.freeze({
          ...extension,
          status: outcome.ok ? 'active' : 'failed',
          updatedAt: now,
          ...(outcome.ok ? {} : { reason: outcome.reason.trim() || 'dynamic extension activation failed' }),
        })
      }
      if (outcome.ok && extension.logicalId === logicalId && extension.status === 'active') {
        return Object.freeze({ ...extension, status: 'superseded', updatedAt: now })
      }
      return extension
    })
    const next = this.mutate(snapshot, { dynamicExtensions: Object.freeze(dynamicExtensions), at: now })
    await this.commit(agent, 'dynamic-settle', next)
    return this.view(agent, next)
  }

  /** Reserve cleanup before the host undefines any dynamic extension version. */
  async beginDynamicExtensionRemoval(
    agent: Agent,
    logicalId: string,
    reason: string,
  ): Promise<{ readonly view: AutonomyLeaseView; readonly extensions: readonly DynamicExtensionVersion[] }> {
    const snapshot = this.requireRunning(agent, 'remove dynamic extension')
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0) {
      throw new AutonomyError('dynamic extension removal requires a reason', 'AUTONOMY_INVALID_TRANSITION')
    }
    const pending = snapshot.dynamicExtensions.filter(extension => extension.logicalId === logicalId
      && extension.status === 'removing')
    if (pending.length > 0) {
      return Object.freeze({ view: this.view(agent, snapshot), extensions: Object.freeze(pending) })
    }
    let found = false
    const now = Date.now()
    const dynamicExtensions = snapshot.dynamicExtensions.map((extension): DynamicExtensionVersion => {
      if (extension.logicalId !== logicalId || (extension.status !== 'active' && extension.status !== 'applying')) {
        return extension
      }
      found = true
      return Object.freeze({ ...extension, status: 'removing', reason: normalizedReason, updatedAt: now })
    })
    if (!found) {
      throw new AutonomyError(
        `dynamic extension "${logicalId}" has no active version`,
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    const next = this.mutate(snapshot, { dynamicExtensions: Object.freeze(dynamicExtensions), at: now })
    await this.commit(agent, 'dynamic-remove-begin', next)
    return Object.freeze({
      view: this.view(agent, next),
      extensions: Object.freeze(dynamicExtensions.filter(extension => extension.logicalId === logicalId
        && extension.status === 'removing')),
    })
  }

  /** Settle host cleanup; a failed attempt remains retryable as removing. */
  async settleDynamicExtensionRemoval(
    agent: Agent,
    logicalId: string,
    outcome: { readonly ok: true } | { readonly ok: false; readonly reason: string },
  ): Promise<AutonomyLeaseView> {
    const snapshot = this.requireRunning(agent, 'settle dynamic extension removal')
    const targets = snapshot.dynamicExtensions.filter(extension => extension.logicalId === logicalId
      && extension.status === 'removing')
    if (targets.length === 0) {
      throw new AutonomyError(
        `dynamic extension "${logicalId}" has no cleanup-pending version`,
        'AUTONOMY_INVALID_TRANSITION',
      )
    }
    const now = Date.now()
    const dynamicExtensions = snapshot.dynamicExtensions.map((extension): DynamicExtensionVersion => {
      if (extension.logicalId !== logicalId || extension.status !== 'removing') return extension
      return Object.freeze({
        ...extension,
        status: outcome.ok ? 'removed' : 'removing',
        updatedAt: now,
        ...(outcome.ok ? {} : { reason: outcome.reason.trim() || 'dynamic extension cleanup failed' }),
      })
    })
    const next = this.mutate(snapshot, { dynamicExtensions: Object.freeze(dynamicExtensions), at: now })
    await this.commit(agent, 'dynamic-remove-settle', next)
    return this.view(agent, next)
  }

  /** Compatibility alias that only begins recoverable cleanup. */
  async removeDynamicExtension(agent: Agent, logicalId: string, reason: string): Promise<AutonomyLeaseView> {
    return (await this.beginDynamicExtensionRemoval(agent, logicalId, reason)).view
  }

  /** Current live activity signal, unavailable after a restart until human resume. */
  signal(agent: Agent): AbortSignal {
    const snapshot = this.requireSnapshot(agent)
    const runtime = this.runtimes.get(agent)
    if (runtime === undefined || runtime.runId !== snapshot.runId) {
      throw new AutonomyError(
        'Autopilot is durably present but disarmed; use human `/autopilot resume`',
        'AUTONOMY_LEASE_MISSING',
      )
    }
    return runtime.activity.signal
  }

  /** Validate a user-requested Goal round cap. */
  resolveGoalRounds(value?: number): number {
    const rounds = positiveSafeInteger(
      value ?? this.limits.defaultMaxGoalRounds,
      'maxGoalRounds',
      'AUTONOMY_INVALID_ROUNDS',
    )
    if (rounds > this.limits.maxGoalRounds) {
      throw new AutonomyError(
        `maxGoalRounds ${rounds} exceeds deployment ceiling ${this.limits.maxGoalRounds}`,
        'AUTONOMY_INVALID_ROUNDS',
      )
    }
    return rounds
  }

  /** Validate a user-requested active duration. */
  resolveDuration(value?: number): number {
    const duration = positiveSafeInteger(
      value ?? this.limits.defaultMaxActiveMs,
      'maxActiveMs',
      'AUTONOMY_INVALID_DURATION',
    )
    if (duration > this.limits.maxActiveMs) {
      throw new AutonomyError(
        `maxActiveMs ${duration} exceeds deployment ceiling ${this.limits.maxActiveMs}`,
        'AUTONOMY_INVALID_DURATION',
      )
    }
    return duration
  }

  private requireStore(): DurableRunStore {
    if (this.store === undefined) throw new Error('Autopilot durable run store is not initialized')
    return this.store
  }

  private async requireDurableSession(agent: Agent): Promise<void> {
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new Error('Autopilot recovery requires configured session persistence')
    }
  }

  private requireSnapshot(agent: Agent): RunSnapshot {
    const snapshot = this.requireStore().get(String(agent.id))
    if (snapshot === undefined) {
      throw new AutonomyError('no Autopilot run; use human `/autopilot start`', 'AUTONOMY_LEASE_MISSING')
    }
    return snapshot
  }

  private requireRunning(agent: Agent, operation: string): RunSnapshot {
    const snapshot = this.requireSnapshot(agent)
    if (snapshot.phase !== 'running' || !this.isArmed(agent, snapshot)) {
      throw this.transitionError(agent, snapshot, operation)
    }
    return snapshot
  }

  private requireActive(agent: Agent, operation: string): RunSnapshot {
    const snapshot = this.requireSnapshot(agent)
    if ((snapshot.phase !== 'running' && snapshot.phase !== 'verifying') || !this.isArmed(agent, snapshot)) {
      throw this.transitionError(agent, snapshot, operation)
    }
    return snapshot
  }

  private async commit(agent: Agent, operation: RunOperation, snapshot: RunSnapshot): Promise<void> {
    await this.requireStore().append(operation, Object.freeze(snapshot))
    await this.publishChanged(agent, operation, snapshot)
  }

  /** Contain post-commit observer failures after the append became authoritative. */
  private async publishChanged(agent: Agent, operation: RunOperation, snapshot: RunSnapshot): Promise<void> {
    try {
      await this.ctx.parallel('autonomy/changed', { agent, operation, view: this.view(agent, snapshot) })
    } catch (error: unknown) {
      this.ctx.logger.error(
        `dsh-autopilot: ${operation} notification failed after durable revision ${snapshot.revision}: ${errorDetails(error)}`,
      )
    }
  }

  private view(agent: Agent, snapshot: RunSnapshot): AutonomyLeaseView {
    const armed = this.isArmed(agent, snapshot)
    return Object.freeze({
      id: snapshot.runId,
      generation: snapshot.generation,
      revision: snapshot.revision,
      goalId: snapshot.goalId as GoalId,
      phase: snapshot.phase,
      activation: armed ? 'armed' : 'disarmed',
      grantedAt: snapshot.grantedAt,
      updatedAt: snapshot.updatedAt,
      ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
      remainingActiveMs: armed ? this.remaining(snapshot) : snapshot.expiresAt === undefined
        ? snapshot.remainingActiveMs
        : Math.max(0, snapshot.expiresAt - Date.now()),
      maxActiveMs: snapshot.maxActiveMs,
      verificationAttempts: snapshot.usage.verificationAttempts,
      dynamicPackages: snapshot.usage.dynamicPackages,
      subagentsStarted: snapshot.usage.subagentsStarted,
      maxVerificationAttempts: snapshot.budgets.maxVerificationAttempts,
      maxDynamicPackages: snapshot.budgets.maxDynamicPackages,
      maxSubagents: snapshot.budgets.maxSubagents,
      maxConcurrentSubagents: snapshot.budgets.maxConcurrentSubagents,
      maxTasks: snapshot.budgets.maxTasks,
      maxTaskAttempts: snapshot.budgets.maxTaskAttempts,
      maxEvidenceItems: snapshot.budgets.maxEvidenceItems,
      maxSnapshotBytes: snapshot.budgets.maxSnapshotBytes,
      maxAuditRecords: snapshot.budgets.maxAuditRecords,
      maxAuditBytes: snapshot.budgets.maxAuditBytes,
      maxDynamicSourceChars: snapshot.budgets.maxDynamicSourceChars,
      selfModification: snapshot.selfModification,
      autoResume: snapshot.autoResume,
      dynamicExtensions: snapshot.dynamicExtensions,
      ...(snapshot.verificationPolicy === undefined
        ? {}
        : { verificationPolicy: snapshot.verificationPolicy }),
      ...(snapshot.verificationBaseline === undefined
        ? {}
        : { verificationBaseline: snapshot.verificationBaseline }),
      flow: snapshot.flow,
      ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
      verificationHistory: snapshot.verificationHistory,
      completionReported: snapshot.completionReported,
      completionDeliveryAttempts: snapshot.completionDeliveryAttempts ?? 0,
      completionDeliveryExhausted: snapshot.completionDeliveryExhausted ?? false,
      completionDeliveryExhaustionNotified: snapshot.completionDeliveryExhaustionNotified ?? false,
      ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
    })
  }

  private notice(snapshot: RunSnapshot): CompletionNotice {
    const record = snapshot.verificationHistory.at(-1)
    /* v8 ignore next -- every caller validates the completed snapshot's passing record first. */
    if (record?.verdict !== 'pass') {
      throw new AutonomyError('completion notice requires a passing verification record', 'AUTONOMY_INVALID_TRANSITION')
    }
    return Object.freeze({
      id: `${snapshot.runId}:completion`,
      runId: snapshot.runId,
      goalId: snapshot.goalId as GoalId,
      summary: record.summary,
    })
  }

  private mutate(
    current: RunSnapshot,
    change: {
      readonly phase?: RunSnapshot['phase']
      readonly remainingActiveMs?: number
      readonly expiresAt?: number
      readonly maxActiveMs?: number
      readonly plan?: RunPlan
      readonly candidate?: VerificationCandidate
      readonly finalization?: VerificationRecord
      readonly verificationHistory?: readonly VerificationRecord[]
      readonly completionReported?: boolean
      readonly completionDeliveryAttempts?: number
      readonly completionDeliveryExhausted?: boolean
      readonly completionDeliveryExhaustionNotified?: boolean
      readonly usage?: RunSnapshot['usage']
      readonly dynamicExtensions?: readonly DynamicExtensionVersion[]
      readonly verificationPolicy?: VerificationPolicy
      readonly verificationBaseline?: VerificationBaseline
      readonly flow?: AutopilotFlowState
      readonly reason?: string
      readonly at?: number
      readonly clearExpiresAt?: boolean
      readonly clearCandidate?: boolean
      readonly clearFinalization?: boolean
      readonly clearReason?: boolean
    },
  ): RunSnapshot {
    const next: RunSnapshot = {
      ...current,
      revision: current.revision + 1,
      updatedAt: Math.max(change.at ?? Date.now(), current.updatedAt),
      ...(change.phase === undefined ? {} : { phase: change.phase }),
      ...(change.remainingActiveMs === undefined ? {} : { remainingActiveMs: change.remainingActiveMs }),
      ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
      ...(change.maxActiveMs === undefined ? {} : { maxActiveMs: change.maxActiveMs }),
      ...(change.plan === undefined ? {} : { plan: change.plan }),
      ...(change.candidate === undefined ? {} : { candidate: change.candidate }),
      ...(change.finalization === undefined ? {} : { finalization: change.finalization }),
      ...(change.verificationHistory === undefined ? {} : { verificationHistory: change.verificationHistory }),
      ...(change.completionReported === undefined ? {} : { completionReported: change.completionReported }),
      ...(change.completionDeliveryAttempts === undefined
        ? {}
        : { completionDeliveryAttempts: change.completionDeliveryAttempts }),
      ...(change.completionDeliveryExhausted === undefined
        ? {}
        : { completionDeliveryExhausted: change.completionDeliveryExhausted }),
      ...(change.completionDeliveryExhaustionNotified === undefined
        ? {}
        : { completionDeliveryExhaustionNotified: change.completionDeliveryExhaustionNotified }),
      ...(change.usage === undefined ? {} : { usage: change.usage }),
      ...(change.dynamicExtensions === undefined ? {} : { dynamicExtensions: change.dynamicExtensions }),
      ...(change.verificationPolicy === undefined ? {} : { verificationPolicy: change.verificationPolicy }),
      ...(change.verificationBaseline === undefined ? {} : { verificationBaseline: change.verificationBaseline }),
      ...(change.flow === undefined ? {} : { flow: change.flow }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    }
    if (change.clearExpiresAt === true) delete (next as { expiresAt?: number }).expiresAt
    if (change.clearCandidate === true) delete (next as { candidate?: VerificationCandidate }).candidate
    if (change.clearFinalization === true) delete (next as { finalization?: VerificationRecord }).finalization
    if (change.clearReason === true) delete (next as { reason?: string }).reason
    return Object.freeze(next)
  }

  private transitionError(agent: Agent, snapshot: RunSnapshot, operation: string): AutonomyError {
    const activation = this.isArmed(agent, snapshot) ? 'armed' : 'disarmed'
    return new AutonomyError(
      `cannot ${operation} Autopilot run while phase is "${snapshot.phase}" (${activation})`,
      'AUTONOMY_INVALID_TRANSITION',
    )
  }

  private matchesRecoveryRef(
    snapshot: RunSnapshot | undefined,
    expected: RecoveryRunRef,
  ): snapshot is RunSnapshot {
    return snapshot !== undefined
      && snapshot.runId === expected.runId
      && snapshot.generation === expected.generation
      && snapshot.revision === expected.revision
      && snapshot.sessionId === expected.sessionId
  }

  private isSameRunAttention(
    snapshot: RunSnapshot | undefined,
    expected: RecoveryRunRef,
  ): boolean {
    return snapshot !== undefined
      && snapshot.runId === expected.runId
      && snapshot.generation === expected.generation
      && snapshot.sessionId === expected.sessionId
      && snapshot.phase === 'needs-attention'
  }

  private isSameRecoveryRun(
    snapshot: RunSnapshot | undefined,
    expected: RecoveryRunRef,
  ): snapshot is RunSnapshot {
    return snapshot !== undefined
      && snapshot.runId === expected.runId
      && snapshot.generation === expected.generation
      && snapshot.sessionId === expected.sessionId
  }

  /** Confirm that no observer replaced, advanced, paused, armed, or disarmed the Goal. */
  private matchesGoalCheckpoint(
    current: GoalView | undefined,
    checkpoint: GoalView | undefined,
    goalId: string,
  ): current is GoalView {
    return checkpoint !== undefined && current !== undefined
      && String(checkpoint.id) === goalId && current.id === checkpoint.id
      && current.revision === checkpoint.revision
      && current.phase === checkpoint.phase
      && current.activation === checkpoint.activation
  }

  /** Disarm only the still-owning run and Goal after an observer wins the rearm race. */
  private disarmAfterRearmRace(
    agent: Agent,
    attempted: RunSnapshot,
    authoritative: RunSnapshot | undefined,
    reason: string,
  ): void {
    if (authoritative === undefined || authoritative.runId !== attempted.runId
      || authoritative.generation !== attempted.generation
      || authoritative.sessionId !== attempted.sessionId) return
    const runtime = this.runtimes.get(agent)
    if (runtime?.runId === attempted.runId) this.disarmRuntime(agent, runtime, reason)
    const goal = this.ctx.goals.get(agent)
    if (String(goal?.id) === attempted.goalId && goal?.activation === 'armed') this.ctx.goals.disarm(agent)
  }

  private isArmed(agent: Agent, snapshot: RunSnapshot): boolean {
    const runtime = this.runtimes.get(agent)
    return runtime !== undefined && runtime.runId === snapshot.runId
      && (snapshot.phase === 'running' || snapshot.phase === 'verifying')
  }

  private remaining(snapshot: RunSnapshot): number {
    return snapshot.expiresAt === undefined
      ? snapshot.remainingActiveMs
      : Math.max(0, snapshot.expiresAt - Date.now())
  }

  private armRuntime(agent: Agent, snapshot: RunSnapshot): void {
    const old = this.runtimes.get(agent)
    if (old !== undefined) this.disarmRuntime(agent, old, 'Autopilot re-armed')
    const runtime: RuntimeLease = {
      runId: snapshot.runId,
      goalId: snapshot.goalId as GoalId,
      activity: new AbortController(),
    }
    this.runtimes.set(agent, runtime)
    this.scheduleExpiry(agent, snapshot, runtime)
  }

  private disarmRuntime(agent: Agent, runtime: RuntimeLease, reason: string): void {
    if (runtime.timer !== undefined) clearTimeout(runtime.timer)
    runtime.timer = undefined
    runtime.activity.abort(new Error(reason))
    if (this.runtimes.get(agent) === runtime) this.runtimes.delete(agent)
  }

  private scheduleExpiry(agent: Agent, snapshot: RunSnapshot, runtime: RuntimeLease): void {
    if (runtime.timer !== undefined) clearTimeout(runtime.timer)
    const remaining = this.remaining(snapshot)
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      const current = this.requireStore().get(String(agent.id))
      if (current === undefined || current.runId !== runtime.runId || this.runtimes.get(agent) !== runtime) return
      if (remaining > MAX_TIMER_DELAY_MS && this.remaining(current) > 0) {
        this.scheduleExpiry(agent, current, runtime)
      } else {
        void this.expire(agent, current, runtime)
      }
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
    runtime.timer.unref()
  }

  /** Rearm a compaction-disarmed Goal only for the exact explicitly authorized run. */
  private continueAfterCompaction(agent: Agent, runtime: RuntimeLease): boolean {
    const snapshot = this.requireStore().get(String(agent.id))
    if (snapshot === undefined || snapshot.runId !== runtime.runId
      || (snapshot.phase !== 'running' && snapshot.phase !== 'verifying') || !snapshot.autoResume) {
      return false
    }
    if (this.remaining(snapshot) < 1) return false
    const goal = this.ctx.goals.get(agent)
    if (goal !== undefined && String(goal.id) === snapshot.goalId && goal.phase === 'active') {
      if (goal.activation === 'disarmed') {
        try {
          this.ctx.goals.resume(agent, goalRef(goal))
        } catch (error: unknown) {
          this.failCompactionContinuation(agent, runtime, snapshot, error)
        }
      }
      return true
    }
    this.failCompactionContinuation(
      agent,
      runtime,
      snapshot,
      new Error('the compacted session no longer exposes the authorized active Goal'),
    )
    return true
  }

  /** Disarm immediately and persist an exact fail-closed state after compaction disagreement. */
  private failCompactionContinuation(
    agent: Agent,
    runtime: RuntimeLease,
    snapshot: RunSnapshot,
    error: unknown,
  ): void {
    const reason = `compaction continuation failed: ${String(error)}`
    this.disarmRuntime(agent, runtime, reason)
    const expected: RecoveryRunRef = {
      runId: snapshot.runId,
      generation: snapshot.generation,
      revision: snapshot.revision,
      sessionId: snapshot.sessionId,
    }
    void this.markNeedsAttention(expected, reason).catch((attentionError: unknown) => {
      this.ctx.logger.error(
        `dsh-autopilot: failed to persist compaction needs-attention: ${String(attentionError)}`,
      )
    })
  }

  private async expire(agent: Agent, snapshot: RunSnapshot, runtime: RuntimeLease): Promise<void> {
    if (this.remaining(snapshot) > 0) {
      this.scheduleExpiry(agent, snapshot, runtime)
      return
    }
    this.disarmRuntime(agent, runtime, 'Autopilot active duration exhausted')
    const goal = this.ctx.goals.get(agent)
    if (goal?.id === snapshot.goalId && goal.activation === 'armed') this.ctx.goals.disarm(agent)
    agent.cancel({ kind: 'hook', reason: 'dsh-autopilot lease expired' }, { keepInbox: true })
    let reschedule: RunSnapshot | undefined
    let stored: RunSnapshot | undefined
    try {
      stored = await this.requireStore().reduceCurrent(String(agent.id), (latest) => {
        if (latest === undefined || latest.runId !== snapshot.runId
          || (latest.phase !== 'running' && latest.phase !== 'verifying')) return undefined
        if (this.remaining(latest) > 0) {
          reschedule = latest
          return undefined
        }
        return {
          operation: 'expire',
          snapshot: this.mutate(latest, {
            phase: 'exhausted',
            remainingActiveMs: 0,
            ...(latest.plan === undefined
              ? {}
              : { plan: interruptRunTasks(latest.plan, Date.now(), 'active duration exhausted').plan }),
            reason: 'active duration exhausted',
            clearExpiresAt: true,
            clearCandidate: true,
          }),
        }
      })
    } catch (error: unknown) {
      this.ctx.logger.error(`dsh-autopilot: failed to persist lease expiry: ${String(error)}`)
      return
    }
    if (reschedule !== undefined) {
      this.armRuntime(agent, reschedule)
      return
    }
    if (stored === undefined) return
    await this.publishChanged(agent, 'expire', stored)
    if (goal !== undefined && goal.id === snapshot.goalId && goal.phase === 'active') {
      try {
        this.ctx.goals.pause(agent, goalRef(goal))
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-autopilot: could not pause expired Goal: ${String(error)}`)
        this.ctx.goals.disarm(agent)
      }
    }
  }

  private async pausePersistedRun(agent: Agent, reason: string): Promise<void> {
    const snapshot = this.requireStore().get(String(agent.id))
    if (snapshot === undefined || (snapshot.phase !== 'running' && snapshot.phase !== 'verifying')) return
    try {
      let operation: RunOperation = 'pause'
      const stored = await this.requireStore().reduceCurrent(String(agent.id), (latest) => {
        if (latest === undefined || latest.runId !== snapshot.runId
          || (latest.phase !== 'running' && latest.phase !== 'verifying')) return undefined
        const remainingActiveMs = this.remaining(latest)
        operation = remainingActiveMs > 0 ? 'pause' : 'expire'
        return {
          operation,
          snapshot: this.mutate(latest, {
            phase: remainingActiveMs > 0 ? 'paused' : 'exhausted',
            remainingActiveMs,
            ...(latest.plan === undefined
              ? {}
              : { plan: interruptRunTasks(latest.plan, Date.now(), reason).plan }),
            reason,
            clearExpiresAt: true,
            clearCandidate: true,
          }),
        }
      })
      if (stored !== undefined) await this.publishChanged(agent, operation, stored)
    } catch (error: unknown) {
      this.ctx.logger.error(`dsh-autopilot: failed to persist lifecycle pause: ${String(error)}`)
    }
  }
}

export default AutonomyService
