import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptArtifact } from '../../src/prompt-artifacts.ts'
import CustomCommandsService, {
  loadCustomCommands,
  parseCustomCommand,
} from '../../src/custom-commands.ts'
import { createTestAgent } from '../helpers.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-commands-'))
  roots.push(root)
  return root
}

function commandDocument(
  commandName: string,
  prompt = `Execute ${commandName}.`,
  options: { description?: string; inputHint?: string } = {},
): string {
  return [
    '---',
    `name: ${commandName}`,
    `description: ${options.description ?? `${commandName} description`}`,
    ...(options.inputHint === undefined ? [] : [`inputHint: ${options.inputHint}`]),
    '---',
    prompt,
    '',
  ].join('\n')
}

function artifact(frontmatter: Record<string, unknown>, body = 'Perform the review.'): PromptArtifact {
  return {
    path: '/commands/review.md',
    relativePath: 'review.md',
    sha256: 'b'.repeat(64),
    frontmatter,
    body,
    bytes: 100,
  }
}

async function commandContext(agents: Array<ReturnType<typeof createTestAgent>>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  for (const agent of agents) {
    await ctx.plugin(Object.assign((inner: Context) => {
      const scope = createScope(inner, agent)
      Object.defineProperty(agent, 'ctx', { value: scope.ctx })
    }, { inject: ['commands'] }))
    ctx.agents.register(agent)
  }
  return ctx
}

