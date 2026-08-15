/** Crash-only cold recovery for explicitly authorized Autopilot runs. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import type { FoldedGoal, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { RunPhase, VerificationRecord } from './run-state.ts'

/** Parsed lifecycle command whose durable `command/run` may require recovery. */
export type ParsedLifecycleCommand =
  | {
    readonly kind: 'start'
    readonly objective: string
    readonly maxGoalRounds?: number
    readonly maxActiveMs?: number
  }
  | { readonly kind: 'pause' | 'stop' }
  | { readonly kind: 'resume'; readonly maxActiveMs?: number }
  | { readonly kind: 'invalid'; readonly message: string }

/** One unresolved human lifecycle command reconstructed from the session log. */
export interface RecoveryLifecycleIntent {
  readonly commandId: string
  readonly seq: number
  readonly command: Exclude<ParsedLifecycleCommand, { kind: 'invalid' }>
}

/** Parse a positive integer without accepting exponent or decimal syntax. */
function parseInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Parse a compact duration (`ms`, `s`, `m`, `h`, `d`, or `w`). */
export function parseDuration(value: string): number | undefined {
  const match = /^([1-9]\d*)(ms|s|m|h|d|w)$/u.exec(value)
  if (match === null) return undefined
  const amountText = match[1]
  const unit = match[2]
  /* v8 ignore next -- both captures are mandatory whenever the duration expression matches. */
  if (amountText === undefined || unit === undefined) return undefined
  const amount = parseInteger(amountText)
  if (amount === undefined) return undefined
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  const multiplier = multipliers[unit]
  /* v8 ignore next -- the expression restricts unit to the complete multiplier key set. */
  if (multiplier === undefined) return undefined
  const duration = amount * multiplier
  return Number.isSafeInteger(duration) ? duration : undefined
}

interface LifecycleOptions {
  readonly rest: string
  readonly maxGoalRounds?: number
  readonly maxActiveMs?: number
  readonly error?: string
}

/** Parse leading start/resume options while preserving the objective remainder. */
function parseLifecycleOptions(input: string, allowRounds: boolean): LifecycleOptions {
  let rest = input.trimStart()
  let maxGoalRounds: number | undefined
  let maxActiveMs: number | undefined
  while (rest.startsWith('--')) {
    const option = /^--(rounds|duration)(?:=([^\s]+)|\s+([^\s]+))(?:\s+|$)/u.exec(rest)
    if (option === null) {
      const [optionToken] = rest.split(/\s/u, 1)
      /* v8 ignore next -- the non-empty rest always yields its first token. */
      if (optionToken === undefined) return { rest, error: 'Invalid autopilot option.' }
      return { rest, error: `Invalid option near "${optionToken}".` }
    }
    const optionName = option[1]
    const optionValue = option[2] ?? option[3]
    /* v8 ignore next 3 -- the expression requires a name and exactly one value capture. */
    if (optionName === undefined || optionValue === undefined) {
      return { rest, error: 'Invalid autopilot option.' }
    }
    if (optionName === 'rounds') {
      if (!allowRounds) return { rest, error: '--rounds is accepted only by `start`.' }
      if (maxGoalRounds !== undefined) return { rest, error: '--rounds may be supplied only once.' }
      maxGoalRounds = parseInteger(optionValue)
      if (maxGoalRounds === undefined) return { rest, error: '--rounds requires a positive safe integer.' }
    } else {
      if (maxActiveMs !== undefined) return { rest, error: '--duration may be supplied only once.' }
      maxActiveMs = parseDuration(optionValue)
      if (maxActiveMs === undefined) {
        return { rest, error: '--duration requires a positive value such as `24h`, `7d`, or `2w`.' }
      }
    }
    rest = rest.slice(option[0].length).trimStart()
  }
  return {
    rest,
    ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
    ...(maxActiveMs === undefined ? {} : { maxActiveMs }),
  }
}

/** Parse only the lifecycle subset shared by command execution and crash recovery. */
export function parseLifecycleCommand(rawInput: string): ParsedLifecycleCommand | undefined {
  const input = rawInput.trim()
  const normalized = input.toLowerCase()
  if (normalized === 'pause') return { kind: 'pause' }
  if (normalized === 'stop') return { kind: 'stop' }
  const resumeMatch = /^resume(?:\s+([\s\S]*))?$/iu.exec(input)
  if (resumeMatch !== null) {
    const options = parseLifecycleOptions(resumeMatch[1] ?? '', false)
    if (options.error !== undefined) return { kind: 'invalid', message: options.error }
    if (options.rest.length > 0) return { kind: 'invalid', message: '`resume` accepts only `--duration`.' }
    return {
      kind: 'resume',
      ...(options.maxActiveMs === undefined ? {} : { maxActiveMs: options.maxActiveMs }),
    }
  }
  const startMatch = /^start(?:\s+([\s\S]*))?$/iu.exec(input)
  if (startMatch === null) return undefined
  const options = parseLifecycleOptions(startMatch[1] ?? '', true)
  if (options.error !== undefined) return { kind: 'invalid', message: options.error }
  if (options.rest.trim().length === 0) {
    return { kind: 'invalid', message: '`start` requires a non-empty objective.' }
  }
  return {
    kind: 'start',
    objective: options.rest.trim(),
    ...(options.maxGoalRounds === undefined ? {} : { maxGoalRounds: options.maxGoalRounds }),
    ...(options.maxActiveMs === undefined ? {} : { maxActiveMs: options.maxActiveMs }),
  }
}

