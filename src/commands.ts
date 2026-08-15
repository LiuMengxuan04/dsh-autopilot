/** Human command plane for bounded autonomous Goals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  RecoveryReadinessError,
  registerRecoveryContribution,
} from './recovery-coordinator.ts'
import type { RecoveryReadinessCheckpoint } from './recovery-coordinator.ts'
import { RunStateError } from './run-state.ts'
import { parseLifecycleCommand } from './recovery.ts'
import { AutonomyError } from './service.ts'

export { parseDuration } from './recovery.ts'

export const name = 'dsh-autopilot-commands'
export const inject = [
  'agents',
  'autonomy',
  'autopilotRecoveryReadiness',
  'autopilotRunDashboard',
  'autopilotMissions',
  'commands',
  'goals',
  'sessions',
  'subagents',
  'tools',
]

/** Direct-human mission command syntax. */
export const MISSION_USAGE = [
  'Usage:',
  '/mission plan [--continue-on-error] <workspace-file>',
  '/mission status [mission-id]',
  '/mission resume <mission-id>',
  '/mission mark <mission-id> --task <task-id> --status <blocked|needs-human-review> --reason <text>',
  '/mission rerun <mission-id> --task <task-id>',
  '/mission audit [--limit N]',
].join('\n')

/** Parsed direct-human mission operation. */
export type ParsedMissionCommand =
  | { readonly kind: 'plan'; readonly path: string; readonly continueOnError: boolean }
  | { readonly kind: 'status'; readonly missionId?: string | undefined }
  | { readonly kind: 'resume'; readonly missionId: string }
  | {
    readonly kind: 'mark'
    readonly missionId: string
    readonly taskId: string
    readonly status: 'blocked' | 'needs-human-review'
    readonly reason: string
  }
  | { readonly kind: 'rerun'; readonly missionId: string; readonly taskId: string }
  | { readonly kind: 'audit'; readonly limit: number }
  | { readonly kind: 'invalid'; readonly message: string }

/** Command syntax shown in UI errors and discovery. */
export const AUTOPILOT_USAGE = [
  'Usage:',
  '/autopilot status',
  '/autopilot start [--rounds N] [--duration 7d] <objective>',
  '/autopilot pause',
  '/autopilot resume [--duration 7d]',
  '/autopilot stop',
  '/autopilot audit [--limit N] [--json]',
  '/autopilot dashboard',
].join('\n')

/** Parsed `/autopilot` operation. */
export type ParsedAutopilotCommand =
  | { readonly kind: 'status' }
  | {
    readonly kind: 'start'
    readonly objective: string
    readonly maxGoalRounds?: number
    readonly maxActiveMs?: number
  }
  | { readonly kind: 'pause' | 'stop' }
  | { readonly kind: 'resume'; readonly maxActiveMs?: number }
  | { readonly kind: 'audit'; readonly limit: number; readonly format: 'text' | 'json' }
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'invalid'; readonly message: string }

/** Parse a positive integer without accepting exponent or decimal syntax. */
function parseInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Parse bounded audit-rendering options. */
function parseAuditOptions(input: string): ParsedAutopilotCommand {
  const tokens = input.trim().length === 0 ? [] : input.trim().split(/\s+/u)
  let limit = 20
  let format: 'text' | 'json' = 'text'
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '--json') {
      if (format === 'json') return { kind: 'invalid', message: '--json may be supplied only once.' }
      format = 'json'
      continue
    }
    const inlineLimit = token?.startsWith('--limit=') === true ? token.slice('--limit='.length) : undefined
    if (token === '--limit' || inlineLimit !== undefined) {
      const value = inlineLimit ?? tokens[index + 1]
      if (inlineLimit === undefined) index += 1
      const parsed = value === undefined ? undefined : parseInteger(value)
      if (parsed === undefined || parsed > 200) {
        return { kind: 'invalid', message: '--limit requires a positive integer no greater than 200.' }
      }
      if (limit !== 20) return { kind: 'invalid', message: '--limit may be supplied only once.' }
      limit = parsed
      continue
    }
    return { kind: 'invalid', message: `Invalid audit option "${token}".` }
  }
  return { kind: 'audit', limit, format }
}

/** Tokenize direct-human command text with small shell-style quote semantics. */
function commandTokens(input: string): readonly string[] | undefined {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaping = false
  let active = false
  for (const character of input.trim()) {
    if (escaping) {
      token += character
      escaping = false
      active = true
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaping = true
      active = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
      active = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      active = true
      continue
    }
    if (/\s/u.test(character)) {
      if (active) {
        tokens.push(token)
        token = ''
        active = false
      }
      continue
    }
    token += character
    active = true
  }
  if (escaping || quote !== undefined) return undefined
  if (active) tokens.push(token)
  return Object.freeze(tokens)
}

