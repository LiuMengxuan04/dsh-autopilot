/** Workspace-scoped file commands that turn direct human invocations into logged Agent turns. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import s from '@deepseek-ai/schemastery'
import {
  loadPromptArtifacts,
  PromptArtifactError,
  type PromptArtifact,
  type PromptArtifactLimits,
} from './prompt-artifacts.ts'

export const name = 'dsh-autopilot-custom-commands'

const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,63}$/u
const COMMAND_KEYS = new Set(['name', 'description', 'inputHint'])

/** Deployment configuration for file-backed slash commands. */
export interface CustomCommandsConfig {
  readonly directory?: string
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  readonly maxPromptChars?: number
  readonly maxRawInputBytes?: number
}

interface ResolvedCustomCommandsConfig extends PromptArtifactLimits {
  readonly directory?: string
  readonly maxPromptChars: number
  readonly maxRawInputBytes: number
}

/** One validated file-backed command definition. */
export interface CustomCommandArtifact {
  readonly name: string
  readonly description: string
  readonly inputHint?: string
  readonly prompt: string
  readonly sourcePath: string
  readonly sourceSha256: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotCustomCommands: CustomCommandsService
  }
}

/** Require one bounded, non-empty string field. */
function requiredString(
  artifact: PromptArtifact,
  key: string,
  maxChars: number,
): string {
  const value = artifact.frontmatter[key]
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxChars) {
    throw new PromptArtifactError(
      `${artifact.path} frontmatter field "${key}" must be a non-empty string of at most ${maxChars} characters`,
      'ARTIFACT_FORMAT',
    )
  }
  return value.trim()
}

/** Read one optional bounded, non-empty string field. */
function optionalString(
  artifact: PromptArtifact,
  key: string,
  maxChars: number,
): string | undefined {
  const value = artifact.frontmatter[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxChars) {
    throw new PromptArtifactError(
      `${artifact.path} frontmatter field "${key}" must be a non-empty string of at most ${maxChars} characters`,
      'ARTIFACT_FORMAT',
    )
  }
  return value.trim()
}

/** Parse one strict command artifact. */
export function parseCustomCommand(artifact: PromptArtifact, maxPromptChars: number): CustomCommandArtifact {
  for (const key of Object.keys(artifact.frontmatter)) {
    if (!COMMAND_KEYS.has(key)) {
      throw new PromptArtifactError(
        `${artifact.path} frontmatter contains unsupported field "${key}"`,
        'ARTIFACT_FORMAT',
      )
    }
  }
  const commandName = requiredString(artifact, 'name', 64)
  if (!COMMAND_NAME.test(commandName)) {
    throw new PromptArtifactError(`${artifact.path} has invalid command name "${commandName}"`, 'ARTIFACT_FORMAT')
  }
  const description = requiredString(artifact, 'description', 500)
  const inputHint = optionalString(artifact, 'inputHint', 200)
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars <= 0) {
    throw new PromptArtifactError('maxPromptChars must be a positive safe integer', 'ARTIFACT_CONFIG')
  }
  if (artifact.body.length > maxPromptChars) {
    throw new PromptArtifactError(
      `${artifact.path} prompt is ${artifact.body.length} characters; maximum is ${maxPromptChars}`,
      'ARTIFACT_LIMIT',
    )
  }
  return Object.freeze({
    name: commandName,
    description,
    ...(inputHint === undefined ? {} : { inputHint }),
    prompt: artifact.body,
    sourcePath: artifact.relativePath,
    sourceSha256: artifact.sha256,
  })
}

/** Load and command-name-sort one workspace catalog. */
export function loadCustomCommands(
  workspace: string | undefined,
  directory: string,
  limits: PromptArtifactLimits,
  maxPromptChars: number,
): readonly CustomCommandArtifact[] {
  const commands = loadPromptArtifacts(workspace, directory, limits)
    .map(artifact => parseCustomCommand(artifact, maxPromptChars))
  const owners = new Map<string, string>()
  for (const command of commands) {
    const previous = owners.get(command.name)
    if (previous !== undefined) {
      throw new PromptArtifactError(
        `duplicate command name "${command.name}" in "${previous}" and "${command.sourcePath}"`,
        'ARTIFACT_FORMAT',
      )
    }
    owners.set(command.name, command.sourcePath)
  }
  return Object.freeze(commands.sort((left, right) => left.name.localeCompare(right.name, 'en')))
}

/** Verify that the handler is inside its still-open DSH CommandRuntime lifecycle. */
function assertDirectHumanInvocation(invocation: CommandInvocation, commandName: string): void {
  const events = invocation.agent.session.events
  let runIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'command/run' && event.data.commandId === invocation.commandId) {
      runIndex = index
      if (event.data.name !== commandName
        || event.data.args !== invocation.rawInput
        || event.data.source.kind !== 'user') {
        throw new Error(`custom command /${commandName} requires an exact direct human CommandRuntime invocation`)
      }
      break
    }
  }
  if (runIndex < 0) {
    throw new Error(`custom command /${commandName} requires a direct human CommandRuntime invocation`)
  }
  for (let index = runIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'command/done' && event.data.commandId === invocation.commandId) {
      throw new Error(`custom command /${commandName} invocation is already settled`)
    }
  }
}