/** Fold the latest lifecycle command only when its `command/done` is absent. */
export function foldPendingLifecycleIntent(
  events: readonly SessionEvent[],
): RecoveryLifecycleIntent | undefined {
  let latest: { readonly intent: RecoveryLifecycleIntent; done: boolean } | undefined
  for (const event of events) {
    if (event.type === 'command/run' && event.data.name === 'autopilot'
      && event.data.source.kind === 'user') {
      const parsed = parseLifecycleCommand(event.data.args ?? '')
      if (parsed !== undefined && parsed.kind !== 'invalid') {
        latest = {
          intent: {
            commandId: String(event.data.commandId),
            seq: event.seq,
            command: parsed,
          },
          done: false,
        }
      }
      continue
    }
    if (event.type === 'command/done' && latest?.intent.commandId === String(event.data.commandId)) {
      latest.done = true
    }
  }
  return latest?.done === false ? latest.intent : undefined
}

/** A sidecar phase that stops automatic retries until a human reconciles it. */
export type RecoveryRunPhase = RunPhase | 'needs-attention'

/** Minimum durable sidecar state required to decide whether recovery is authorized. */
export interface RecoveryRun {
  readonly runId: string
  readonly generation: number
  readonly revision: number
  readonly sessionId: string
  readonly goalId: string
  readonly phase: RecoveryRunPhase
  /** Explicit authorization recorded by the human start/resume command. */
  readonly autoResume: boolean
  readonly finalization?: VerificationRecord | undefined
  readonly completionReported: boolean
}

/** Stable compare-and-set identity for recovery-side sidecar mutations. */
export interface RecoveryRunRef {
  readonly runId: string
  readonly generation: number
  readonly revision: number
  readonly sessionId: string
}

/** Why an otherwise current sidecar row is deliberately not recovered. */
export type RecoverySkipCode =
  | 'auto-resume-disabled'
  | 'user-paused'
  | 'revoked'
  | 'completed'
  | 'exhausted'
  | 'needs-attention'

/** Goal facts that must still match after a cold Agent is published. */
export interface RecoveryGoal extends GoalRef {
  readonly roundsStarted: number
  readonly maxGoalRounds: number
}

/** Pure reconciliation decision made before any Agent is resumed. */
export type RecoveryPlan =
  | { readonly kind: 'recover'; readonly goal: RecoveryGoal }
  | { readonly kind: 'finalize'; readonly goal: GoalRef; readonly goalPhase: 'active' | 'complete' }
  | {
    readonly kind: 'converge-safety'
    readonly goal: GoalRef
    readonly phase: 'paused' | 'revoked' | 'exhausted' | 'needs-attention'
  }
  | { readonly kind: 'converge-completion'; readonly goal: GoalRef }
  | { readonly kind: 'completion-notice' }
  | { readonly kind: 'skip'; readonly code: RecoverySkipCode; readonly reason: string }
  | { readonly kind: 'needs-attention'; readonly reason: string }

/** Result of the sidecar's compare-and-set activation transaction. */
export type RecoveryActivationResult =
  | { readonly kind: 'recovered' }
  | { readonly kind: 'superseded'; readonly reason: string }
  | { readonly kind: 'needs-attention'; readonly reason: string }

/** Exact bundle generation held for one cold or same-host recovery attempt. */
export interface RecoveryAttemptReadiness {
  /** Throw when any recovery-critical contribution changed after admission. */
  assertCurrent(): void
}

/** Capture a fresh exact bundle generation for each serialized recovery attempt. */
export interface RecoveryReadinessAdmission {
  /** Return an attempt-local guard, or throw while the bundle is incomplete. */
  checkpoint(): RecoveryAttemptReadiness
}

/** Result of settling an interrupted human command or safety-side Goal write. */
export type RecoveryConvergenceResult =
  | { readonly kind: 'settled'; readonly run: RecoveryRunRef }
  | { readonly kind: 'recovered'; readonly run: RecoveryRunRef }
  | { readonly kind: 'superseded'; readonly reason: string }
  | { readonly kind: 'needs-attention'; readonly reason: string }

/** Deterministic completion feedback pending in the sidecar outbox. */
export interface RecoveryCompletionNotice {
  readonly id: string
  readonly runId: string
  readonly goalId: string
  readonly summary: string
}

