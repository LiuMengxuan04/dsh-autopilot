import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { vi } from 'vitest'
import * as commandsPlugin from '../src/commands.ts'
import AutonomyService from '../src/service.ts'
import type { AutonomyServiceConfig } from '../src/service.ts'
import * as toolsPlugin from '../src/tools.ts'
import type { Config as ToolsConfig } from '../src/tools.ts'

/** Mutable deterministic shell backend for verifier tests. */
export class TestShell extends ShellExecutor {
  readonly requests: ShellExecSpec[] = []
  readonly outcomes: Array<ShellRunResult | Error> = []

  constructor(ctx: Context) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/test-workspace',
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 16_384,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.requests.push(spec)
    const outcome = this.outcomes.shift() ?? shellResult()
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('background shell is not used by verifier tests')
  }
}

/** Build a complete shell result with concise overrides. */
export function shellResult(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/** Create a registry-compatible top-level Agent. */
export function createTestAgent(rawId = `dsh-autopilot-${Math.random()}`, cwd?: string): Agent {
  const id = SessionId(rawId)
  const base = Session.create(id)
  const session = cwd === undefined
    ? base
    : Session.create(id, [], { ...base.header, cwd })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send() {},
    followup() {},
    steer() {},
    inject(message) { inbox.append('next-step', message) },
    cancel: vi.fn(),
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Fully assembled host services used by command and tool integration tests. */
export async function createHarness(options: {
  autonomy?: AutonomyServiceConfig
  tools?: ToolsConfig
} = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TestShell)
  const autonomyFiber = await ctx.plugin(AutonomyService, options.autonomy ?? {})
  await ctx.plugin(commandsPlugin)
  await ctx.plugin(toolsPlugin, options.tools ?? {
    checks: [{ name: 'quality', command: 'pnpm test', timeoutMs: 5000 }],
  })
  const agent = createTestAgent()
  ctx.agents.register(agent)
  return { ctx, agent, shell: ctx.shell as TestShell, autonomyFiber }
}
