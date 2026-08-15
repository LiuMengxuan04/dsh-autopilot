import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CodeIntelligence from '../../src/code-intelligence.ts'
import { createHarness, createTestAgent } from '../helpers.ts'

const temporaryRoots: string[] = []
let callSequence = 0

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-code-'))
  temporaryRoots.push(root)
  return root
}

function execute(ctx: Context, agent: Parameters<Context['goals']['get']>[0], name: string, args: unknown) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`code-intelligence-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

async function assembled(options: Parameters<typeof CodeIntelligence.apply>[1] = {}) {
  const root = await workspace()
  const harness = await createHarness({ cwd: root })
  await harness.ctx.plugin(LocalFileSystem, { cwd: root })
  await harness.ctx.plugin(ObservationPolicy)
  await harness.ctx.plugin(ToolFs, {})
  await harness.ctx.plugin(CodeIntelligence, options)
  return { ...harness, root }
}

describe('pure code-intelligence operations', () => {
  it('resolves every built-in language and rejects an unknown extension', () => {
    expect(CodeIntelligence.resolveCodeLanguage('a.css')).toBe('css')
    expect(CodeIntelligence.resolveCodeLanguage('a.htm')).toBe('html')
    expect(CodeIntelligence.resolveCodeLanguage('a.HTML')).toBe('html')
    expect(CodeIntelligence.resolveCodeLanguage('a.js')).toBe('javascript')
    expect(CodeIntelligence.resolveCodeLanguage('a.mjs')).toBe('javascript')
    expect(CodeIntelligence.resolveCodeLanguage('a.cjs')).toBe('javascript')
    expect(CodeIntelligence.resolveCodeLanguage('a.jsx')).toBe('tsx')
    expect(CodeIntelligence.resolveCodeLanguage('a.ts')).toBe('typescript')
    expect(CodeIntelligence.resolveCodeLanguage('a.mts')).toBe('typescript')
    expect(CodeIntelligence.resolveCodeLanguage('a.cts')).toBe('typescript')
    expect(CodeIntelligence.resolveCodeLanguage('a.tsx')).toBe('tsx')
    expect(CodeIntelligence.resolveCodeLanguage('a.unknown', 'html')).toBe('html')
    expect(() => CodeIntelligence.resolveCodeLanguage('a.unknown')).toThrow('cannot infer')
  })

  it('searches structurally with bounded previews and omission counts', () => {
    const result = CodeIntelligence.searchAst(
      'const a = foo(1); const b = foo(2)',
      'typescript',
      'foo($A)',
      1,
      5,
    )

    expect(result.omitted).toBe(1)
    expect(result.matches).toEqual([expect.objectContaining({
      startLine: 1,
      startColumn: 11,
      endLine: 1,
      text: 'foo(1…',
      textSha256: CodeIntelligence.sha256('foo(1)'),
    })])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.matches)).toBe(true)
  })

  it('rewrites single and variadic metavariables and rejects unsafe cardinalities', () => {
    expect(CodeIntelligence.rewriteAst(
      'foo(a, b)', 'typescript', 'foo($$$ARGS)', 'bar($$$ARGS)', 2,
    )).toEqual({ content: 'bar(a, b)', replacements: 1 })
    expect(CodeIntelligence.rewriteAst(
      'foo(1); foo(2)', 'typescript', 'foo($A)', 'bar($A)', 2,
    )).toEqual({ content: 'bar(1); bar(2)', replacements: 2 })
    expect(() => CodeIntelligence.rewriteAst('foo(1)', 'typescript', 'bar($A)', 'x', 1))
      .toThrow('matched no nodes')
    expect(() => CodeIntelligence.rewriteAst('foo(1);foo(2)', 'typescript', 'foo($A)', 'x', 1))
      .toThrow('exceeding maxReplacements')
    expect(() => CodeIntelligence.rewriteAst('foo(1)', 'typescript', 'foo($A)', 'x($B)', 1))
      .toThrow('has no AST match')
    expect(() => CodeIntelligence.rewriteAst('foo(1)', 'typescript', 'foo($A)', 'x($$$B)', 1))
      .toThrow('has no AST match')
  })

  it('reads bounded line hashes and applies exact stale-safe ranges', () => {
    const source = 'alpha\nbeta-long\ngamma\n'
    const view = CodeIntelligence.hashLineWindow(source, 2, 2, 4)

    expect(view).toEqual({
      fileSha256: CodeIntelligence.sha256(source),
      totalLines: 4,
      lines: [
        { line: 2, hash: CodeIntelligence.sha256('beta-long').slice(0, 16), text: 'beta…', truncated: true },
        { line: 3, hash: CodeIntelligence.sha256('gamma').slice(0, 16), text: 'gamm…', truncated: true },
      ],
    })
    const edited = CodeIntelligence.hashAnchoredEdit(
      source,
      view.fileSha256,
      2,
      view.lines[0]!.hash,
      3,
      view.lines[1]!.hash,
      'delta\nepsilon',
    )
    expect(edited).toBe('alpha\ndelta\nepsilon\n')
    expect(() => CodeIntelligence.hashAnchoredEdit(source, 'stale', 2, view.lines[0]!.hash, 3, view.lines[1]!.hash, 'x'))
      .toThrow('whole-file')
    expect(() => CodeIntelligence.hashAnchoredEdit(source, view.fileSha256, 0, 'x', 1, 'x', 'x'))
      .toThrow('outside')
    expect(() => CodeIntelligence.hashAnchoredEdit(source, view.fileSha256, 2, 'stale', 3, view.lines[1]!.hash, 'x'))
      .toThrow('start anchor')
    expect(() => CodeIntelligence.hashAnchoredEdit(source, view.fileSha256, 2, view.lines[0]!.hash, 3, 'stale', 'x'))
      .toThrow('end anchor')
  })
})

describe('code-intelligence DSH tools', () => {
  it('searches and rewrites through the DSH observed-write policy', async () => {
    const { ctx, agent, root } = await assembled()
    const path = join(root, 'sample.ts')
    await writeFile(path, 'const a = foo(1)\n')
    const goal = ctx.goals.create(agent, { objective: 'rewrite structurally' })
    await ctx.autonomy.start(agent, { goalId: goal.id })

    const searched = await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'sample.ts', pattern: 'foo($A)',
    })
    expect(searched.isError).toBe(false)
    const searchedValue = searched.value as { fileSha256: string }
    const rewritten = await execute(ctx, agent, 'autopilot_ast', {
      action: 'rewrite',
      file_path: 'sample.ts',
      pattern: 'foo($A)',
      replacement: 'bar($A)',
      expectedFileSha256: searchedValue.fileSha256,
    })
    expect(rewritten.isError).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('const a = bar(1)\n')
  })

  it('performs hash-line reads and edits while preserving exact anchors', async () => {
    const { ctx, agent, root } = await assembled({ hashReadLimit: 2 })
    const path = join(root, 'notes.txt')
    await writeFile(path, 'one\ntwo\nthree\n')
    const goal = ctx.goals.create(agent, { objective: 'edit by hash' })
    await ctx.autonomy.start(agent, { goalId: goal.id })

    const read = await execute(ctx, agent, 'autopilot_hashline', {
      action: 'read', file_path: 'notes.txt', offset: 2, limit: 2,
    })
    expect(read.isError).toBe(false)
    const value = read.value as {
      fileSha256: string
      lines: Array<{ line: number; hash: string }>
    }
    const edit = await execute(ctx, agent, 'autopilot_hashline', {
      action: 'edit',
      file_path: 'notes.txt',
      expectedFileSha256: value.fileSha256,
      startLine: value.lines[0]!.line,
      startHash: value.lines[0]!.hash,
      replacement: 'TWO',
    })
    expect(edit.isError).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('one\nTWO\nthree\n')
  })

  it('rejects malformed, stale, unauthorized, oversized, and non-file calls', async () => {
    const { ctx, agent, root } = await assembled({
      maxFileBytes: 32, maxMatches: 2, maxReplacements: 1, hashReadLimit: 2,
    })
    await writeFile(join(root, 'sample.ts'), 'foo(1); foo(2)')
    await writeFile(join(root, 'large.ts'), 'x'.repeat(33))
    await mkdir(join(root, 'folder'))

    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'sample.ts', pattern: ' ',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'sample.ts', pattern: 'foo($A)', maxResults: 3,
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'missing.ts', pattern: 'foo($A)',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'folder', language: 'typescript', pattern: 'foo($A)',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'large.ts', pattern: 'x',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'rewrite', file_path: 'sample.ts', pattern: 'foo($A)',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_hashline', {
      action: 'edit', file_path: 'sample.ts',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_hashline', {
      action: 'read', file_path: 'sample.ts', offset: 0,
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_hashline', {
      action: 'read', file_path: 'sample.ts', limit: 3,
    })).isError).toBe(true)

    const goal = ctx.goals.create(agent, { objective: 'reject stale rewrites' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'rewrite', file_path: 'sample.ts', pattern: 'foo($A)',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_hashline', {
      action: 'edit', file_path: 'sample.ts',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'rewrite', file_path: 'sample.ts', pattern: 'foo($A)', replacement: 'bar($A)',
      expectedFileSha256: 'stale',
    })).isError).toBe(true)
    const current = CodeIntelligence.sha256(await readFile(join(root, 'sample.ts'), 'utf8'))
    expect((await execute(ctx, agent, 'autopilot_ast', {
      action: 'rewrite', file_path: 'sample.ts', pattern: 'foo($A)', replacement: 'bar($A)',
      expectedFileSha256: current,
    })).isError).toBe(true)
  })

  it('fails nested writes cleanly and rejects agentless or workspace-less reads', async () => {
    const { ctx, agent, root } = await assembled()
    await writeFile(join(root, 'sample.ts'), 'foo(1)')
    const goal = ctx.goals.create(agent, { objective: 'contain nested writes' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.tools.guard(exec => exec.name === 'write' ? 'write disabled for test' : undefined)

    const denied = await execute(ctx, agent, 'autopilot_ast', {
      action: 'rewrite', file_path: 'sample.ts', pattern: 'foo($A)', replacement: 'bar($A)',
      expectedFileSha256: CodeIntelligence.sha256('foo(1)'),
    })
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toContain('DSH write rejected')

    const agentless = await ctx.tools.execute({
      callId: CallId('code-intelligence-agentless'),
      name: 'autopilot_hashline',
      arguments: { action: 'read', file_path: 'sample.ts' },
      signal: new AbortController().signal,
    })
    expect(agentless.isError).toBe(true)

    const workspaceLess = createTestAgent('code-intelligence-workspace-less')
    expect((await execute(ctx, workspaceLess, 'autopilot_hashline', {
      action: 'read', file_path: 'sample.ts',
    })).isError).toBe(true)
  })

  it('rejects a file that changes during the stable-read window', async () => {
    const { ctx, agent, root } = await assembled()
    await writeFile(join(root, 'sample.ts'), 'foo(1)')
    const original = ctx.fs.stat.bind(ctx.fs)
    const first = await ctx.fs.resolve('sample.ts', { cwd: root })
    const firstInfo = await original(first)
    const spy = vi.spyOn(ctx.fs, 'stat')
    spy.mockResolvedValueOnce(firstInfo)
    spy.mockResolvedValueOnce(firstInfo === undefined ? undefined : { ...firstInfo, version: `${firstInfo.version}:changed` as typeof firstInfo.version })

    const result = await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'sample.ts', pattern: 'foo($A)',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('changed while')
  })

  it('enforces the decoded byte ceiling when metadata omits file size', async () => {
    const { ctx, agent, root } = await assembled({ maxFileBytes: 4 })
    await writeFile(join(root, 'sample.ts'), 'foo(1)')
    const target = await ctx.fs.resolve('sample.ts', { cwd: root })
    const info = await ctx.fs.stat(target)
    if (info === undefined) throw new Error('test file missing')
    const { size: _size, ...withoutSize } = info
    vi.spyOn(ctx.fs, 'stat').mockResolvedValue(withoutSize)

    const result = await execute(ctx, agent, 'autopilot_ast', {
      action: 'search', file_path: 'sample.ts', pattern: 'foo($A)',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('maxFileBytes=4')
  })

  it('validates every plugin ceiling before registration', () => {
    for (const key of [
      'maxFileBytes', 'maxMatches', 'maxMatchChars', 'maxReplacements', 'hashReadLimit', 'maxLineChars',
    ] as const) {
      expect(() => CodeIntelligence.apply({} as Context, { [key]: 0 })).toThrow(`${key} must`)
      expect(() => CodeIntelligence.apply({} as Context, { [key]: 1.5 })).toThrow(`${key} must`)
    }
  })
})