/** Durable/live evidence for one deterministic completion-notice message. */
export type CompletionDeliveryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'claimed'; readonly turn: number; readonly admitted: boolean }
  | { readonly kind: 'answered'; readonly turn: number }

/** Result of registering one completion delivery with the service outbox. */
export type CompletionDeliveryRegistration = 'registered' | 'reported'

/** Result of converging one durable finalizing run. */
export type RecoveryFinalizationResult =
  | {
    readonly kind: 'finalized'
    readonly run: RecoveryRunRef
    readonly notice?: RecoveryCompletionNotice | undefined
  }
  | { readonly kind: 'superseded'; readonly reason: string }
  | { readonly kind: 'needs-attention'; readonly reason: string }

/** Result of auditably settling tasks interrupted by process loss. */
export type RecoveryTaskResult =
  | { readonly kind: 'unchanged'; readonly run: RecoveryRunRef }
  | { readonly kind: 'recovered'; readonly run: RecoveryRunRef; readonly taskIds: readonly string[] }
  | { readonly kind: 'superseded'; readonly reason: string }

/**
 * An implementation must make activation a compare-and-set over the supplied
 * run identity. It may arm the run only while the durable row still has the
 * same revision, remains `running` or `verifying`, and still has
 * `autoResume=true`. A concurrent user pause/revoke returns `superseded`; it is
 * never silently undone. `activate` also rearms the matching DSH Goal, rolling
 * its run activation back when Goal rearm fails.
 */
export interface RecoveryRunController {
  /** Return one latest sidecar row per DSH Session. */
  currentRuns(): readonly RecoveryRun[]
  /** Atomically rearm an eligible run and its exact Goal revision. */
  activateRecovered(
    run: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
    readiness?: RecoveryAttemptReadiness,
  ): Promise<RecoveryActivationResult>
  /** Complete or converge an exact durable finalization. */
  finalizeRecovered(run: RecoveryRunRef, agent: Agent, goal: GoalRef): Promise<RecoveryFinalizationResult>
  /** Read a completed run's pending feedback notice without acknowledging delivery. */
  completionNotice(run: RecoveryRunRef): Promise<RecoveryCompletionNotice | undefined>
  /** Register a deterministic followup and acknowledge only its answering turn. */
  registerCompletionDelivery(
    run: RecoveryRunRef,
    agent: Agent,
    messageId: MessageId,
  ): Promise<CompletionDeliveryRegistration>
  /** Settle an unresolved start/pause/resume/stop intent against one exact run. */
  settleInterruptedLifecycle(
    run: RecoveryRunRef,
    agent: Agent,
    intent: RecoveryLifecycleIntent,
  ): Promise<RecoveryConvergenceResult>
  /** Finish the Goal-side mutation for an already-safe sidecar row. */
  convergeSafetyState(
    run: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
  ): Promise<RecoveryConvergenceResult>
  /** Finish the Goal-side completion when the sidecar is already completed. */
  convergeCompletedGoal(
    run: RecoveryRunRef,
    agent: Agent,
    goal: GoalRef,
  ): Promise<RecoveryConvergenceResult>
  /** Settle any in-progress task attempts before autonomous work resumes. */
  recoverInterruptedTasks(run: RecoveryRunRef, agent: Agent, reason: string): Promise<RecoveryTaskResult>
  /** Persist a fail-closed state using the exact expected run identity. */
  markNeedsAttention(run: RecoveryRunRef, reason: string): Promise<void>
}

/** One run's observable recovery outcome. */
export type RecoveryReport =
  | {
    readonly run: RecoveryRunRef
    readonly outcome: 'recovered'
    readonly agent: 'already-live' | 'cold-resumed' | 'race-winner'
  }
  | {
    readonly run: RecoveryRunRef
    readonly outcome: 'skipped'
    readonly reason: string
  }
  | {
    readonly run: RecoveryRunRef
    readonly outcome: 'needs-attention'
    readonly reason: string
  }
  | {
    readonly run: RecoveryRunRef
    readonly outcome: 'failed'
    readonly reason: string
  }
  | {
    readonly run: RecoveryRunRef
    readonly outcome: 'finalized' | 'completion-notice'
    readonly notice?: RecoveryCompletionNotice | undefined
  }
  | {
    readonly sessionId: string
    readonly commandId: string
    readonly outcome: 'needs-attention'
    readonly reason: string
  }

interface AcquiredAgent {
  readonly agent: Agent
  readonly source: 'already-live' | 'cold-resumed' | 'race-winner'
  readonly handle?: AgentHandle
}

/** Deterministic message identity shared across every retry of one notice. */
export function completionMessageId(notice: RecoveryCompletionNotice): MessageId {
  return MessageId(`dsh-autopilot:${notice.id}`)
}

/**
 * Fold inbox and turn events for one deterministic completion message.
 * A crash after claim but before an assistant response is retryable; a queued
 * message is never enqueued twice, and an answering assistant turn is durable
 * acknowledgement evidence.
 */
