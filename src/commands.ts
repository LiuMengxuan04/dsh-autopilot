/** Human command plane for bounded autonomous Goals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { AutonomyError } from './service.ts'

export const name = 'dsh-autopilot-commands'
export const inject = ['agents', 'autonomy', 'commands', 'goals']

/** Command syntax shown in UI errors and discovery. */
export const AUTOPILOT_USAGE = [
  'Usage:',
  '/autopilot status',
  '/autopilot start [--rounds N] [--duration 7d] <objective>',
  '/autopilot pause',
  '/autopilot resume [--duration 7d]',
  '/autopilot stop',
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
  | { readonly kind: 'invalid'; readonly message: string }

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
  /* v8 ignore next -- the regular expression restricts unit to the complete multiplier key set. */
  if (multiplier === undefined) return undefined
  const duration = amount * multiplier
  return Number.isSafeInteger(duration) ? duration : undefined
}

interface StartOptions {
  readonly rest: string
  readonly maxGoalRounds?: number
  readonly maxActiveMs?: number
  readonly error?: string
}

/** Parse leading start options while preserving the objective remainder verbatim. */
function parseStartOptions(input: string, allowRounds: boolean): StartOptions {
  let rest = input.trimStart()
  let maxGoalRounds: number | undefined
  let maxActiveMs: number | undefined
  while (rest.startsWith('--')) {
    const option = /^--(rounds|duration)(?:=([^\s]+)|\s+([^\s]+))(?:\s+|$)/u.exec(rest)
    if (option === null) {
      const [optionToken] = rest.split(/\s/u, 1)
      /* v8 ignore next -- splitting a non-empty string with limit one always yields its first token. */
      if (optionToken === undefined) return { rest, error: 'Invalid autopilot option.' }
      return { rest, error: `Invalid option near "${optionToken}".` }
    }
    const optionName = option[1]
    const optionValue = option[2] ?? option[3]
    /* v8 ignore next 3 -- the matched expression requires the option name and exactly one value capture. */
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

/**
 * Parse the text following `/autopilot`.
 * @param rawInput - Exact command input from DSH.
 * @returns Parsed operation or actionable syntax error.
 */
export function parseAutopilotCommand(rawInput: string): ParsedAutopilotCommand {
  const input = rawInput.trim()
  const normalized = input.toLowerCase()
  if (normalized === '' || normalized === 'status') return { kind: 'status' }
  if (normalized === 'pause') return { kind: 'pause' }
  if (normalized === 'stop') return { kind: 'stop' }

  const resumeMatch = /^resume(?:\s+([\s\S]*))?$/iu.exec(input)
  if (resumeMatch !== null) {
    const options = parseStartOptions(resumeMatch[1] ?? '', false)
    if (options.error !== undefined) return { kind: 'invalid', message: options.error }
    if (options.rest.length > 0) return { kind: 'invalid', message: '`resume` accepts only `--duration`.' }
    return {
      kind: 'resume',
      ...(options.maxActiveMs === undefined ? {} : { maxActiveMs: options.maxActiveMs }),
    }
  }

  const startMatch = /^start(?:\s+([\s\S]*))?$/iu.exec(input)
  if (startMatch !== null) {
    const options = parseStartOptions(startMatch[1] ?? '', true)
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
  if (goal === undefined) return { kind: 'success', text: 'No current Goal or Autopilot lease.' }
  const lines = [
    `Objective: ${goal.objective}`,
    `Goal: ${goal.phase} (${goal.activation})`,
    `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
  ]
  if (lease === undefined) {
    lines.push('Autopilot: disarmed (no process-local lease; human resume required)')
  } else {
    lines.push(
      `Autopilot: ${lease.phase}`,
      `Active time remaining: ${formatDuration(lease.remainingActiveMs)}`,
      `Verification attempts: ${lease.verificationAttempts}/${ctx.autonomy.limits.maxVerificationAttempts}`,
      `Dynamic Packages: ${lease.dynamicPackages}/${ctx.autonomy.limits.maxDynamicPackages}`,
      `Self-modification: ${lease.selfModification}`,
    )
    if (lease.reason !== undefined) lines.push(`Reason: ${lease.reason}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** Normalize owned domain failures into direct command output. */
function commandFailure(error: unknown): CommandResult | undefined {
  if (error instanceof GoalError || error instanceof AutonomyError) {
    return { kind: 'error', text: `${error.code}: ${error.message}` }
  }
  return undefined
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

  try {
    if (command.kind === 'start') {
      const rounds = ctx.autonomy.resolveGoalRounds(command.maxGoalRounds)
      const duration = ctx.autonomy.resolveDuration(command.maxActiveMs)
      const goal = ctx.goals.create(invocation.agent, {
        objective: command.objective,
        maxGoalRounds: rounds,
      })
      try {
        ctx.autonomy.start(invocation.agent, { goalId: goal.id, maxActiveMs: duration })
      } catch (error: unknown) {
        ctx.goals.pause(invocation.agent, goalRef(goal))
        throw error
      }
      return renderStatus(ctx, invocation.agent)
    }

    const goal = ctx.goals.get(invocation.agent)
    if (goal === undefined) return { kind: 'error', text: `No current Goal.\n${AUTOPILOT_USAGE}` }

    if (command.kind === 'resume') {
      ctx.autonomy.resolveDuration(command.maxActiveMs)
      ctx.autonomy.resume(invocation.agent, goal.id, command.maxActiveMs)
      try {
        ctx.goals.resume(invocation.agent, goalRef(goal))
      } catch (error: unknown) {
        ctx.autonomy.pause(invocation.agent, 'Goal resume failed')
        throw error
      }
      return renderStatus(ctx, invocation.agent)
    }

    if (goal.phase === 'active') ctx.goals.pause(invocation.agent, goalRef(goal))
    const lease = ctx.autonomy.get(invocation.agent)
    if (command.kind === 'pause') {
      if (lease !== undefined && (lease.phase === 'running' || lease.phase === 'verifying')) {
        ctx.autonomy.pause(invocation.agent, 'paused by user')
      }
      invocation.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return renderStatus(ctx, invocation.agent)
    }

    if (lease !== undefined && lease.phase !== 'completed' && lease.phase !== 'revoked') {
      ctx.autonomy.revoke(invocation.agent, 'stopped by user')
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
    input: { hint: '[status|start|pause|resume|stop] ...' },
    handler: invocation => executeCommand(ctx, invocation),
  }))
}
