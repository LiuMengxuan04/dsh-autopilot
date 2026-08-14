/** Model-facing autonomy status, policy, and verifier tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AutonomyError } from './service.ts'

export const name = 'dsh-autopilot-tools'
export const inject = ['autonomy', 'goals', 'shell', 'systemPrompt', 'tools']

/** Deployment-authored deterministic verification command. */
export interface VerifierCheckConfig {
  /** Stable check name reported to models and humans. */
  name: string
  /** Fixed shell command; models cannot alter it. */
  command: string
  /** Optional cooperative timeout. */
  timeoutMs?: number
}

/** Model tool and verifier configuration. */
export interface Config {
  /** Minimum number of non-empty evidence notes a candidate must submit. */
  minimumEvidenceItems?: number
  /** Maximum output characters retained from each verifier stream. */
  maxOutputChars?: number
  /** Deployment-fixed deterministic checks. At least one is required. */
  checks?: VerifierCheckConfig[]
}

interface ResolvedCheck {
  readonly name: string
  readonly command: string
  readonly timeoutMs: number
}

interface ResolvedConfig {
  readonly minimumEvidenceItems: number
  readonly maxOutputChars: number
  readonly checks: readonly ResolvedCheck[]
}

export const Config = z.object({
  minimumEvidenceItems: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  maxOutputChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4000),
  checks: z.array(z.object({
    name: z.string(),
    command: z.string(),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(120_000),
  })).min(1),
}) as z<Config>

/** Resolve configuration and reject ambiguous verifier identity at load. */
function resolveConfig(config: Config): ResolvedConfig {
  const minimumEvidenceItems = config.minimumEvidenceItems ?? 1
  const maxOutputChars = config.maxOutputChars ?? 4000
  if (!Number.isSafeInteger(minimumEvidenceItems) || minimumEvidenceItems < 0) {
    throw new TypeError('minimumEvidenceItems must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new TypeError('maxOutputChars must be a positive safe integer')
  }
  if (config.checks === undefined || config.checks.length === 0) {
    throw new TypeError('checks must contain at least one deployment-fixed verifier command')
  }
  const names = new Set<string>()
  const checks = config.checks.map((check): ResolvedCheck => {
    const name = check.name.trim()
    const command = check.command.trim()
    const timeoutMs = check.timeoutMs ?? 120_000
    if (name.length === 0) throw new TypeError('verifier check name must not be empty')
    if (names.has(name)) throw new TypeError(`verifier check name "${name}" is duplicated`)
    names.add(name)
    if (command.length === 0) throw new TypeError(`verifier check "${name}" command must not be empty`)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError(`verifier check "${name}" timeoutMs must be a positive safe integer`)
    }
    return Object.freeze({ name, command, timeoutMs })
  })
  return Object.freeze({ minimumEvidenceItems, maxOutputChars, checks: Object.freeze(checks) })
}

/** Test whether an unknown value is an ordinary record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Convert a Goal view to its compare-and-set reference. */
function goalRef(goal: GoalView): { id: GoalView['id']; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

/** Require the Agent attached by the agent loop. */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Autopilot tools require an Agent-backed session')
  return exec.agent
}

/** Return a bounded tail without hiding whether truncation occurred. */
function outputPreview(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(-maxChars), truncated: true }
}

/** Render any canonical JSON tool value. */
function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Build a JSON-safe status snapshot. */
function statusValue(ctx: Context, agent: Agent): JsonValue {
  const goal = ctx.goals.get(agent)
  const lease = ctx.autonomy.get(agent)
  return {
    goal: goal === undefined ? null : {
      id: String(goal.id),
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      activation: goal.activation,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
    },
    lease: lease === undefined ? null : {
      id: lease.id,
      revision: lease.revision,
      goalId: String(lease.goalId),
      phase: lease.phase,
      remainingActiveMs: lease.remainingActiveMs,
      verificationAttempts: lease.verificationAttempts,
      maxVerificationAttempts: ctx.autonomy.limits.maxVerificationAttempts,
      dynamicPackages: lease.dynamicPackages,
      maxDynamicPackages: ctx.autonomy.limits.maxDynamicPackages,
      selfModification: lease.selfModification,
      ...(lease.reason === undefined ? {} : { reason: lease.reason }),
    },
  }
}

/** Describe one verifier outcome without exposing unbounded command output. */
function checkResult(
  check: ResolvedCheck,
  result: ShellRunResult,
  maxOutputChars: number,
): { [key: string]: JsonValue } {
  const stdout = outputPreview(result.stdout.text, maxOutputChars)
  const stderr = outputPreview(result.stderr.text, maxOutputChars)
  return {
    name: check.name,
    passed: result.exitCode === 0 && !result.timedOut && !result.aborted
      && result.sandbox?.runnerFailed !== true,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout,
    stderr,
    ...(result.sandbox === undefined ? {} : {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...(result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement }),
        ...(result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed }),
      },
    }),
  }
}