export function foldCompletionDelivery(
  events: readonly SessionEvent[],
  messageId: MessageId,
): CompletionDeliveryState {
  const pending: Record<'next-turn' | 'next-step', Array<{ readonly expected: boolean }>> = {
    'next-turn': [],
    'next-step': [],
  }
  let openTurn: number | undefined
  const claimedTurns = new Set<number>()
  const admittedTurns = new Set<number>()
  const answeredTurns = new Set<number>()
  const endedTurns = new Set<number>()
  const completedTurns = new Set<number>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        break
      case 'turn/end':
        endedTurns.add(event.data.turn)
        if (event.data.reason.kind === 'completed') completedTurns.add(event.data.turn)
        if (openTurn === event.data.turn) openTurn = undefined
        break
      case 'agent/inbox/spliced': {
        const queue = pending[event.data.target]
        const removed = queue.splice(
          event.data.start,
          event.data.removedCount ?? 0,
          ...event.data.inserted.map(message => ({
            expected: isCompletionMessage(message, messageId),
          })),
        )
        if (event.data.outcome !== 'canceled' && openTurn !== undefined
          && removed.some(message => message.expected)) {
          claimedTurns.add(openTurn)
        }
        break
      }
      case 'user/message':
        if (isCompletionMessage(event.data, messageId) && openTurn !== undefined) admittedTurns.add(openTurn)
        break
      case 'assistant/message':
        if (event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0)) {
          answeredTurns.add(event.data.turn)
        }
        break
      default:
        break
    }
  }
  for (const turn of claimedTurns) {
    if (admittedTurns.has(turn) && answeredTurns.has(turn) && completedTurns.has(turn)) {
      return { kind: 'answered', turn }
    }
  }
  if (Object.values(pending).some(queue => queue.some(message => message.expected))) {
    return { kind: 'pending' }
  }
  const activeClaim = [...claimedTurns].find(turn => !endedTurns.has(turn))
  return activeClaim === undefined
    ? { kind: 'absent' }
    : { kind: 'claimed', turn: activeClaim, admitted: admittedTurns.has(activeClaim) }
}

/** Reject a reused deterministic id whose logged message is not this plugin's notice. */
function isCompletionMessage(
  message: Extract<SessionEvent, { type: 'user/message' }>['data'],
  messageId: MessageId,
): boolean {
  if (message.id !== messageId || message.role !== 'user') return false
  const source = message.source as Partial<{ kind: string; plugin: string; form: string }>
  return source.kind === 'plugin' && source.plugin === 'dsh-autopilot' && source.form === 'notice'
}

/** Freeze one completion notice with an identity stable across process loss. */
export function completionMessage(notice: RecoveryCompletionNotice) {
  return freezeMessage({
    id: completionMessageId(notice),
    role: 'user' as const,
    content: [{
      type: 'text' as const,
      text: `Autopilot completion notice ${notice.id}: ${notice.summary}. Deliver the final user-facing completion report now.`,
    }],
    source: {
      kind: 'plugin' as const,
      plugin: 'dsh-autopilot',
      form: 'notice',
      summary: 'Autopilot completion report pending',
    },
  })
}

/** Project the immutable compare-and-set identity from a complete recovery row. */
export function recoveryRunRef(run: RecoveryRun): RecoveryRunRef {
  return {
    runId: run.runId,
    generation: run.generation,
    revision: run.revision,
    sessionId: run.sessionId,
  }
}

/**
 * Reconcile one durable Autopilot row with the strictly folded DSH Goal.
 *
 * Only `running` and `verifying` represent crash-disarmed work. Durable pause,
 * revoke, completion, exhaustion, and needs-attention states always require a
 * new human decision. A disagreement between the two durable sources fails
 * closed because neither source may be guessed authoritative.
 */
export function planRunRecovery(run: RecoveryRun, folded: FoldedGoal): RecoveryPlan {
  return planEligibleRecovery(run, folded)
}