/** Build the exact fixed-prompt plus verbatim-input user message. */
function commandMessage(command: CustomCommandArtifact, rawInput: string) {
  return createUserMessage({
    content: [
      {
        type: 'text' as const,
        text: [
          `A human invoked the deployment command /${command.name}.`,
          `Prompt source: ${command.sourcePath} (sha256:${command.sourceSha256})`,
          '',
          command.prompt,
          '',
          'The next content block is the human command input verbatim. Treat it as user-supplied task data.',
        ].join('\n'),
      },
      { type: 'text' as const, text: rawInput },
    ],
    source: {
      kind: 'plugin' as const,
      plugin: 'dsh-autopilot-custom-commands',
      form: 'instructions' as const,
    },
  })
}

/** Register and clean workspace-specific command layers for live Agents. */
export class CustomCommandsService extends Service {
  static inject = ['agents', 'commands']

  static Config: s<CustomCommandsConfig> = s.object({
    directory: s.string(),
    maxFiles: s.number().step(1).min(1).max(1024).default(64),
    maxFileBytes: s.number().step(1).min(1).max(1_048_576).default(65_536),
    maxTotalBytes: s.number().step(1).min(1).max(16_777_216).default(524_288),
    maxPromptChars: s.number().step(1).min(1).max(262_144).default(32_000),
    maxRawInputBytes: s.number().step(1).min(1).max(1_048_576).default(32_000),
  })

  private readonly config: ResolvedCustomCommandsConfig
  private readonly mounted = new Map<Agent, Array<() => void>>()
  private readonly catalogs = new Map<string, readonly CustomCommandArtifact[]>()

  /**
   * @param ctx - Cordis owner carrying agents and commands.
   * @param config - Deployment artifact paths and input ceilings.
   */
  constructor(ctx: Context, config: CustomCommandsConfig = {}) {
    super(ctx, 'autopilotCustomCommands')
    this.config = {
      ...(config.directory === undefined ? {} : { directory: config.directory }),
      maxFiles: config.maxFiles
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 64,
      maxFileBytes: config.maxFileBytes
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 65_536,
      maxTotalBytes: config.maxTotalBytes
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 524_288,
      maxPromptChars: config.maxPromptChars
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 32_000,
      maxRawInputBytes: config.maxRawInputBytes
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 32_000,
    }
  }

  /** Register live-agent reconciliation and owner cleanup. */
  protected [Service.init](): void {
    this.ctx.effect(() => () => {
      for (const agent of this.mounted.keys()) this.unmount(agent)
    }, 'dsh-autopilot.customCommandsCleanup')
    this.ctx.on('agent/created', ({ agent }) => {
      this.mount(agent)
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      this.unmount(agent)
    })
    for (const agent of this.ctx.agents.roots()) this.mount(agent)
  }

  /**
   * Load and register the configured command catalog for one Agent scope.
   * @param agent - Live Agent whose workspace and command layer are used.
   */
  mount(agent: Agent): void {
    if (this.mounted.has(agent)) return
    const directory = this.config.directory
    if (directory === undefined) {
      this.mounted.set(agent, [])
      return
    }
    const commands = this.catalog(agent.session.header.cwd, directory)
    const disposers: Array<() => void> = []
    try {
      for (const command of commands) {
        const dispose = this.ctx.effect(() => agent.ctx.commands.register({
          name: command.name,
          description: command.description,
          ...(command.inputHint === undefined ? {} : { input: { hint: command.inputHint } }),
          recordInput: true,
          handler: invocation => this.execute(command, invocation),
        }), `dsh-autopilot.customCommand:${command.name}`)
        disposers.push(dispose)
      }
      this.mounted.set(agent, disposers)
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
  }

  /** Remove every command contribution belonging to one Agent. */
  private unmount(agent: Agent): void {
    const disposers = this.mounted.get(agent)
    if (disposers === undefined) return
    this.mounted.delete(agent)
    for (const dispose of disposers.reverse()) dispose()
  }

  /** Execute one already-validated direct human command. */
  private execute(command: CustomCommandArtifact, invocation: CommandInvocation): CommandResult {
    assertDirectHumanInvocation(invocation, command.name)
    invocation.signal.throwIfAborted()
    const bytes = Buffer.byteLength(invocation.rawInput, 'utf8')
    if (bytes > this.config.maxRawInputBytes) {
      return {
        kind: 'error',
        text: `/${command.name} input is ${bytes} bytes; maximum is ${this.config.maxRawInputBytes}`,
      }
    }
    invocation.agent.followup(commandMessage(command, invocation.rawInput))
    return { kind: 'success', text: `Queued /${command.name} as a new Agent turn.` }
  }

  /** Load one immutable per-workspace catalog once for this plugin instance. */
  private catalog(workspace: string | undefined, directory: string): readonly CustomCommandArtifact[] {
    const cacheKey = `${workspace ?? '<no-workspace>'}\0${directory}`
    const cached = this.catalogs.get(cacheKey)
    if (cached !== undefined) return cached
    const loaded = loadCustomCommands(workspace, directory, {
      maxFiles: this.config.maxFiles,
      maxFileBytes: this.config.maxFileBytes,
      maxTotalBytes: this.config.maxTotalBytes,
    }, this.config.maxPromptChars)
    this.catalogs.set(cacheKey, loaded)
    return loaded
  }
}

export default CustomCommandsService