/** Key one dynamic Package receipt. */
function packageKey(pluginId: string, packageId: string): string {
  return `${pluginId}\u0000${packageId}`
}

/** Extract a dynamic Package reference from tool arguments. */
function packageReference(argumentsValue: unknown): { pluginId: string; packageId: string } | undefined {
  if (!isRecord(argumentsValue)) return undefined
  const pluginId = argumentsValue['pluginId']
  const packageId = argumentsValue['packageId']
  return typeof pluginId === 'string' && typeof packageId === 'string'
    ? { pluginId, packageId }
    : undefined
}

/** Build the monotonic autonomy guard. */
function guardExecution(
  ctx: Context,
  hostPackages: ReadonlyMap<Agent, ReadonlyMap<string, string>>,
  exec: ToolExecution,
): string | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const lease = ctx.autonomy.get(agent)
  if (lease === undefined || (lease.phase !== 'running' && lease.phase !== 'verifying')) return undefined

  if (lease.phase === 'verifying' && exec.name !== 'autopilot_verify') {
    return 'Autopilot verification is in progress; no additional tool may start until it settles.'
  }

  if (exec.name === 'update_goal' && isRecord(exec.arguments)
    && exec.arguments['action'] === 'complete') {
    return 'Autopilot completion is verifier-owned. Call autopilot_verify instead of update_goal complete.'
  }

  if (exec.name === 'cordis_define') {
    if (lease.selfModification === 'off') return 'Autopilot policy disables dynamic Cordis definitions.'
    if (lease.dynamicPackages >= ctx.autonomy.limits.maxDynamicPackages) {
      return `Autopilot dynamic Package budget exhausted (${ctx.autonomy.limits.maxDynamicPackages}).`
    }
    if (lease.selfModification === 'host-only') {
      const code = isRecord(exec.arguments) && isRecord(exec.arguments['code'])
        ? exec.arguments['code']
        : undefined
      if (code !== undefined && typeof code['client'] === 'string') {
        return 'This lease authorizes Host-only dynamic Cordis Packages; Client code still requires a separate human-approved policy.'
      }
    }
  }

  if (exec.name === 'cordis_run') {
    if (lease.selfModification === 'off') return 'Autopilot policy disables dynamic Cordis activation.'
    if (lease.selfModification === 'host-only') {
      const reference = packageReference(exec.arguments)
      if (reference === undefined
        || hostPackages.get(agent)?.get(packageKey(reference.pluginId, reference.packageId)) !== lease.id) {
        return 'Host-only autonomy may activate only a Package defined without Client code during this lease.'
      }
    }
  }
  return undefined
}

/** Return a canonical tool denial from the final atomic budget check. */
function autonomyDenial(message: string): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message,
      info: { name: 'AutonomyPolicyError', code: 'AUTONOMY_POLICY_DENIED' },
    },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