/** Reconcile the session Goal after policy preflight accepted the run. */
function planEligibleRecovery(
  run: RecoveryRun,
  folded: FoldedGoal,
): RecoveryPlan {
  const goal = folded.goal
  if (goal === undefined) {
    if (run.phase === 'revoked') {
      return { kind: 'skip', code: 'revoked', reason: 'the revoked run has no current Goal' }
    }
    return { kind: 'needs-attention', reason: 'the session log has no current Goal' }
  }
  if (String(goal.id) !== run.goalId) {
    return {
      kind: 'needs-attention',
      reason: `sidecar Goal "${run.goalId}" does not match session Goal "${goal.id}"`,
    }
  }
  if (run.phase === 'finalizing') {
    if (run.finalization?.verdict !== 'pass') {
      return { kind: 'needs-attention', reason: 'finalizing sidecar has no passing verification record' }
    }
    if (goal.phase !== 'active' && goal.phase !== 'complete') {
      return {
        kind: 'needs-attention',
        reason: `finalizing sidecar conflicts with durable Goal phase "${goal.phase}"`,
      }
    }
    return {
      kind: 'finalize',
      goal: { id: goal.id, revision: goal.revision },
      goalPhase: goal.phase,
    }
  }
  if (run.phase === 'completed') {
    if (goal.phase === 'active') {
      return { kind: 'converge-completion', goal: { id: goal.id, revision: goal.revision } }
    }
    return goal.phase === 'complete'
      ? run.completionReported
        ? { kind: 'skip', code: 'completed', reason: 'the run and Goal are complete' }
        : { kind: 'completion-notice' }
      : { kind: 'needs-attention', reason: `completed sidecar conflicts with durable Goal phase "${goal.phase}"` }
  }
  if (run.phase === 'paused' || run.phase === 'revoked'
    || run.phase === 'exhausted' || run.phase === 'needs-attention') {
    if (run.phase === 'revoked') {
      return goal.phase === 'active' || goal.phase === 'paused' || goal.phase === 'blocked'
        ? {
            kind: 'converge-safety',
            goal: { id: goal.id, revision: goal.revision },
            phase: 'revoked',
          }
        : {
            kind: 'needs-attention',
            reason: `revoked sidecar conflicts with durable Goal phase "${goal.phase}"`,
          }
    }
    if (goal.phase === 'active') {
      return {
        kind: 'converge-safety',
        goal: { id: goal.id, revision: goal.revision },
        phase: run.phase,
      }
    }
    if (goal.phase === 'paused' || goal.phase === 'blocked') {
      const code = run.phase === 'paused' ? 'user-paused' : run.phase
      return { kind: 'skip', code, reason: `the ${run.phase} run and Goal are durably stopped` }
    }
    return {
      kind: 'needs-attention',
      reason: `sidecar phase "${run.phase}" conflicts with durable Goal phase "${goal.phase}"`,
    }
  }
  if (!run.autoResume) {
    return goal.phase === 'active'
      ? {
          kind: 'skip',
          code: 'auto-resume-disabled',
          reason: 'the run does not carry explicit automatic-recovery authorization',
        }
      : {
          kind: 'needs-attention',
          reason: `sidecar phase "${run.phase}" conflicts with durable Goal phase "${goal.phase}"`,
        }
  }
  if (goal.phase !== 'active') {
    return {
      kind: 'needs-attention',
      reason: `sidecar phase "${run.phase}" conflicts with durable Goal phase "${goal.phase}"`,
    }
  }
  if (folded.roundsStarted >= goal.maxGoalRounds) {
    return {
      kind: 'needs-attention',
      reason: `Goal round budget is exhausted (${folded.roundsStarted}/${goal.maxGoalRounds})`,
    }
  }
  return {
    kind: 'recover',
    goal: {
      id: goal.id,
      revision: goal.revision,
      roundsStarted: folded.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
    },
  }
}

/** Render an unknown thrown value for a durable attention record. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Ensure a resumed Agent still exposes the exact Goal the cold fold approved. */
function liveGoalMismatch(goal: GoalView | undefined, expected: RecoveryGoal): string | undefined {
  if (goal === undefined) return 'the resumed Agent has no current Goal'
  if (goal.id !== expected.id) {
    return `the resumed Agent exposes Goal "${goal.id}", expected "${expected.id}"`
  }
  if (goal.revision !== expected.revision || goal.roundsStarted !== expected.roundsStarted) {
    return 'the Goal changed while recovery was acquiring the Agent'
  }
  if (goal.phase !== 'active') return `the resumed Goal is durably ${goal.phase}`
  return undefined
}

/** Build preset-preserving setup for one cold session. */
function setupForInspection(ctx: Context, inspection: SessionInspection): AgentSetup | undefined {
  const presetId = resolveSessionPreset({ header: inspection.meta, events: inspection.events })
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    if (presetId !== undefined) {
      throw new Error(`session requires Agent preset "${presetId}", but agentPresets is unavailable`)
    }
    return undefined
  }
  return async (agentCtx) => {
    await presets.mount(agentCtx, presetId)
  }
}

/**
 * Own crash recovery for a set of sidecar rows.
 *
 * Handles created by this instance remain owned until {@link dispose}; live
 * Agents found before or during a publication race are borrowed and never
 * disposed here.
 */
export class AutopilotRecovery {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly inFlight = new Map<string, Promise<RecoveryReport | undefined>>()

  /**
   * @param ctx - Host context carrying persistence, Agent, Goal, and optional preset services.
   * @param controller - Durable sidecar reconciliation and activation methods.
   */
  constructor(
    private readonly ctx: Context,
    private readonly controller: RecoveryRunController,
    private readonly readinessAdmission?: RecoveryReadinessAdmission,
  ) {}

