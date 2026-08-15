/** Conditional, workspace-scoped prompt rules selected by explicitly accessed paths. */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ToolExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import {
  loadPromptArtifacts,
  PromptArtifactError,
  type PromptArtifact,
  type PromptArtifactLimits,
} from './prompt-artifacts.ts'

export const name = 'dsh-autopilot-prompt-rules'

const RULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const RULE_KEYS = new Set(['id', 'description', 'globs'])
const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

/** Deployment configuration for conditional prompt rules. */
export interface PromptRulesConfig {
  readonly directory?: string
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  readonly maxContextChars?: number
  readonly maxNotedPaths?: number
}

interface ResolvedPromptRulesConfig extends PromptArtifactLimits {
  readonly directory?: string
  readonly maxContextChars: number
  readonly maxNotedPaths: number
}

/** One validated conditional rule. */
export interface PromptRule {
  readonly id: string
  readonly description: string
  readonly globs: readonly string[]
  readonly content: string
  readonly sourcePath: string
  readonly sourceSha256: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotPromptRules: PromptRulesService
  }
}

/** Require one bounded non-empty string from frontmatter. */
function requiredString(
  frontmatter: Readonly<Record<string, unknown>>,
  key: string,
  sourcePath: string,
  maxChars: number,
): string {
  const value = frontmatter[key]
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxChars) {
    throw new PromptArtifactError(
      `${sourcePath} frontmatter field "${key}" must be a non-empty string of at most ${maxChars} characters`,
      'ARTIFACT_FORMAT',
    )
  }
  return value.trim()
}

/** Convert path separators to the slash form used by rule globs. */
function slashPath(value: string): string {
  return value.split(sep).join('/').replaceAll('\\', '/')
}

/** Validate one finite-glob pattern and normalize its leading `./`. */
export function normalizePromptGlob(input: string): string {
  const normalized = slashPath(input.trim()).replace(/^\.\//u, '')
  if (normalized.length === 0 || normalized.length > 256 || normalized.includes('\0')) {
    throw new PromptArtifactError('rule glob must contain 1-256 characters without NUL bytes', 'ARTIFACT_FORMAT')
  }
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new PromptArtifactError(`rule glob "${input}" must stay relative to the Agent workspace`, 'ARTIFACT_PATH')
  }
  if (normalized.includes('***') || /[[\]{}!]/u.test(normalized)) {
    throw new PromptArtifactError(
      `rule glob "${input}" uses unsupported syntax; supported wildcards are *, **, and ?`,
      'ARTIFACT_FORMAT',
    )
  }
  return normalized
}

/** Escape one regular-expression literal character. */
function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character
}

/** Compile the documented finite `*`, `**`, and `?` glob language. */
function globRegex(glob: string): RegExp {
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] as string
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
      continue
    }
    if (character === '*') {
      source += '[^/]*'
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += escapeRegex(character)
  }
  return new RegExp(`${source}$`, 'u')
}

/** Match one normalized workspace-relative path against the finite glob language. */
export function matchesPromptGlob(glob: string, workspacePath: string): boolean {
  return globRegex(normalizePromptGlob(glob)).test(slashPath(workspacePath))
}

/** Normalize an explicitly accessed path and reject workspace escape. */
export function normalizeNotedPath(workspace: string | undefined, input: string): string {
  if (workspace === undefined || !isAbsolute(workspace)) {
    throw new PromptArtifactError('conditional rules require an absolute Agent workspace', 'ARTIFACT_CONFIG')
  }
  if (input.length === 0 || input.length > 4096 || input.includes('\0')) {
    throw new PromptArtifactError('noted path must contain 1-4096 characters without NUL bytes', 'ARTIFACT_PATH')
  }
  const portable = input.replaceAll('\\', sep)
  const absolute = isAbsolute(portable) ? resolve(portable) : resolve(workspace, portable)
  const suffix = relative(resolve(workspace), absolute)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new PromptArtifactError(`noted path "${input}" escapes Agent workspace`, 'ARTIFACT_PATH')
  }
  return slashPath(suffix === '' ? '.' : suffix)
}