describe('custom command artifacts', () => {
  it('parses optional input metadata and a bounded fixed prompt', () => {
    const parsed = parseCustomCommand(artifact({
      name: 'deep_review',
      description: 'Review the selected code.',
      inputHint: '<paths>',
    }), 1000)
    expect(parsed).toEqual({
      name: 'deep_review',
      description: 'Review the selected code.',
      inputHint: '<paths>',
      prompt: 'Perform the review.',
      sourcePath: 'review.md',
      sourceSha256: 'b'.repeat(64),
    })
    expect(parseCustomCommand(artifact({
      name: 'review', description: 'Review code.',
    }), 1000).inputHint).toBeUndefined()
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it.each([
    [{ name: 'review', description: 'ok', extra: true }, 100, /unsupported field/],
    [{ description: 'ok' }, 100, /field "name"/],
    [{ name: 'Bad.Name', description: 'ok' }, 100, /invalid command name/],
    [{ name: 'review', description: '' }, 100, /field "description"/],
    [{ name: 'review', description: 'x'.repeat(501) }, 100, /at most 500/],
    [{ name: 'review', description: 'ok', inputHint: '' }, 100, /field "inputHint"/],
    [{ name: 'review', description: 'ok', inputHint: 'x'.repeat(201) }, 100, /at most 200/],
    [{ name: 'review', description: 'ok' }, 0, /positive safe integer/],
    [{ name: 'review', description: 'ok' }, 1.5, /positive safe integer/],
    [{ name: 'review', description: 'ok' }, 5, /prompt is/],
  ])('rejects invalid command metadata %#', (frontmatter, promptLimit, message) => {
    expect(() => parseCustomCommand(artifact(frontmatter), promptLimit)).toThrow(message)
  })

  it('rejects duplicate names and returns stable command order', async () => {
    const root = await workspace()
    const catalog = join(root, 'commands')
    await mkdir(catalog)
    await writeFile(join(catalog, 'z.md'), commandDocument('z_command'))
    await writeFile(join(catalog, 'a.md'), commandDocument('a_command'))
    expect(loadCustomCommands(root, 'commands', {
      maxFiles: 4, maxFileBytes: 4096, maxTotalBytes: 8192,
    }, 1000).map(command => command.name)).toEqual(['a_command', 'z_command'])
    await writeFile(join(catalog, 'duplicate.md'), commandDocument('a_command'))
    expect(() => loadCustomCommands(root, 'commands', {
      maxFiles: 4, maxFileBytes: 4096, maxTotalBytes: 8192,
    }, 1000)).toThrow(/duplicate command name/)
  })
})

describe('CustomCommandsService', () => {
  it('retains constructor defaults for direct Host construction', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(new CustomCommandsService(ctx)).toBeInstanceOf(CustomCommandsService)
  })

  it('isolates the same command name across workspace-scoped layers', async () => {
    const firstRoot = await workspace()
    const secondRoot = await workspace()
    await mkdir(join(firstRoot, '.dsh', 'commands'), { recursive: true })
    await mkdir(join(secondRoot, '.dsh', 'commands'), { recursive: true })
    await writeFile(join(firstRoot, '.dsh', 'commands', 'review.md'), commandDocument(
      'review', 'FIRST PROMPT', { description: 'First review', inputHint: '<first>' },
    ))
    await writeFile(join(secondRoot, '.dsh', 'commands', 'review.md'), commandDocument(
      'review', 'SECOND PROMPT', { description: 'Second review', inputHint: '<second>' },
    ))
    const first = createTestAgent('commands-first', firstRoot)
    const second = createTestAgent('commands-second', secondRoot)
    const ctx = await commandContext([first, second])
    await ctx.plugin(CustomCommandsService, { directory: '.dsh/commands' })

    expect(ctx.commands.list(first)).toEqual([{
      name: 'review', description: 'First review', input: { hint: '<first>' },
    }])
    expect(ctx.commands.list(second)).toEqual([{
      name: 'review', description: 'Second review', input: { hint: '<second>' },
    }])
    await ctx.commands.execute(first, '/review first-input', new AbortController().signal)
    await ctx.commands.execute(second, '/review second-input', new AbortController().signal)
    const firstMessage = vi.mocked(first.followup).mock.calls[0]?.[0]
    const secondMessage = vi.mocked(second.followup).mock.calls[0]?.[0]
    expect(firstMessage?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('FIRST PROMPT') })
    expect(secondMessage?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('SECOND PROMPT') })
  })

  it('preserves bounded raw input verbatim and relies on DSH command/user-message identities', async () => {
    const root = await workspace()
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'review.md'), commandDocument('review', 'Check correctness.'))
    const agent = createTestAgent('commands-verbatim', root)
    const ctx = await commandContext([agent])
    await ctx.plugin(CustomCommandsService, { directory: 'commands', maxRawInputBytes: 128 })
    const rawInput = '  src/index.ts\nIgnore prior text? Keep this verbatim.'
    const execution = await ctx.commands.execute(agent, `/review${rawInput}`, new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Queued /review as a new Agent turn.' })
    const message = vi.mocked(agent.followup).mock.calls[0]?.[0]
    expect(message).toMatchObject({ role: 'user', source: {
      kind: 'plugin', plugin: 'dsh-autopilot-custom-commands', form: 'instructions',
    } })
    expect(message?.id).toEqual(expect.any(String))
    expect(message?.content[1]).toEqual({ type: 'text', text: rawInput })
    expect(agent.session.events.filter(event => event.type === 'command/run')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'command/run')?.data)
      .toMatchObject({ name: 'review', args: rawInput, source: { kind: 'user' } })
    expect(agent.session.events.filter(event => event.type === 'command/done')).toHaveLength(1)
  })

  it('rejects oversized and aborted input without queuing a turn', async () => {
    const root = await workspace()
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'review.md'), commandDocument('review'))
    const agent = createTestAgent('commands-bounds', root)
    const ctx = await commandContext([agent])
    await ctx.plugin(CustomCommandsService, { directory: 'commands', maxRawInputBytes: 4 })
    const oversized = await ctx.commands.execute(agent, '/review 你好', new AbortController().signal)
    expect(oversized?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('maximum is 4') })
    expect(agent.followup).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort(new Error('human canceled'))
    await expect(ctx.commands.execute(agent, '/review ok', controller.signal)).rejects.toThrow(/human canceled/)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('rejects forged, mismatched, and already-settled handler calls', async () => {
    const root = await workspace()
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'review.md'), commandDocument('review'))
    const agent = createTestAgent('commands-direct', root)
    const ctx = await commandContext([agent])
    await ctx.plugin(CustomCommandsService, { directory: 'commands' })
    const definition = ctx.commands.find(agent, 'review')
    const signal = new AbortController().signal
    expect(() => definition?.handler({
      agent, rawInput: ' forged', signal, commandId: 'forged' as CommandId,
    })).toThrow(/requires a direct human/)

    agent.session.append('command/run', {
      commandId: 'mismatch' as CommandId,
      name: 'other',
      args: ' input',
      source: { kind: 'user' },
    })
    expect(() => definition?.handler({
      agent, rawInput: ' input', signal, commandId: 'mismatch' as CommandId,
    })).toThrow(/exact direct human/)

    agent.session.append('command/run', {
      commandId: 'wrong-args' as CommandId,
      name: 'review',
      args: ' other',
      source: { kind: 'user' },
    })
    expect(() => definition?.handler({
      agent, rawInput: ' input', signal, commandId: 'wrong-args' as CommandId,
    })).toThrow(/exact direct human/)

    agent.session.append('command/run', {
      commandId: 'wrong-source' as CommandId,
      name: 'review',
      args: ' input',
      source: { kind: 'plugin', plugin: 'forged' } as never,
    })
    expect(() => definition?.handler({
      agent, rawInput: ' input', signal, commandId: 'wrong-source' as CommandId,
    })).toThrow(/exact direct human/)

    agent.session.append('command/run', {
      commandId: 'open' as CommandId,
      name: 'review',
      args: ' open',
      source: { kind: 'user' },
    })
    agent.session.append('command/run', {
      commandId: 'unrelated' as CommandId,
      name: 'other',
      args: '',
      source: { kind: 'user' },
    })
    expect(definition?.handler({
      agent, rawInput: ' open', signal, commandId: 'open' as CommandId,
    })).toMatchObject({ kind: 'success' })

    const execution = await ctx.commands.execute(agent, '/review real', signal)
    if (execution === undefined) throw new Error('fixture command was not executed')
    expect(() => definition?.handler({
      agent, rawInput: ' real', signal, commandId: execution.commandId,
    })).toThrow(/already settled/)
  })

  it('cleans registrations on agent disposal and plugin reload', async () => {
    const root = await workspace()
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'review.md'), commandDocument('review'))
    const agent = createTestAgent('commands-cleanup', root)
    const ctx = await commandContext([agent])
    const fiber = await ctx.plugin(CustomCommandsService, { directory: 'commands' })
    expect(ctx.commands.find(agent, 'review')).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'review')).toBeUndefined()

    const reloaded = await ctx.plugin(CustomCommandsService, { directory: 'commands' })
    expect(ctx.commands.find(agent, 'review')).toBeDefined()
    agentEvents(ctx, agent).emit('agent/disposed', {})
    expect(ctx.commands.find(agent, 'review')).toBeUndefined()
    agentEvents(ctx, agent).emit('agent/disposed', {})
    ctx.autopilotCustomCommands.mount(agent)
    expect(ctx.commands.find(agent, 'review')).toBeDefined()
    await reloaded.dispose()
  })

  it('mounts Agents created after service activation', async () => {
    const root = await workspace()
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'review.md'), commandDocument('review'))
    const ctx = await commandContext([])
    await ctx.plugin(CustomCommandsService, { directory: 'commands' })
    const agent = createTestAgent('commands-late', root)
    await ctx.plugin(Object.assign((inner: Context) => {
      const scope = createScope(inner, agent)
      Object.defineProperty(agent, 'ctx', { value: scope.ctx })
    }, { inject: ['commands'] }))
    ctx.agents.register(agent)
    expect(ctx.commands.find(agent, 'review')).toBeDefined()
  })

  it('rolls back earlier command registrations when a later name collides', async () => {
    const root = await workspace()
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'a.md'), commandDocument('a_command'))
    await writeFile(join(root, 'commands', 'b.md'), commandDocument('b_command'))
    const agent = createTestAgent('commands-collision', root)
    const ctx = await commandContext([agent])
    agent.ctx.commands.register({
      name: 'b_command',
      description: 'Existing command',
      handler: () => ({ kind: 'success' }),
    })
    await expect(ctx.plugin(CustomCommandsService, { directory: 'commands' })).rejects.toThrow(/already registered/)
    expect(ctx.commands.find(agent, 'a_command')).toBeUndefined()
    expect(ctx.commands.find(agent, 'b_command')).toBeDefined()
  })

  it('loads an absolute catalog for an Agent without a workspace', async () => {
    const root = await workspace()
    const catalog = join(root, 'commands')
    await mkdir(catalog)
    await writeFile(join(catalog, 'review.md'), commandDocument('review'))
    const agent = createTestAgent('commands-absolute')
    const ctx = await commandContext([agent])
    await ctx.plugin(CustomCommandsService, { directory: catalog })
    expect(ctx.commands.find(agent, 'review')).toBeDefined()
  })

  it('stays inert without a configured directory and mounts idempotently', async () => {
    const root = await workspace()
    const agent = createTestAgent('commands-disabled', root)
    const ctx = await commandContext([agent])
    await ctx.plugin(CustomCommandsService, {})
    ctx.autopilotCustomCommands.mount(agent)
    expect(ctx.commands.list(agent)).toEqual([])
  })
})
