/** AST-aware search/rewrite and stale-safe hash-line editing over DSH filesystem tools. */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { Lang, parse, pattern } from '@ast-grep/napi'
import type { SgNode } from '@ast-grep/napi'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { registerRecoveryContribution } from './recovery-coordinator.ts'

export const name = 'dsh-autopilot-code-intelligence'
export const inject = ['autonomy', 'fs', 'goals', 'tools']

/** Languages supported by the bundled ast-grep native parser. */
export type CodeLanguage = 'css' | 'html' | 'javascript' | 'tsx' | 'typescript'

/** One bounded structural match returned to the model. */
export interface AstMatch {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
  readonly text: string
  readonly textSha256: string
}

/** One line carrying the hash required by a subsequent anchored edit. */
export interface HashedLine {
  readonly line: number
  readonly hash: string
  readonly text: string
  readonly truncated: boolean
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = Object.freeze({
  '.css': 'css',
  '.htm': 'html',
  '.html': 'html',
  '.js': 'javascript',
  '.jsx': 'tsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
})

const AST_LANGUAGE: Readonly<Record<CodeLanguage, Lang>> = Object.freeze({
  css: Lang.Css,
  html: Lang.Html,
  javascript: Lang.JavaScript,
  tsx: Lang.Tsx,
  typescript: Lang.TypeScript,
})

const META_VARIABLE = /\$\$\$[A-Z][A-Z0-9_]*|\$[A-Z][A-Z0-9_]*/gu

/** Return a stable complete SHA-256 digest. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Resolve an explicit or extension-derived parser language. */
export function resolveCodeLanguage(path: string, explicit?: CodeLanguage): CodeLanguage {
  if (explicit !== undefined) return explicit
  const detected = LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]
  if (detected === undefined) {
    throw new Error(`cannot infer an AST language for ${JSON.stringify(path)}; supply language explicitly`)
  }
  return detected
}