/** Parse one strict rule artifact. */
export function parsePromptRule(artifact: PromptArtifact): PromptRule {
  for (const key of Object.keys(artifact.frontmatter)) {
    if (!RULE_KEYS.has(key)) {
      throw new PromptArtifactError(
        `${artifact.path} frontmatter contains unsupported field "${key}"`,
        'ARTIFACT_FORMAT',
      )
    }
  }
  const id = requiredString(artifact.frontmatter, 'id', artifact.path, 64)
  if (!RULE_ID.test(id)) {
    throw new PromptArtifactError(`${artifact.path} has invalid kebab-case rule id "${id}"`, 'ARTIFACT_FORMAT')
  }
  const description = requiredString(artifact.frontmatter, 'description', artifact.path, 500)
  const rawGlobs = artifact.frontmatter.globs
  if (!Array.isArray(rawGlobs) || rawGlobs.length === 0 || rawGlobs.length > 32) {
    throw new PromptArtifactError(`${artifact.path} globs must be an array of 1-32 strings`, 'ARTIFACT_FORMAT')
  }
  const globs = rawGlobs.map((glob) => {
    if (typeof glob !== 'string') {
      throw new PromptArtifactError(`${artifact.path} globs must contain only strings`, 'ARTIFACT_FORMAT')
    }
    return normalizePromptGlob(glob)
  })
  if (new Set(globs).size !== globs.length) {
    throw new PromptArtifactError(`${artifact.path} contains duplicate globs`, 'ARTIFACT_FORMAT')
  }
  return Object.freeze({
    id,
    description,
    globs: Object.freeze(globs),
    content: artifact.body,
    sourcePath: artifact.relativePath,
    sourceSha256: artifact.sha256,
  })
}

/** Load and name-sort one workspace's rule catalog. */
export function loadPromptRules(
  workspace: string | undefined,
  directory: string,
  limits: PromptArtifactLimits,
): readonly PromptRule[] {
  const rules = loadPromptArtifacts(workspace, directory, limits).map(parsePromptRule)
  const owners = new Map<string, string>()
  for (const rule of rules) {
    const previous = owners.get(rule.id)
    if (previous !== undefined) {
      throw new PromptArtifactError(
        `duplicate rule id "${rule.id}" in "${previous}" and "${rule.sourcePath}"`,
        'ARTIFACT_FORMAT',
      )
    }
    owners.set(rule.id, rule.sourcePath)
  }
  return Object.freeze(rules.sort((left, right) => left.id.localeCompare(right.id, 'en')))
}

/** Bound one complete rule contribution without splitting its metadata. */
function boundedRuleEntry(rule: PromptRule, paths: readonly string[], maxChars: number): string {
  const prefix = [
    `### Rule: ${rule.id}`,
    rule.description,
    `Matched paths: ${paths.join(', ')}`,
    `Source: ${rule.sourcePath} (sha256:${rule.sourceSha256})`,
    '',
  ].join('\n')
  const suffix = '\n\n[Rule content truncated by deployment context limit.]'
  if (prefix.length + rule.content.length <= maxChars) return `${prefix}${rule.content}`
  if (prefix.length + suffix.length >= maxChars) {
    const keptPrefix = Math.max(0, maxChars - suffix.length)
    return `${prefix.slice(0, keptPrefix)}${suffix.slice(0, maxChars - keptPrefix)}`
  }
  const available = Math.max(0, maxChars - prefix.length - suffix.length)
  return `${prefix}${rule.content.slice(0, available)}${suffix}`
}

/** Extract the explicit file operand from one successful filesystem tool call. */
function filePathFromExecution(exec: Readonly<ToolExecution>): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const path = exec.arguments.file_path.trim()
  return path.length === 0 ? undefined : path
}

/** Host service selecting conditional rules for each Agent turn. */
export class PromptRulesService extends Service {
  static inject = ['systemPrompt', 'tools']

  static Config: s<PromptRulesConfig> = s.object({
    directory: s.string(),
    maxFiles: s.number().step(1).min(1).max(1024).default(64),
    maxFileBytes: s.number().step(1).min(1).max(1_048_576).default(65_536),
    maxTotalBytes: s.number().step(1).min(1).max(16_777_216).default(524_288),
    maxContextChars: s.number().step(1).min(256).max(262_144).default(32_000),
    maxNotedPaths: s.number().step(1).min(1).max(4096).default(256),
  })

  private readonly config: ResolvedPromptRulesConfig
  private readonly noted = new WeakMap<Agent, Set<string>>()
  private readonly catalogs = new Map<string, readonly PromptRule[]>()
  private readonly executionTouches = new Map<ToolExecutionToken, Array<{ agent: Agent; path: string }>>()