function option(tokens: readonly string[], name: string): string | undefined {
  const index = tokens.indexOf(name)
  return index < 0 ? undefined : tokens[index + 1]
}

/** Parse text following the direct-human `/mission` command. */
export function parseMissionCommand(rawInput: string): ParsedMissionCommand {
  const tokens = commandTokens(rawInput)
  if (tokens === undefined) return { kind: 'invalid', message: 'Mission command contains an unclosed quote or escape.' }
  const [operation, ...rest] = tokens
  if (operation === undefined || operation === 'status') {
    if (rest.length > 1) return { kind: 'invalid', message: 'Mission status accepts at most one mission id.' }
    return { kind: 'status', ...(rest[0] === undefined ? {} : { missionId: rest[0] }) }
  }
  if (operation === 'plan') {
    const continueOnError = rest.includes('--continue-on-error')
    const paths = rest.filter(token => token !== '--continue-on-error')
    if (paths.length !== 1) return { kind: 'invalid', message: 'Mission plan requires exactly one workspace file.' }
    return { kind: 'plan', path: paths[0] as string, continueOnError }
  }
  if (operation === 'resume') {
    if (rest.length !== 1) return { kind: 'invalid', message: 'Mission resume requires exactly one mission id.' }
    return { kind: 'resume', missionId: rest[0] as string }
  }
  if (operation === 'audit') {
    if (rest.length === 0) return { kind: 'audit', limit: 20 }
    const value = option(rest, '--limit')
    const limit = value === undefined ? undefined : parseInteger(value)
    if (rest.length !== 2 || limit === undefined || limit > 200) {
      return { kind: 'invalid', message: 'Mission audit --limit requires an integer from 1 to 200.' }
    }
    return { kind: 'audit', limit }
  }
  if (operation === 'rerun') {
    const taskId = option(rest, '--task')
    if (rest.length !== 3 || rest[0] === '--task' || taskId === undefined) {
      return { kind: 'invalid', message: 'Mission rerun requires one mission id and --task <task-id>.' }
    }
    return { kind: 'rerun', missionId: rest[0] as string, taskId }
  }
  if (operation === 'mark') {
    const taskId = option(rest, '--task')
    const status = option(rest, '--status')
    const reasonIndex = rest.indexOf('--reason')
    const reason = reasonIndex < 0 ? undefined : rest.slice(reasonIndex + 1).join(' ').trim()
    const knownOptions = new Set(['--task', '--status', '--reason'])
    const optionIndexes = rest.flatMap((token, index) => knownOptions.has(token) ? [index] : [])
    if (rest[0] === undefined || rest[0].startsWith('--') || taskId === undefined
      || (status !== 'blocked' && status !== 'needs-human-review')
      || reason === undefined || reason.length === 0 || optionIndexes.length !== 3) {
      return { kind: 'invalid', message: 'Mission mark requires a mission id, task, status, and non-empty reason.' }
    }
    return { kind: 'mark', missionId: rest[0], taskId, status, reason }
  }
  return { kind: 'invalid', message: `Unknown mission operation "${operation}".` }
}

/**
 * Parse the text following `/autopilot`.
 * @param rawInput - Exact command input from DSH.
 * @returns Parsed operation or actionable syntax error.
 */
export function parseAutopilotCommand(rawInput: string): ParsedAutopilotCommand {
  const input = rawInput.trim()
  const normalized = input.toLowerCase()
  if (normalized === '' || normalized === 'status') return { kind: 'status' }
  if (normalized === 'dashboard') return { kind: 'dashboard' }

  const auditMatch = /^audit(?:\s+([\s\S]*))?$/iu.exec(input)
  if (auditMatch !== null) return parseAuditOptions(auditMatch[1] ?? '')

  const lifecycle = parseLifecycleCommand(input)
  if (lifecycle !== undefined) return lifecycle

  return { kind: 'invalid', message: 'Unknown autopilot operation.' }
}