  /** Reconcile every latest sidecar row without letting one failed run stop the scan. */
  async recover(): Promise<readonly RecoveryReport[]> {
    const reports: RecoveryReport[] = []
    const rows = this.controller.currentRuns()
    for (const run of rows) {
      reports.push(await this.recoverRun(run))
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      const sidecars = new Set(rows.map(run => run.sessionId))
      for (const meta of await persistence.list()) {
        const sessionId = String(meta.id)
        if (sidecars.has(sessionId) || meta.origin === 'subagent') continue
        const report = await this.inspectOrphanStart(sessionId)
        if (report !== undefined) reports.push(report)
      }
    }
    return Object.freeze(reports)
  }

  /** Reconcile the latest row for one newly published same-host Agent. */
  async recoverSession(sessionId: string): Promise<RecoveryReport | undefined> {
    const run = this.controller.currentRuns().find(candidate => candidate.sessionId === sessionId)
    return run === undefined ? this.inspectOrphanStart(sessionId) : this.recoverRun(run)
  }

  /** Dispose only Agent handles this recovery owner created. */
  async dispose(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    const results = await Promise.allSettled(handles.map(handle => handle.dispose()))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose recovered Agents')
  }

  /** Serialize cold scan, self-resume re-entry, and same-host reopen per session. */
  private recoverRun(run: RecoveryRun): Promise<RecoveryReport> {
    const active = this.inFlight.get(run.sessionId)
    if (active !== undefined) return active as Promise<RecoveryReport>
    const task = this.recoverOne(run).finally(() => {
      this.inFlight.delete(run.sessionId)
    })
    this.inFlight.set(run.sessionId, task)
    return task
  }