function clipped(value: string, max: number): { readonly text: string; readonly truncated: boolean } {
  return value.length <= max
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, max)}…`, truncated: true }
}

/** Search one source file with a structural ast-grep pattern. */
export function searchAst(
  source: string,
  language: CodeLanguage,
  structuralPattern: string,
  maxMatches: number,
  maxMatchChars: number,
): { readonly matches: readonly AstMatch[]; readonly omitted: number } {
  const root = parse(AST_LANGUAGE[language], source).root()
  const matches = root.findAll(pattern(AST_LANGUAGE[language], structuralPattern))
  const selected = matches.slice(0, maxMatches).map((node): AstMatch => {
    const range = node.range()
    const preview = clipped(node.text(), maxMatchChars)
    return Object.freeze({
      startLine: range.start.line + 1,
      startColumn: range.start.column + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.column + 1,
      text: preview.text,
      textSha256: sha256(node.text()),
    })
  })
  return Object.freeze({
    matches: Object.freeze(selected),
    omitted: Math.max(0, matches.length - selected.length),
  })
}

function replacementFor(node: SgNode, template: string): string {
  return template.replace(META_VARIABLE, (token) => {
    const name = token.replace(/^\$+/u, '')
    if (token.startsWith('$$$')) {
      const matches = node.getMultipleMatches(name)
      if (matches.length === 0) throw new Error(`replacement metavariable ${token} has no AST match`)
      const container = node.text()
      let cursor = 0
      let first = -1
      let last = -1
      for (const match of matches) {
        const index = container.indexOf(match.text(), cursor)
        /* v8 ignore next -- ast-grep multiple matches are descendants of this exact node. */
        if (index < 0) throw new Error(`replacement metavariable ${token} cannot be located in its AST match`)
        if (first < 0) first = index
        last = index + match.text().length
        cursor = last
      }
      return container.slice(first, last)
    }
    const match = node.getMatch(name)
    if (match === null) throw new Error(`replacement metavariable ${token} has no AST match`)
    return match.text()
  })
}

/** Compute one complete structural rewrite without mutating the filesystem. */
export function rewriteAst(
  source: string,
  language: CodeLanguage,
  structuralPattern: string,
  replacement: string,
  maxReplacements: number,
): { readonly content: string; readonly replacements: number } {
  const root = parse(AST_LANGUAGE[language], source).root()
  const matches = root.findAll(pattern(AST_LANGUAGE[language], structuralPattern))
  if (matches.length === 0) throw new Error('AST rewrite pattern matched no nodes')
  if (matches.length > maxReplacements) {
    throw new Error(`AST rewrite matched ${matches.length} nodes, exceeding maxReplacements=${maxReplacements}`)
  }
  const edits = matches.map(node => node.replace(replacementFor(node, replacement)))
  return Object.freeze({ content: root.commitEdits(edits), replacements: matches.length })
}

/** Return a bounded line window plus whole-file freshness hash. */
export function hashLineWindow(
  source: string,
  offset: number,
  limit: number,
  maxLineChars: number,
): { readonly fileSha256: string; readonly totalLines: number; readonly lines: readonly HashedLine[] } {
  const lines = source.split('\n')
  const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index): HashedLine => {
    const preview = clipped(line, maxLineChars)
    return Object.freeze({
      line: offset + index,
      hash: sha256(line).slice(0, 16),
      text: preview.text,
      truncated: preview.truncated,
    })
  })
  return Object.freeze({
    fileSha256: sha256(source),
    totalLines: lines.length,
    lines: Object.freeze(selected),
  })
}

/** Apply one exact line-range replacement after checking file and endpoint hashes. */
export function hashAnchoredEdit(
  source: string,
  expectedFileSha256: string,
  startLine: number,
  startHash: string,
  endLine: number,
  endHash: string,
  replacement: string,
): string {
  if (sha256(source) !== expectedFileSha256) throw new Error('hash edit rejected stale whole-file SHA-256')
  const lines = source.split('\n')
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error('hash edit line range is outside the current file')
  }
  if (sha256(lines[startLine - 1]!).slice(0, 16) !== startHash) {
    throw new Error(`hash edit start anchor at line ${startLine} is stale`)
  }
  if (sha256(lines[endLine - 1]!).slice(0, 16) !== endHash) {
    throw new Error(`hash edit end anchor at line ${endLine} is stale`)
  }
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement.split('\n'))
  return lines.join('\n')
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('code-intelligence tools require an Agent-backed session')
  if (exec.agent.session.header.cwd === undefined) {
    throw new Error('code-intelligence tools require a workspace-backed session')
  }
  return exec.agent
}

function requireAuthorizedMutation(ctx: Context, agent: Agent): void {
  const lease = ctx.autonomy.get(agent)
  const goal = ctx.goals.get(agent)
  if (lease === undefined || goal === undefined || lease.goalId !== goal.id
    || lease.phase !== 'running' || lease.activation !== 'armed'
    || goal.phase !== 'active' || goal.activation !== 'armed') {
    throw new Error('code-intelligence mutation requires the exact armed Autopilot Goal and lease')
  }
}

async function readStableText(
  ctx: Context,
  exec: ToolRunContext,
  path: string,
  maxFileBytes: number,
): Promise<string> {
  const agent = requireAgent(exec)
  const cwd = agent.session.header.cwd
  /* v8 ignore next -- requireAgent rejects workspace-less sessions before this read. */
  if (cwd === undefined) throw new Error('code-intelligence tools require a workspace-backed session')
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal })
  const before = await ctx.fs.stat(target, exec.signal)
  if (before === undefined) throw new Error(`code-intelligence file ${JSON.stringify(path)} does not exist`)
  if (before.type !== 'file') throw new Error(`code-intelligence path ${JSON.stringify(path)} is not a regular file`)
  if (before.size !== undefined && before.size > maxFileBytes) {
    throw new Error(`code-intelligence file exceeds maxFileBytes=${maxFileBytes}`)
  }
  const source = await ctx.fs.readText(target, exec.signal)
  if (Buffer.byteLength(source) > maxFileBytes) {
    throw new Error(`code-intelligence file exceeds maxFileBytes=${maxFileBytes}`)
  }
  const after = await ctx.fs.stat(target, exec.signal)
  if (after === undefined || after.type !== 'file' || after.version !== before.version) {
    throw new Error('code-intelligence file changed while it was being read')
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec)
  return source
}

async function writeThroughDsh(
  ctx: Context,
  exec: ToolRunContext,
  path: string,
  content: string,
): Promise<void> {
  const agent = requireAgent(exec)
  const result = await ctx.tools.execute({
    callId: CallId(`${String(exec.callId)}:autopilot-write`),
    rootCallId: exec.rootCallId,
    name: 'write',
    arguments: { file_path: path, content },
    agent,
    parent: exec.token,
    signal: exec.signal,
  })
  if (result.isError) throw new Error(`DSH write rejected code-intelligence mutation: ${result.error.message}`)
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Register bounded structural-code and stale-safe edit tools. */
export function apply(ctx: Context, config: {
  maxFileBytes?: number
  maxMatches?: number
  maxMatchChars?: number
  maxReplacements?: number
  hashReadLimit?: number
  maxLineChars?: number
} = {}): void {
  const maxFileBytes = config.maxFileBytes ?? 2_000_000
  const maxMatches = config.maxMatches ?? 200
  const maxMatchChars = config.maxMatchChars ?? 2_000
  const maxReplacements = config.maxReplacements ?? 200
  const hashReadLimit = config.hashReadLimit ?? 500
  const maxLineChars = config.maxLineChars ?? 2_000
  for (const [key, value] of Object.entries({
    maxFileBytes, maxMatches, maxMatchChars, maxReplacements, hashReadLimit, maxLineChars,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer`)
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_ast',
    description: 'Search or atomically rewrite one JS/TS/TSX/HTML/CSS file with an ast-grep structural pattern. Rewrites require expectedFileSha256 and the active Autopilot authorization.',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'rewrite'] },
      file_path: { type: 'string', required: true },
      language: { type: 'string', enum: ['css', 'html', 'javascript', 'tsx', 'typescript'] },
      pattern: { type: 'string', required: true },
      replacement: { type: 'string' },
      expectedFileSha256: { type: 'string' },
      maxResults: { type: 'number' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const structuralPattern = args.pattern.trim()
      if (structuralPattern.length === 0) throw new Error('AST pattern must not be empty')
      const source = await readStableText(ctx, exec, args.file_path, maxFileBytes)
      const language = resolveCodeLanguage(args.file_path, args.language)
      if (args.action === 'search') {
        const requested = args.maxResults ?? maxMatches
        if (!Number.isSafeInteger(requested) || requested < 1 || requested > maxMatches) {
          throw new Error(`maxResults must be an integer from 1 to ${maxMatches}`)
        }
        return jsonValue({
          fileSha256: sha256(source),
          language,
          ...searchAst(source, language, structuralPattern, requested, maxMatchChars),
        })
      }
      const agent = requireAgent(exec)
      requireAuthorizedMutation(ctx, agent)
      if (args.replacement === undefined || args.expectedFileSha256 === undefined) {
        throw new Error('AST rewrite requires replacement and expectedFileSha256 from a prior search')
      }
      if (sha256(source) !== args.expectedFileSha256) throw new Error('AST rewrite rejected stale whole-file SHA-256')
      const rewritten = rewriteAst(source, language, structuralPattern, args.replacement, maxReplacements)
      await writeThroughDsh(ctx, exec, args.file_path, rewritten.content)
      return jsonValue({ fileSha256: sha256(rewritten.content), language, replacements: rewritten.replacements })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_hashline',
    description: 'Read line hashes or replace an exact line range. Edits verify the complete file SHA-256 plus both endpoint hashes, then mutate through the DSH write policy.',
    parameters: {
      action: { type: 'string', required: true, enum: ['read', 'edit'] },
      file_path: { type: 'string', required: true },
      offset: { type: 'number' },
      limit: { type: 'number' },
      expectedFileSha256: { type: 'string' },
      startLine: { type: 'number' },
      startHash: { type: 'string' },
      endLine: { type: 'number' },
      endHash: { type: 'string' },
      replacement: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const source = await readStableText(ctx, exec, args.file_path, maxFileBytes)
      if (args.action === 'read') {
        const offset = args.offset ?? 1
        const limit = args.limit ?? hashReadLimit
        if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('hash-line offset must be a positive integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > hashReadLimit) {
          throw new Error(`hash-line limit must be an integer from 1 to ${hashReadLimit}`)
        }
        return jsonValue(hashLineWindow(source, offset, limit, maxLineChars))
      }
      const agent = requireAgent(exec)
      requireAuthorizedMutation(ctx, agent)
      if (args.expectedFileSha256 === undefined || args.startLine === undefined
        || args.startHash === undefined || args.replacement === undefined) {
        throw new Error('hash-line edit requires expectedFileSha256, startLine, startHash, and replacement')
      }
      const endLine = args.endLine ?? args.startLine
      const endHash = args.endHash ?? args.startHash
      const content = hashAnchoredEdit(
        source,
        args.expectedFileSha256,
        args.startLine,
        args.startHash,
        endLine,
        endHash,
        args.replacement,
      )
      await writeThroughDsh(ctx, exec, args.file_path, content)
      return jsonValue({ fileSha256: sha256(content), startLine: args.startLine, endLine })
    },
  })))
  registerRecoveryContribution(ctx, 'code-intelligence')
}