/** Register model-visible policy, status, completion, and Host-only Cordis accounting. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const hostPackages = new Map<Agent, Map<string, string>>()
  const pendingDefinitions = new Map<Agent, number>()

  ctx.systemPrompt.context({
    name: 'dsh-autopilot:autopilot',
    order: 160,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const lease = ctx.autonomy.get(agent)
      const goal = ctx.goals.get(agent)
      if (lease === undefined || goal === undefined
        || (lease.phase !== 'running' && lease.phase !== 'verifying')) return ''
      return [
        'Autopilot is authorized for the current Goal.',
        `Continue until the objective is independently verified; ${lease.remainingActiveMs} ms of active time remains.`,
        `Goal rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}.`,
        `Dynamic Cordis policy: ${lease.selfModification}; Packages: ${lease.dynamicPackages}/${ctx.autonomy.limits.maxDynamicPackages}.`,
        'Do not call update_goal with action complete. Submit a concise summary and concrete evidence to autopilot_verify.',
        'A failed verifier result ends this turn and starts another Goal round with its findings.',
      ].join(' ')
    },
  })

  ctx.tools.guard(exec => guardExecution(ctx, hostPackages, exec))

  ctx.on('tools/execute', async (
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    const agent = exec.agent
    if (agent === undefined || exec.name !== 'cordis_define') return next()
    const lease = ctx.autonomy.get(agent)
    if (lease === undefined || lease.phase !== 'running') return next()
    const pending = pendingDefinitions.get(agent) ?? 0
    if (lease.dynamicPackages + pending >= ctx.autonomy.limits.maxDynamicPackages) {
      return autonomyDenial(
        `Autopilot dynamic Package budget exhausted (${ctx.autonomy.limits.maxDynamicPackages}).`,
      )
    }
    pendingDefinitions.set(agent, pending + 1)
    try {
      return await next()
    } finally {
      const remaining = (pendingDefinitions.get(agent) ?? 1) - 1
      if (remaining === 0) pendingDefinitions.delete(agent)
      else pendingDefinitions.set(agent, remaining)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    hostPackages.delete(agent)
    pendingDefinitions.delete(agent)
  })
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (exec.agent === undefined || exec.name !== 'cordis_define' || result.isError) return
    const lease = ctx.autonomy.get(exec.agent)
    if (lease?.phase !== 'running') return
    if (!isRecord(result.value)) return
    const pluginId = result.value['pluginId']
    const packageId = result.value['packageId']
    const hasClientHalf = result.value['hasClientHalf']
    if (typeof pluginId !== 'string' || typeof packageId !== 'string') return
    try {
      ctx.autonomy.recordDynamicPackage(exec.agent)
      if (hasClientHalf === false) {
        const packages = hostPackages.get(exec.agent) ?? new Map<string, string>()
        packages.set(packageKey(pluginId, packageId), lease.id)
        hostPackages.set(exec.agent, packages)
      }
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-autopilot: could not account dynamic Package: ${String(error)}`)
    }
  })

  ctx.tools.register(defineTool({
    name: 'get_autopilot',
    description: 'Read the current Goal, Autopilot lease, budgets, and self-modification policy.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute(_args, exec) {
      return Promise.resolve(statusValue(ctx, requireAgent(exec)))
    },
    isConcurrencySafe: () => true,
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_verify',
    description: 'Submit completion evidence to deployment-fixed checks. Passing checks complete the Goal; failures start a repair round.',
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'Concise explanation of how the current workspace satisfies the Goal.',
      },
      evidence: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Concrete files, commands, test results, or other inspectable evidence.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const summary = args.summary.trim()
      const evidence = args.evidence.map(item => item.trim()).filter(item => item.length > 0)
      if (summary.length === 0) throw new Error('verification summary must not be empty')
      if (evidence.length < resolved.minimumEvidenceItems) {
        throw new Error(`verification requires at least ${resolved.minimumEvidenceItems} non-empty evidence item(s)`)
      }
      const goal = ctx.goals.get(agent)
      const lease = ctx.autonomy.get(agent)
      if (goal === undefined || lease === undefined || goal.id !== lease.goalId
        || goal.phase !== 'active' || goal.activation !== 'armed') {
        throw new Error('autopilot_verify requires the current armed Goal and its active lease')
      }

      try {
        ctx.autonomy.beginVerification(agent)
        ctx.goals.disarm(agent)
        const signal = AbortSignal.any([exec.signal, ctx.autonomy.signal(agent)])
        const checks: Array<{ [key: string]: JsonValue }> = []
        for (const check of resolved.checks) {
          const spec = ctx.shell.resolve({
            command: check.command,
            ...(agent.session.header.cwd === undefined ? {} : { workdir: agent.session.header.cwd }),
            timeoutMs: check.timeoutMs,
            stdoutMaxBytes: Math.max(1024, resolved.maxOutputChars * 4),
            signal,
          })
          const result = await ctx.shell.run(spec)
          checks.push(checkResult(check, result, resolved.maxOutputChars))
        }
        const failed = checks.filter(check => check['passed'] !== true)
        if (failed.length > 0) {
          const finding = `Verifier failed: ${failed.map(check => String(check['name'])).join(', ')}`
          ctx.autonomy.verificationFailed(agent, finding)
          const current = ctx.goals.get(agent)
          if (current?.id === goal.id && current.phase === 'active') {
            ctx.goals.resume(agent, goalRef(current))
          }
          exec.concludeTurn()
          return {
            verdict: 'fail',
            summary,
            evidence,
            checks,
            next: 'A new Goal round will repair the reported failures.',
          }
        }

        const current = ctx.goals.get(agent)
        if (current === undefined || current.id !== goal.id || current.phase !== 'active') {
          throw new Error('Goal changed while verification was running')
        }
        const completed = ctx.goals.complete(agent, goalRef(current))
        ctx.autonomy.complete(agent)
        exec.concludeTurn()
        return {
          verdict: 'pass',
          summary,
          evidence,
          checks,
          goal: { id: String(completed.id), revision: completed.revision, phase: completed.phase },
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const attemptsExhausted = error instanceof AutonomyError
          && error.code === 'AUTONOMY_VERIFICATION_EXHAUSTED'
        const currentLease = ctx.autonomy.get(agent)
        if (currentLease?.phase === 'verifying'
          || (attemptsExhausted && currentLease?.phase === 'running')) {
          ctx.autonomy.pause(agent, attemptsExhausted ? message : 'verifier infrastructure error')
        }
        const current = ctx.goals.get(agent)
        if (current?.id === goal.id && current.phase === 'active') {
          try {
            ctx.goals.block(agent, goalRef(current), {
              code: attemptsExhausted
                ? 'verification-attempts-exhausted'
                : 'verifier-error',
              message,
            })
          } catch (blockError: unknown) {
            ctx.logger.warn(`dsh-autopilot: could not block Goal after verifier error: ${String(blockError)}`)
            ctx.goals.disarm(agent)
          }
        }
        throw error
      }
    },
  }))
}