  /** Surface an unmatched durable start without reconstructing omitted policy defaults. */
  private async inspectOrphanStart(sessionId: string): Promise<RecoveryReport | undefined> {
    const active = this.inFlight.get(sessionId)
    if (active !== undefined) return active
    const task = (async (): Promise<RecoveryReport | undefined> => {
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) return undefined
      const inspected = await persistence.inspect(SessionId(sessionId))
      const intent = foldPendingLifecycleIntent(inspected.events)
      if (intent?.command.kind !== 'start') return undefined
      return {
        sessionId,
        commandId: intent.commandId,
        outcome: 'needs-attention',
        reason: 'interrupted start has no sidecar with materialized policy; automatic recovery will not guess current defaults',
      }
    })().finally(() => {
      this.inFlight.delete(sessionId)
    })
    this.inFlight.set(sessionId, task)
    return task
  }

  private async recoverOne(run: RecoveryRun): Promise<RecoveryReport> {
    let ref = recoveryRunRef(run)
    let acquired: AcquiredAgent | undefined
    let readiness: RecoveryAttemptReadiness | undefined
    try {
      if (run.phase === 'running' || run.phase === 'verifying') {
        readiness = this.readinessAdmission?.checkpoint()
        readiness?.assertCurrent()
      }
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('sessionPersistence is unavailable')
      const inspection = await persistence.inspect(SessionId(run.sessionId))
      readiness?.assertCurrent()
      if (inspection.meta.origin === 'subagent') {
        throw new Error('the session belongs to subagent routing, not top-level Autopilot recovery')
      }
      const intent = foldPendingLifecycleIntent(inspection.events)
      if (intent !== undefined && intent.command.kind !== 'start') {
        readiness?.assertCurrent()
        acquired = await this.acquire(run, inspection)
        readiness?.assertCurrent()
        const settled = await this.controller.settleInterruptedLifecycle(ref, acquired.agent, intent)
        if (settled.kind === 'superseded') {
          const cleanup = await this.disposeTemporary(acquired)
          return cleanup === undefined
            ? { run: ref, outcome: 'skipped', reason: settled.reason }
            : await this.attention(ref, `${settled.reason}; recovered Agent cleanup failed: ${cleanup}`)
        }
        if (settled.kind === 'needs-attention') {
          const cleanup = await this.disposeTemporary(acquired)
          if (cleanup === undefined) return { run: ref, outcome: 'needs-attention', reason: settled.reason }
          return {
            run: ref, outcome: 'failed',
            reason: `${settled.reason}; recovered Agent cleanup failed: ${cleanup}`,
          }
        }
        ref = settled.run
        readiness?.assertCurrent()
        if (settled.kind === 'recovered') {
          if (acquired.handle !== undefined) this.handles.set(run.sessionId, acquired.handle)
          return { run: ref, outcome: 'recovered', agent: acquired.source }
        }
        const cleanup = await this.disposeTemporary(acquired)
        return cleanup === undefined
          ? { run: ref, outcome: 'skipped', reason: `interrupted ${intent.command.kind} intent settled` }
          : { run: ref, outcome: 'failed', reason: `lifecycle cleanup failed: ${cleanup}` }
      }

      const plan = planEligibleRecovery(run, foldGoal(inspection.events))
      if (plan.kind === 'needs-attention') return await this.attention(ref, plan.reason)
      if (plan.kind === 'skip') return { run: ref, outcome: 'skipped', reason: plan.reason }
      if (plan.kind === 'completion-notice') {
        acquired = await this.acquire(run, inspection)
        const notice = await this.controller.completionNotice(ref)
        if (notice === undefined) {
          const cleanup = await this.disposeTemporary(acquired)
          return cleanup === undefined
            ? { run: ref, outcome: 'skipped', reason: 'completion notice was already reported' }
            : { run: ref, outcome: 'failed', reason: `completion notice cleanup failed: ${cleanup}` }
        }
        await this.deliverCompletion(ref, acquired, notice)
        return { run: ref, outcome: 'completion-notice', notice }
      }

      readiness?.assertCurrent()
      acquired = await this.acquire(run, inspection)
      readiness?.assertCurrent()
      if (plan.kind === 'converge-safety' || plan.kind === 'converge-completion') {
        const converged = plan.kind === 'converge-safety'
          ? await this.controller.convergeSafetyState(ref, acquired.agent, plan.goal)
          : await this.controller.convergeCompletedGoal(ref, acquired.agent, plan.goal)
        if (converged.kind === 'superseded') {
          const cleanup = await this.disposeTemporary(acquired)
          return cleanup === undefined
            ? { run: ref, outcome: 'skipped', reason: converged.reason }
            : await this.attention(ref, `${converged.reason}; recovered Agent cleanup failed: ${cleanup}`)
        }
        if (converged.kind === 'needs-attention') {
          const cleanup = await this.disposeTemporary(acquired)
          if (cleanup === undefined) return { run: ref, outcome: 'needs-attention', reason: converged.reason }
          return {
            run: ref, outcome: 'failed',
            reason: `${converged.reason}; recovered Agent cleanup failed: ${cleanup}`,
          }
        }
        ref = converged.run
        if (plan.kind === 'converge-completion' && !run.completionReported) {
          const notice = await this.controller.completionNotice(ref)
          if (notice !== undefined) {
            await this.deliverCompletion(ref, acquired, notice)
            return { run: ref, outcome: 'completion-notice', notice }
          }
        }
        const cleanup = await this.disposeTemporary(acquired)
        return cleanup === undefined
          ? { run: ref, outcome: 'skipped', reason: `durable ${run.phase} state converged` }
          : { run: ref, outcome: 'failed', reason: `convergence cleanup failed: ${cleanup}` }
      }
      if (plan.kind === 'finalize') {
        const live = this.ctx.goals.get(acquired.agent)
        const mismatch = live === undefined || live.id !== plan.goal.id
          || live.revision !== plan.goal.revision || live.phase !== plan.goalPhase
          ? 'the Goal changed while recovery was finalizing verified completion'
          : undefined
        if (mismatch !== undefined) {
          const cleanup = await this.disposeTemporary(acquired)
          return await this.attention(ref, cleanup === undefined
            ? mismatch
            : `${mismatch}; recovered Agent cleanup failed: ${cleanup}`)
        }
        const finalized = await this.controller.finalizeRecovered(ref, acquired.agent, plan.goal)
        if (finalized.kind === 'superseded') {
          const cleanup = await this.disposeTemporary(acquired)
          return cleanup === undefined
            ? { run: ref, outcome: 'skipped', reason: finalized.reason }
            : await this.attention(ref, `${finalized.reason}; recovered Agent cleanup failed: ${cleanup}`)
        }
        if (finalized.kind === 'needs-attention') {
          const cleanup = await this.disposeTemporary(acquired)
          if (cleanup === undefined) return { run: ref, outcome: 'needs-attention', reason: finalized.reason }
          return {
            run: ref, outcome: 'failed',
            reason: `${finalized.reason}; recovered Agent cleanup failed: ${cleanup}`,
          }
        }
        ref = finalized.run
        if (finalized.notice !== undefined) {
          await this.deliverCompletion(ref, acquired, finalized.notice)
          return { run: ref, outcome: 'finalized', notice: finalized.notice }
        }
        const cleanup = await this.disposeTemporary(acquired)
        return cleanup === undefined
          ? { run: ref, outcome: 'finalized' }
          : { run: ref, outcome: 'failed', reason: `finalized run cleanup failed: ${cleanup}` }
      }

      const mismatch = liveGoalMismatch(this.ctx.goals.get(acquired.agent), plan.goal)
      if (mismatch !== undefined) {
        const cleanup = await this.disposeTemporary(acquired)
        return await this.attention(ref, cleanup === undefined
          ? mismatch
          : `${mismatch}; recovered Agent cleanup failed: ${cleanup}`)
      }

      const tasks = await this.controller.recoverInterruptedTasks(
        ref,
        acquired.agent,
        'host process restarted while task attempts were in progress',
      )
      if (tasks.kind === 'superseded') {
        const cleanup = await this.disposeTemporary(acquired)
        return cleanup === undefined
          ? { run: ref, outcome: 'skipped', reason: tasks.reason }
          : await this.attention(ref, `${tasks.reason}; recovered Agent cleanup failed: ${cleanup}`)
      }
      ref = tasks.run
      readiness?.assertCurrent()

      const recoveryGoal = {
        id: plan.goal.id,
        revision: plan.goal.revision,
      }
      const activated = readiness === undefined
        ? await this.controller.activateRecovered(ref, acquired.agent, recoveryGoal)
        : await this.controller.activateRecovered(ref, acquired.agent, recoveryGoal, readiness)
      switch (activated.kind) {
        case 'needs-attention': {
          const cleanup = await this.disposeTemporary(acquired)
          return cleanup === undefined
            ? { run: ref, outcome: 'needs-attention', reason: activated.reason }
            : {
                run: ref,
                outcome: 'failed',
                reason: `${activated.reason}; recovered Agent cleanup failed: ${cleanup}`,
              }
        }
        case 'superseded': {
          const cleanup = await this.disposeTemporary(acquired)
          if (cleanup !== undefined) {
            return await this.attention(
              ref,
              `recovery was superseded (${activated.reason}); recovered Agent cleanup failed: ${cleanup}`,
            )
          }
          return { run: ref, outcome: 'skipped', reason: activated.reason }
        }
        case 'recovered':
          break
      }
      const latest = this.controller.currentRuns().find(candidate => candidate.sessionId === ref.sessionId
        && candidate.runId === ref.runId && candidate.generation === ref.generation)
      if (latest !== undefined) ref = recoveryRunRef(latest)
      readiness?.assertCurrent()
      if (acquired.handle !== undefined) this.handles.set(run.sessionId, acquired.handle)
      return { run: ref, outcome: 'recovered', agent: acquired.source }
    } catch (error: unknown) {
      const cleanup = acquired === undefined ? undefined : await this.disposeTemporary(acquired)
      const reason = `automatic recovery failed: ${errorMessage(error)}`
      return await this.attention(ref, cleanup === undefined
        ? reason
        : `${reason}; recovered Agent cleanup failed: ${cleanup}`)
    }
  }

  private async acquire(run: RecoveryRun, inspection: SessionInspection): Promise<AcquiredAgent> {
    const sessionId = SessionId(run.sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return { agent: live, source: 'already-live' }

    const setup = setupForInspection(this.ctx, inspection)
    const racedBeforeResume = this.ctx.agents.get(sessionId)
    if (racedBeforeResume !== undefined) return { agent: racedBeforeResume, source: 'race-winner' }
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(setup === undefined ? {} : { setup }),
      })
      return { agent: handle.agent, source: 'cold-resumed', handle }
    } catch (error: unknown) {
      const winner = this.ctx.agents.get(sessionId)
      if (winner !== undefined) return { agent: winner, source: 'race-winner' }
      throw error
    }
  }

  private async disposeTemporary(acquired: AcquiredAgent): Promise<string | undefined> {
    if (acquired.handle === undefined) return undefined
    try {
      await acquired.handle.dispose()
      return undefined
    } catch (error: unknown) {
      return errorMessage(error)
    }
  }

  private async deliverCompletion(
    ref: RecoveryRunRef,
    acquired: AcquiredAgent,
    notice: RecoveryCompletionNotice,
  ): Promise<void> {
    const message = completionMessage(notice)
    const registration = await this.controller.registerCompletionDelivery(ref, acquired.agent, message.id)
    if (registration === 'reported') return
    const observed = foldCompletionDelivery(acquired.agent.session.events, message.id)
    // Pending inbox work is already durably queued. A claimed but unanswered
    // message is retried with the same identity because the crashed turn will
    // never produce the user-facing response.
    if (observed.kind === 'pending') {
      if (acquired.agent.inbox.remove(message.id)) acquired.agent.followup(message)
    } else if (observed.kind !== 'claimed') {
      acquired.agent.followup(message)
    }
    if (acquired.handle !== undefined) this.handles.set(ref.sessionId, acquired.handle)
  }

  private async attention(ref: RecoveryRunRef, reason: string): Promise<RecoveryReport> {
    try {
      await this.controller.markNeedsAttention(ref, reason)
      return { run: ref, outcome: 'needs-attention', reason }
    } catch (error: unknown) {
      const converged = this.controller.currentRuns().find(run => run.sessionId === ref.sessionId
        && run.runId === ref.runId && run.generation === ref.generation
        && run.phase === 'needs-attention')
      if (converged !== undefined) {
        return { run: recoveryRunRef(converged), outcome: 'needs-attention', reason }
      }
      return {
        run: ref,
        outcome: 'failed',
        reason: `${reason}; could not persist needs-attention: ${errorMessage(error)}`,
      }
    }
  }
}
