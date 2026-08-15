import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { PromptArtifact } from '../../src/prompt-artifacts.ts'
import PromptRulesService, {
  loadPromptRules,
  matchesPromptGlob,
  normalizeNotedPath,
  normalizePromptGlob,
  parsePromptRule,
} from '../../src/prompt-rules.ts'
import { createTestAgent } from '../helpers.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-rules-'))
  roots.push(root)
  return root
}

function ruleDocument(id: string, globs: readonly string[], body = `Apply ${id}.`, description = `${id} description`): string {
  return [
    '---',
    `id: ${id}`,
    `description: ${description}`,
    'globs:',
    ...globs.map(glob => `  - ${JSON.stringify(glob)}`),
    '---',
    body,
    '',
  ].join('\n')
}

function artifact(frontmatter: Record<string, unknown>, body = 'Rule body.'): PromptArtifact {
  return {
    path: '/rules/rule.md',
    relativePath: 'rule.md',
    sha256: 'a'.repeat(64),
    frontmatter,
    body,
    bytes: 100,
  }
}

async function ruleContext(config: ConstructorParameters<typeof PromptRulesService>[1]) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(PromptRulesService, config)
  return { ctx, fiber }
}

let callSequence = 0

function executeTool(ctx: Context, agent: Agent, name: string, args: unknown) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`prompt-rule-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

function stubToolExecution(
  input: Omit<ToolExecution, 'token' | 'rootCallId'> & {
    readonly token?: ToolExecutionToken
    readonly rootCallId?: ToolExecution['rootCallId']
  },
): ToolExecution {
  return {
    token: input.token ?? Symbol('prompt-rule-execution') as ToolExecutionToken,
    ...input,
    rootCallId: input.rootCallId ?? input.callId,
  }
}

describe('finite conditional-rule globs', () => {
  it.each([
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/nested/a.ts', true],
    ['src/**/*.ts', 'src/a.js', false],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/README.md', false],
    ['config?.yml', 'config1.yml', true],
    ['config?.yml', 'config10.yml', false],
    ['**/test?.ts', 'test1.ts', true],
    ['**/test?.ts', 'nested/testa.ts', true],
    ['src/a+b.ts', 'src/a+b.ts', true],
  ])('matches %s against %s', (glob, path, expected) => {
    expect(matchesPromptGlob(glob, path)).toBe(expected)
  })

  it('normalizes separators and a single leading dot segment', () => {
    expect(normalizePromptGlob('./src\\**\\*.ts')).toBe('src/**/*.ts')
  })

  it.each([
    ['', /1-256/],
    ['a'.repeat(257), /1-256/],
    ['bad\0glob', /NUL/],
    ['/absolute/*.ts', /stay relative/],
    ['../escape/*.ts', /stay relative/],
    ['src/***/bad.ts', /unsupported syntax/],
    ['src/[ab].ts', /unsupported syntax/],
  ])('rejects unsupported or unsafe glob %j', (glob, message) => {
    expect(() => normalizePromptGlob(glob)).toThrow(message)
  })
})

describe('noted path normalization', () => {
  it('normalizes relative, Windows-style, absolute, and workspace-root paths', async () => {
    const root = await workspace()
    expect(normalizeNotedPath(root, './src/a.ts')).toBe('src/a.ts')
    expect(normalizeNotedPath(root, 'src\\nested\\b.ts')).toBe('src/nested/b.ts')
    expect(normalizeNotedPath(root, join(root, 'README.md'))).toBe('README.md')
    expect(normalizeNotedPath(root, root)).toBe('.')
  })

  it.each([
    [undefined, 'src/a.ts', /absolute Agent workspace/],
    ['relative', 'src/a.ts', /absolute Agent workspace/],
  ])('requires an absolute workspace', (root, path, message) => {
    expect(() => normalizeNotedPath(root, path)).toThrow(message)
  })

  it('rejects empty, oversized, NUL, and escaping paths', async () => {
    const root = await workspace()
    expect(() => normalizeNotedPath(root, '')).toThrow(/1-4096/)
    expect(() => normalizeNotedPath(root, 'a'.repeat(4097))).toThrow(/1-4096/)
    expect(() => normalizeNotedPath(root, 'bad\0path')).toThrow(/NUL/)
    expect(() => normalizeNotedPath(root, '../outside.ts')).toThrow(/escapes Agent workspace/)
  })
})

describe('rule artifact validation', () => {
  it('parses and freezes a strict rule', () => {
    const parsed = parsePromptRule(artifact({
      id: 'typescript-safety',
      description: 'Apply strict TypeScript guidance.',
      globs: ['./src/**/*.ts', 'tests/*.ts'],
    }))
    expect(parsed).toMatchObject({
      id: 'typescript-safety',
      globs: ['src/**/*.ts', 'tests/*.ts'],
      content: 'Rule body.',
      sourcePath: 'rule.md',
    })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.globs)).toBe(true)
  })

  it.each([
    [{ id: 'valid', description: 'ok', globs: ['*.ts'], extra: true }, /unsupported field/],
    [{ description: 'ok', globs: ['*.ts'] }, /field "id"/],
    [{ id: 'INVALID', description: 'ok', globs: ['*.ts'] }, /invalid kebab-case/],
    [{ id: 'valid', description: '', globs: ['*.ts'] }, /field "description"/],
    [{ id: 'valid', description: 'x'.repeat(501), globs: ['*.ts'] }, /at most 500/],
    [{ id: 'valid', description: 'ok', globs: [] }, /array of 1-32/],
    [{ id: 'valid', description: 'ok', globs: 'not-array' }, /array of 1-32/],
    [{ id: 'valid', description: 'ok', globs: Array.from({ length: 33 }, (_, index) => `file-${index}`) }, /array of 1-32/],
    [{ id: 'valid', description: 'ok', globs: [7] }, /only strings/],
    [{ id: 'valid', description: 'ok', globs: ['*.ts', '*.ts'] }, /duplicate globs/],
  ])('rejects invalid frontmatter %#', (frontmatter, message) => {
    expect(() => parsePromptRule(artifact(frontmatter))).toThrow(message)
  })

  it('rejects duplicate ids and returns stable id order', async () => {
    const root = await workspace()
    const catalog = join(root, 'rules')
    await mkdir(catalog)
    await writeFile(join(catalog, 'z.md'), ruleDocument('z-rule', ['z/**']))
    await writeFile(join(catalog, 'a.md'), ruleDocument('a-rule', ['a/**']))
    expect(loadPromptRules(root, 'rules', {
      maxFiles: 4, maxFileBytes: 4096, maxTotalBytes: 8192,
    }).map(rule => rule.id)).toEqual(['a-rule', 'z-rule'])
    await writeFile(join(catalog, 'duplicate.md'), ruleDocument('a-rule', ['other/**']))
    expect(() => loadPromptRules(root, 'rules', {
      maxFiles: 4, maxFileBytes: 4096, maxTotalBytes: 8192,
    })).toThrow(/duplicate rule id/)
  })
})

describe('PromptRulesService', () => {
  it('retains constructor defaults for direct Host construction', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(new PromptRulesService(ctx)).toBeInstanceOf(PromptRulesService)
  })

  it('isolates relative catalogs across workspaces and injects only actual matches', async () => {
    const firstRoot = await workspace()
    const secondRoot = await workspace()
    await mkdir(join(firstRoot, '.dsh', 'rules'), { recursive: true })
    await mkdir(join(secondRoot, '.dsh', 'rules'), { recursive: true })
    await writeFile(join(firstRoot, '.dsh', 'rules', 'rule.md'), ruleDocument('workspace-rule', ['src/**/*.ts'], 'FIRST'))
    await writeFile(join(secondRoot, '.dsh', 'rules', 'rule.md'), ruleDocument('workspace-rule', ['src/**/*.ts'], 'SECOND'))
    const { ctx } = await ruleContext({ directory: '.dsh/rules' })
    const first = createTestAgent('rules-first', firstRoot)
    const second = createTestAgent('rules-second', secondRoot)

    ctx.autopilotPromptRules.notePath(first, 'docs/guide.md')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(assembleContextFor(first)))).toBe('')
    ctx.autopilotPromptRules.notePath(first, 'src/index.ts')
    ctx.autopilotPromptRules.notePath(second, join(secondRoot, 'src', 'index.ts'))
    const firstSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble(assembleContextFor(first)))
    const secondSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble(assembleContextFor(second)))
    expect(firstSnapshot).toContain('FIRST')
    expect(firstSnapshot).not.toContain('SECOND')
    expect(secondSnapshot).toContain('SECOND')
    expect(firstSnapshot).toContain('Source: rule.md (sha256:')
  })

  it('observes only successful explicit file reads and edits, including nested code dispatch', async () => {
    const root = await workspace()
    await mkdir(join(root, 'rules'))
    await writeFile(join(root, 'rules', 'rule.md'), ruleDocument('source-files', ['src/**'], 'MATCHED'))
    const { ctx } = await ruleContext({ directory: 'rules' })
    const agent = createTestAgent('rules-tools', root)
    for (const name of ['read', 'edit', 'glob']) {
      ctx.tools.register(defineContentToolFixture({
        name,
        description: name,
        parameters: {
          file_path: { type: 'string', required: true },
        },
        async execute({ file_path }) {
          if (name === 'edit') throw new Error(`failed to edit ${file_path}`)
          return [{ type: 'text', text: String(file_path) }]
        },
      }))
    }
    ctx.tools.register(defineContentToolFixture({
      name: 'composite_read',
      description: 'nested dispatch fixture',
      parameters: {},
      async execute(_args, exec) {
        const nested = await ctx.tools.execute({
          callId: CallId('prompt-rule-nested-read'),
          rootCallId: exec.rootCallId,
          parent: exec.token,
          name: 'read',
          arguments: { file_path: 'src/nested.ts' },
          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
          signal: exec.signal,
        })
        return nested.content
      },
    }))

    expect((await executeTool(ctx, agent, 'edit', { file_path: 'src/failed.ts' })).isError).toBe(true)
    expect((await executeTool(ctx, agent, 'glob', { file_path: 'src/listed.ts' })).isError).toBe(false)
    expect(ctx.autopilotPromptRules.contextFor(agent)).toBe('')
    expect((await executeTool(ctx, agent, 'composite_read', {})).isError).toBe(false)
    expect(ctx.autopilotPromptRules.contextFor(agent)).toContain('src/nested.ts')
    expect(ctx.autopilotPromptRules.contextFor(agent)).not.toContain('failed.ts')
    expect(ctx.autopilotPromptRules.contextFor(agent)).not.toContain('listed.ts')
  })

  it('ignores malformed, aborted, agentless, failed, and pathless observations', async () => {
    const root = await workspace()
    await mkdir(join(root, 'rules'))
    await writeFile(join(root, 'rules', 'rule.md'), ruleDocument('source-files', ['src/**']))
    const { ctx } = await ruleContext({ directory: 'rules' })
    const agent = createTestAgent('rules-observation-filter', root)
    const signal = new AbortController().signal
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    const accepted = { content: [], isError: false as const, value: null }
    const cases: ToolExecution[] = [
      stubToolExecution({ signal, callId: CallId('agentless'), name: 'read', arguments: { file_path: 'src/a.ts' } }),
      stubToolExecution({ signal: aborted.signal, callId: CallId('aborted'), name: 'read', arguments: { file_path: 'src/a.ts' }, agent }),
      stubToolExecution({ signal, callId: CallId('null'), name: 'read', arguments: null, agent }),
      stubToolExecution({ signal, callId: CallId('missing'), name: 'read', arguments: {}, agent }),
      stubToolExecution({ signal, callId: CallId('number'), name: 'read', arguments: { file_path: 7 }, agent }),
      stubToolExecution({ signal, callId: CallId('blank'), name: 'read', arguments: { file_path: ' ' }, agent }),
      stubToolExecution({ signal, callId: CallId('other'), name: 'grep', arguments: { file_path: 'src/a.ts' }, agent }),
    ]
    for (const exec of cases) ctx.emit('tools/result', exec, accepted)
    ctx.emit('tools/result', stubToolExecution({
      signal,
      callId: CallId('failed'),
      name: 'read',
      arguments: { file_path: 'src/a.ts' },
      agent,
    }), { content: [], isError: true, error: { message: 'failed' } })
    expect(ctx.autopilotPromptRules.contextFor(agent)).toBe('')

    const parent = Symbol('prompt-rule-parent') as ToolExecutionToken
    ctx.emit('tools/result', stubToolExecution({
      token: Symbol('nested-non-file') as ToolExecutionToken,
      parent,
      signal,
      callId: CallId('nested-non-file'),
      name: 'grep',
      arguments: {},
      agent,
    }), accepted)
    for (const [callId, filePath] of [['nested-first', 'src/a.ts'], ['nested-second', 'src/b.ts']] as const) {
      ctx.emit('tools/result', stubToolExecution({
        token: Symbol(callId) as ToolExecutionToken,
        parent,
        signal,
        callId: CallId(callId),
        name: 'read',
        arguments: { file_path: filePath },
        agent,
      }), accepted)
    }
    ctx.emit('tools/result', stubToolExecution({
      token: parent,
      signal,
      callId: CallId('parent'),
      name: 'composite_read',
      arguments: {},
      agent,
    }), accepted)
    expect(ctx.autopilotPromptRules.contextFor(agent)).toContain('src/a.ts, src/b.ts')
  })

  it('deduplicates paths, enforces the per-turn ceiling, and clears both lifecycle paths', async () => {
    const root = await workspace()
    await mkdir(join(root, 'rules'))
    await writeFile(join(root, 'rules', 'rule.md'), ruleDocument('all-files', ['**']))
    const { ctx } = await ruleContext({ directory: 'rules', maxNotedPaths: 1 })
    const agent = createTestAgent('rules-lifecycle', root)
    ctx.autopilotPromptRules.notePath(agent, 'a.ts')
    ctx.autopilotPromptRules.notePath(agent, './a.ts')
    expect(() => ctx.autopilotPromptRules.notePath(agent, 'b.ts')).toThrow(/more than 1 distinct paths/)
    expect(ctx.autopilotPromptRules.contextFor(agent)).toContain('a.ts')

    await agentEvents(ctx, agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(ctx.autopilotPromptRules.contextFor(agent)).toBe('')
    ctx.autopilotPromptRules.notePath(agent, 'a.ts')
    agentEvents(ctx, agent).emit('agent/disposed', {})
    expect(ctx.autopilotPromptRules.contextFor(agent)).toBe('')
  })

  it('bounds matching context and cleans the provider on plugin reload', async () => {
    const root = await workspace()
    await mkdir(join(root, 'rules'))
    await writeFile(join(root, 'rules', 'rule.md'), ruleDocument('large-rule', ['**/*.ts'], 'x'.repeat(2000)))
    const { ctx, fiber } = await ruleContext({ directory: 'rules', maxContextChars: 256 })
    const agent = createTestAgent('rules-bounds', root)
    ctx.autopilotPromptRules.notePath(agent, 'src/a.ts')
    const context = ctx.autopilotPromptRules.contextFor(agent)
    expect(context.length).toBe(256)
    expect(context).toContain('large-rule')
    expect(context).toContain('truncated')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')
    await fiber.dispose()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(assembleContextFor(agent)))).toBe('')
  })

  it('renders the full truncation suffix branch and stops after the context ceiling', async () => {
    const root = await workspace()
    await mkdir(join(root, 'rules'))
    await writeFile(join(root, 'rules', 'a.md'), ruleDocument('first-large', ['**'], 'x'.repeat(2000)))
    await writeFile(join(root, 'rules', 'b.md'), ruleDocument('second-large', ['**'], 'y'.repeat(2000)))
    const { ctx } = await ruleContext({ directory: 'rules', maxContextChars: 512 })
    const agent = createTestAgent('rules-two-large', root)
    ctx.autopilotPromptRules.notePath(agent, 'src/a.ts')
    const context = ctx.autopilotPromptRules.contextFor(agent)
    expect(context).toHaveLength(512)
    expect(context).toContain('[Rule content truncated by deployment context limit.]')
    expect(context).not.toContain('second-large')
  })

  it('loads an absolute catalog for an Agent without a workspace', async () => {
    const root = await workspace()
    const catalog = join(root, 'rules')
    await mkdir(catalog)
    await writeFile(join(catalog, 'rule.md'), ruleDocument('absolute-rule', ['**']))
    const { ctx } = await ruleContext({ directory: catalog })
    const agent = createTestAgent('rules-absolute')
    expect(() => ctx.autopilotPromptRules.notePath(agent, 'file.ts')).toThrow(/absolute Agent workspace/)
  })

  it('stays inert when no directory is configured', async () => {
    const root = await workspace()
    const { ctx } = await ruleContext({})
    const agent = createTestAgent('rules-disabled', root)
    ctx.autopilotPromptRules.notePath(agent, 'src/a.ts')
    expect(ctx.autopilotPromptRules.contextFor(agent)).toBe('')
  })
})