/** Convert a Goal view to its compare-and-set reference. */
function goalRef(goal: GoalView): { id: GoalView['id']; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

/** Render milliseconds as a concise approximate duration. */
function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(ms % 86_400_000 === 0 ? 0 : 1)}d`
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)}h`
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(ms % 60_000 === 0 ? 0 : 1)}m`
  return `${Math.max(0, Math.ceil(ms / 1000))}s`
}

/** Render Goal and lease state for humans. */
function renderStatus(ctx: Context, agent: Agent): CommandResult {
  const goal = ctx.goals.get(agent)
  const lease = ctx.autonomy.get(agent)
  if (goal === undefined && lease === undefined) {
    return { kind: 'success', text: 'No current Goal or Autopilot lease.' }
  }
  const lines = goal === undefined
    ? ['Goal: absent']
    : [
        `Objective: ${goal.objective}`,
        `Goal: ${goal.phase} (${goal.activation})`,
        `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
      ]
  if (lease === undefined) {
    lines.push('Autopilot: disarmed (no process-local lease; human resume required)')
  } else {
    lines.push(
      `Autopilot: ${lease.phase} (${lease.activation})`,
      `Active time remaining: ${formatDuration(lease.remainingActiveMs)}`,
      `Verification attempts: ${lease.verificationAttempts}/${lease.maxVerificationAttempts}`,
      `Dynamic Packages: ${lease.dynamicPackages}/${lease.maxDynamicPackages}`,
      `Subagents: ${lease.subagentsStarted}/${lease.maxSubagents} (max ${lease.maxConcurrentSubagents} per managed dispatch)`,
      `Durable state: revision ${lease.revision}/${lease.maxAuditRecords}; tasks ${lease.plan?.tasks.length ?? 0}/${lease.maxTasks}`,
      `Self-modification: ${lease.selfModification}`,
    )
    if (lease.plan !== undefined) {
      const complete = lease.plan.tasks.filter(task => task.status === 'completed').length
      const blocked = lease.plan.tasks.filter(task => task.status === 'blocked' || task.status === 'failed').length
      lines.push(`Plan (${lease.plan.intent}): ${complete}/${lease.plan.tasks.length} tasks complete${blocked === 0 ? '' : `; ${blocked} blocked/failed`}`)
    } else {
      lines.push('Plan: not created')
    }
    if (lease.reason !== undefined) lines.push(`Reason: ${lease.reason}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** Render a bounded tail of the immutable sidecar audit for human inspection. */
function renderAudit(ctx: Context, agent: Agent, limit: number, format: 'text' | 'json'): CommandResult {
  const records = ctx.autonomy.history(agent).slice(-limit)
  if (records.length === 0) return { kind: 'success', text: 'No Autopilot audit records.' }
  if (format === 'json') return { kind: 'success', text: JSON.stringify(records, undefined, 2) }
  return {
    kind: 'success',
    text: records.map(record => [
      new Date(record.time).toISOString(),
      `rev=${record.snapshot.revision}`,
      `operation=${record.operation}`,
      `phase=${record.snapshot.phase}`,
      `run=${record.snapshot.runId}`,
    ].join(' ')).join('\n'),
  }
}

/** Normalize owned domain failures into direct command output. */
function commandFailure(error: unknown): CommandResult | undefined {
  if (error instanceof GoalError || error instanceof AutonomyError || error instanceof RecoveryReadinessError
    || error instanceof RunStateError) {
    return { kind: 'error', text: `${error.code}: ${error.message}` }
  }
  return undefined
}

/** Execute the model-safe mission surface from an already logged human command. */
async function executeMissionCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parseMissionCommand(invocation.rawInput)
  if (command.kind === 'invalid') return { kind: 'error', text: `${command.message}\n${MISSION_USAGE}` }
  const args = command.kind === 'plan'
    ? { action: 'plan', path: command.path, continueOnError: command.continueOnError }
    : command.kind === 'status'
      ? { action: 'status', ...(command.missionId === undefined ? {} : { missionId: command.missionId }) }
      : command.kind === 'resume'
        ? { action: 'resume', missionId: command.missionId }
        : command.kind === 'mark'
          ? {
              action: 'mark', missionId: command.missionId, taskId: command.taskId,
              status: command.status, reason: command.reason,
            }
          : command.kind === 'rerun'
            ? { action: 'rerun', missionId: command.missionId, taskId: command.taskId }
            : { action: 'audit', limit: command.limit }
  const result = await ctx.tools.execute({
    callId: CallId(`mission-command:${String(invocation.commandId)}`),
    name: 'autopilot_mission',
    arguments: args,
    agent: invocation.agent,
    signal: invocation.signal,
  })
  if (result.isError) return { kind: 'error', text: result.error.message }
  return { kind: 'success', text: JSON.stringify(result.value, undefined, 2) }
}

/** Convert one live lease view to the exact sidecar compare-and-set reference. */
function recoveryRef(agent: Agent, lease: NonNullable<ReturnType<Context['autonomy']['get']>>) {
  return {
    runId: lease.id,
    generation: lease.generation,
    revision: lease.revision,
    sessionId: String(agent.id),
  }
}

/** Leave neither half armed when a cross-store lifecycle step cannot finish. */
async function failClosed(
  ctx: Context,
  agent: Agent,
  goal: GoalView,
  message: string,
  cause: unknown,
): Promise<never> {
  const failures: unknown[] = [cause]
  const current = ctx.goals.get(agent)
  if (current?.id === goal.id && current.activation === 'armed') ctx.goals.disarm(agent)
  const lease = ctx.autonomy.get(agent)
  if (lease?.goalId === goal.id
    && lease.phase !== 'completed'
    && lease.phase !== 'revoked'
    && lease.phase !== 'needs-attention') {
    try {
      await ctx.autonomy.markNeedsAttention(recoveryRef(agent, lease), message)
    } catch (error: unknown) {
      const converged = ctx.autonomy.get(agent)
      if (converged?.goalId !== goal.id || converged.phase !== 'needs-attention') failures.push(error)
    }
  }
  if (failures.length === 1) throw cause
  throw new AggregateError(failures, message)
}

/** Execute one parsed human operation. */
async function executeCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  if (!ctx.agents.roots().includes(invocation.agent)) {
    return { kind: 'error', text: 'Autopilot can be controlled only from a top-level Agent.' }
  }
  const command = parseAutopilotCommand(invocation.rawInput)
  if (command.kind === 'invalid') {
    return { kind: 'error', text: `${command.message}\n${AUTOPILOT_USAGE}` }
  }
  if (command.kind === 'status') return renderStatus(ctx, invocation.agent)
  if (command.kind === 'audit') return renderAudit(ctx, invocation.agent, command.limit, command.format)
  if (command.kind === 'dashboard') {
    return {
      kind: 'success',
      text: await ctx.autopilotRunDashboard.render({ sessionId: String(invocation.agent.id) }),
    }
  }
  let readinessCheckpoint: RecoveryReadinessCheckpoint | undefined
  try {
    if (command.kind === 'start' || command.kind === 'resume') {
      readinessCheckpoint = ctx.autopilotRecoveryReadiness.checkpoint()
    }

    // command/run is the durable human intent. Do not touch Goal or sidecar
    // state until the public Session checkpoint confirms it reached storage.
    if (!await ctx.sessions.flush(invocation.agent.session)) {
      throw new Error('Autopilot lifecycle commands require configured session persistence')
    }
    invocation.signal.throwIfAborted()

    if (command.kind === 'start') {
      const descendants = await ctx.subagents.listDescendants(
        invocation.agent.id,
        invocation.signal,
      )
      const diagnostic = descendants.find(child => child.kind === 'diagnostic')
      if (diagnostic !== undefined) {
        throw new Error(`cannot inspect existing subagents: ${diagnostic.reason}`)
      }
      const runningDescendants = descendants.filter(child => child.kind === 'child' && child.activity === 'running')
      if (runningDescendants.length > 0) {
        throw new AutonomyError(
          `cannot start Autopilot while ${runningDescendants.length} descendant subagent(s) are still running`,
          'AUTONOMY_INVALID_TRANSITION',
        )
      }
      const rounds = ctx.autonomy.resolveGoalRounds(command.maxGoalRounds)
      const duration = ctx.autonomy.resolveDuration(command.maxActiveMs)
      const goal = ctx.goals.create(invocation.agent, {
        objective: command.objective,
        maxGoalRounds: rounds,
      })
      ctx.goals.disarm(invocation.agent)
      try {
        await ctx.autonomy.start(invocation.agent, { goalId: goal.id, maxActiveMs: duration })
      } catch (error: unknown) {
        const committed = ctx.autonomy.get(invocation.agent)
        if (committed?.goalId === goal.id) {
          await failClosed(
            ctx,
            invocation.agent,
            goal,
            `Autopilot start did not finish: ${String(error)}`,
            error,
          )
        } else {
          const current = ctx.goals.get(invocation.agent)
          if (current?.id === goal.id) {
            try {
              ctx.goals.clear(invocation.agent, goalRef(current))
            } catch (rollbackError: unknown) {
              throw new AggregateError([error, rollbackError], 'Autopilot start and Goal rollback both failed')
            }
          }
        }
        throw error
      }
      try {
        ctx.autopilotRecoveryReadiness.assertCurrent(
          readinessCheckpoint as RecoveryReadinessCheckpoint,
        )
        const current = ctx.goals.get(invocation.agent)
        if (current === undefined || current.id !== goal.id) {
          throw new Error('Goal disappeared before Autopilot activation')
        }
        ctx.goals.resume(invocation.agent, goalRef(current))
        ctx.autopilotRecoveryReadiness.assertCurrent(
          readinessCheckpoint as RecoveryReadinessCheckpoint,
        )
      } catch (error: unknown) {
        await failClosed(
          ctx,
          invocation.agent,
          goal,
          `Autopilot Goal activation failed: ${String(error)}`,
          error,
        )
      }
      return renderStatus(ctx, invocation.agent)
    }

    const lease = ctx.autonomy.get(invocation.agent)
    if (lease === undefined) {
      return { kind: 'error', text: `No Autopilot run.\n${AUTOPILOT_USAGE}` }
    }
    const goal = ctx.goals.get(invocation.agent)
    if (goal === undefined) {
      return command.kind === 'stop' && lease.phase === 'revoked'
        ? renderStatus(ctx, invocation.agent)
        : { kind: 'error', text: `The Autopilot Goal is unavailable.\n${AUTOPILOT_USAGE}` }
    }
    if (goal.id !== lease.goalId) {
      return { kind: 'error', text: 'The current Goal does not belong to the Autopilot run.' }
    }

    if (command.kind === 'resume') {
      ctx.autonomy.resolveDuration(command.maxActiveMs)
      const resumed = await ctx.autonomy.resume(invocation.agent, goal.id, command.maxActiveMs)
      try {
        ctx.autopilotRecoveryReadiness.assertCurrent(
          readinessCheckpoint as RecoveryReadinessCheckpoint,
        )
        if (resumed.phase === 'completed') return renderStatus(ctx, invocation.agent)
        const current = ctx.goals.get(invocation.agent)
        if (current === undefined || current.id !== goal.id) {
          throw new Error('Goal disappeared before Autopilot resume')
        }
        ctx.goals.resume(invocation.agent, goalRef(current))
        ctx.autopilotRecoveryReadiness.assertCurrent(
          readinessCheckpoint as RecoveryReadinessCheckpoint,
        )
      } catch (error: unknown) {
        await failClosed(
          ctx,
          invocation.agent,
          goal,
          `Autopilot Goal resume failed: ${String(error)}`,
          error,
        )
      }
      return renderStatus(ctx, invocation.agent)
    }

    if (command.kind === 'pause') {
      if (goal.activation === 'armed') ctx.goals.disarm(invocation.agent)
      if (lease.phase === 'running' || lease.phase === 'verifying') {
        await ctx.autonomy.pause(invocation.agent, 'paused by user')
      }
      const current = ctx.goals.get(invocation.agent)
      if (current?.phase === 'active') {
        try {
          ctx.goals.pause(invocation.agent, goalRef(current))
        } catch (error: unknown) {
          await failClosed(
            ctx,
            invocation.agent,
            goal,
            `Autopilot Goal pause failed: ${String(error)}`,
            error,
          )
        }
      }
      invocation.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return renderStatus(ctx, invocation.agent)
    }

    if (goal.activation === 'armed') ctx.goals.disarm(invocation.agent)
    if (lease.phase !== 'completed' && lease.phase !== 'revoked') {
      await ctx.autonomy.revoke(invocation.agent, 'stopped by user')
    }
    const current = ctx.goals.get(invocation.agent)
    if (current?.id === goal.id && current.phase !== 'complete') {
      try {
        ctx.goals.clear(invocation.agent, goalRef(current))
      } catch (error: unknown) {
        throw new AggregateError([error], 'Autopilot stopped but Goal cleanup failed')
      }
    }
    invocation.agent.cancel({ kind: 'user' })
    return renderStatus(ctx, invocation.agent)
  } catch (error: unknown) {
    return commandFailure(error) ?? Promise.reject(error)
  }
}

/** Register the profile-wide human command. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'autopilot',
    description: 'Control a bounded long-running autonomous Goal',
    input: { hint: '[status|start|pause|resume|stop|audit|dashboard] ...' },
    handler: invocation => executeCommand(ctx, invocation),
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'mission',
    description: 'Operate a durable file-backed sequential Autopilot mission',
    input: { hint: '[plan|status|resume|mark|rerun|audit] ...' },
    handler: invocation => executeMissionCommand(ctx, invocation),
  }))
  registerRecoveryContribution(ctx, 'commands')
}