  /**
   * @param ctx - Cordis owner carrying system-prompt.
   * @param config - Deployment artifact paths and ceilings.
   */
  constructor(ctx: Context, config: PromptRulesConfig = {}) {
    super(ctx, 'autopilotPromptRules')
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
      maxContextChars: config.maxContextChars
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 32_000,
      maxNotedPaths: config.maxNotedPaths
        /* v8 ignore next -- Cordis materializes schema defaults before construction. */
        ?? 256,
    }
  }

  /** Register the reconstructable dynamic-context provider and turn cleanup. */
  protected [Service.init](): void {
    this.ctx.effect(() => () => {
      this.executionTouches.clear()
    })
    this.ctx.effect(() => this.ctx.systemPrompt.context({
      name: 'dsh-autopilot:conditional-rules',
      order: 150,
      text: ({ agent }) => agent === undefined ? '' : this.contextFor(agent),
    }))
    this.ctx.on('agent/turn-stopping', ({ agent }) => {
      this.noted.delete(agent)
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      this.noted.delete(agent)
    })
    this.ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
      const touches = this.executionTouches.get(exec.token) ?? []
      this.executionTouches.delete(exec.token)
      if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
        const path = filePathFromExecution(exec)
        if (path !== undefined) touches.push({ agent: exec.agent, path })
      }
      if (exec.parent !== undefined) {
        if (touches.length > 0) {
          const parentTouches = this.executionTouches.get(exec.parent)
          if (parentTouches === undefined) this.executionTouches.set(exec.parent, touches)
          else parentTouches.push(...touches)
        }
        return
      }
      for (const touch of touches) this.notePath(touch.agent, touch.path)
    })
  }

  /**
   * Record one path that a trusted Host listener observed the Agent access or edit.
   * @param agent - Exact Agent whose current turn accessed the path.
   * @param path - Absolute or workspace-relative file path.
   */
  notePath(agent: Agent, path: string): void {
    const normalized = normalizeNotedPath(agent.session.header.cwd, path)
    const paths = this.noted.get(agent) ?? new Set<string>()
    if (!paths.has(normalized) && paths.size >= this.config.maxNotedPaths) {
      throw new PromptArtifactError(
        `Agent turn noted more than ${this.config.maxNotedPaths} distinct paths`,
        'ARTIFACT_LIMIT',
      )
    }
    paths.add(normalized)
    this.noted.set(agent, paths)
  }

  /**
   * Render the bounded context for exactly the rules matching this turn's paths.
   * @param agent - Agent whose assembly is being built.
   * @returns Empty text when no explicitly noted path matches.
   */
  contextFor(agent: Agent): string {
    const directory = this.config.directory
    const noted = this.noted.get(agent)
    if (directory === undefined || noted === undefined || noted.size === 0) return ''
    // `noted` can be populated only by notePath(), which requires this exact
    // Agent to carry an absolute workspace.
    const workspace = agent.session.header.cwd as string
    const rules = this.catalog(workspace, directory)
    const paths = [...noted].sort()
    const matching = rules.map(rule => ({
      rule,
      paths: paths.filter(path => rule.globs.some(glob => matchesPromptGlob(glob, path))),
    })).filter(match => match.paths.length > 0)
    if (matching.length === 0) return ''

    const header = 'Conditional project rules matching files explicitly accessed in the current Agent turn.'
    const chunks = [header]
    let used = header.length
    for (const match of matching) {
      const remaining = this.config.maxContextChars - used - 2
      if (remaining <= 0) break
      const entry = boundedRuleEntry(match.rule, match.paths, remaining)
      chunks.push(entry)
      used += entry.length + 2
    }
    return chunks.join('\n\n').slice(0, this.config.maxContextChars)
  }

  /** Load one immutable per-workspace catalog once for this plugin instance. */
  private catalog(workspace: string, directory: string): readonly PromptRule[] {
    const cacheKey = `${workspace}\0${directory}`
    const cached = this.catalogs.get(cacheKey)
    if (cached !== undefined) return cached
    const loaded = loadPromptRules(workspace, directory, {
      maxFiles: this.config.maxFiles,
      maxFileBytes: this.config.maxFileBytes,
      maxTotalBytes: this.config.maxTotalBytes,
    })
    this.catalogs.set(cacheKey, loaded)
    return loaded
  }
}

export default PromptRulesService
