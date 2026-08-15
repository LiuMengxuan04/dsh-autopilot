import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  apply as applySkillMcp,
  createSkillMcpPlugin,
  mountPublishedMcpClient,
  parseSkillMcpReferences,
  resolveSkillMcpConfig,
  SkillMcpLifecycle,
} from '../../src/skill-mcp.ts'
import type {
  Config,
  ResolvedSkillMcpServer,
  SkillMcpMount,
  SkillMcpMountHandle,
} from '../../src/skill-mcp.ts'
import { createHarness } from '../helpers.ts'

let callSequence = 0

const STDIO_SERVER = {
  id: 'docs',
  transport: 'stdio',
  serverName: 'docs',
  command: 'approved-docs-server',
  args: ['--stdio'],
  env: { DOCS_MODE: 'read-only' },
  cwd: '/deployment/mcp',
  toolCallTimeoutMs: 12_000,
} as const

const HTTP_SERVER = {
  id: 'issues',
  transport: 'streamable-http',
  serverName: 'issues',
  url: 'https://mcp.example.test/rpc?tenant=test',
  headers: { Authorization: 'Bearer deployment-owned' },
  toolCallTimeoutMs: 13_000,
} as const

const CONFIG: Config = {
  servers: [STDIO_SERVER, HTTP_SERVER],
  maxServersPerAgent: 2,
  allowedStdioCommands: ['approved-docs-server'],
  allowedHttpOrigins: ['https://mcp.example.test'],
}

function executeSkill(ctx: Context, agent: Agent, name: string, signal = new AbortController().signal) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`skill-mcp-${callSequence}`),
    name: 'skill',
    arguments: { name },
    agent,
    signal,
  })
}

function registerSkillTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'skill',
    description: 'Load a test Skill.',
    parameters: {
      name: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      if (args.name === 'tool-failure') throw new Error('skill body failed')
      const skill = await ctx.skills.get(args.name, {
        cwd: exec.agent?.session.header.cwd,
        signal: exec.signal,
        scope: exec.agent,
      })
      if (skill === undefined) throw new Error(`missing skill ${args.name}`)
      return { name: skill.name, provider: skill.provider, content: skill.content }
    },
  }))
}

function registerSkill(
  ctx: Context,
  name: string,
  mcpServers?: unknown,
): void {
  ctx.skills.register({
    name,
    description: `Use ${name}.`,
    source: 'runtime',
    content: `# ${name}`,
    ...(mcpServers === undefined ? {} : { metadata: { mcpServers } }),
  })
}

interface MountedTestServer {
  readonly scope: Context
  readonly config: ResolvedSkillMcpServer
  readonly handle: SkillMcpMountHandle
  readonly dispose: ReturnType<typeof vi.fn>
}

function testMount(outcomes: unknown[] = []): {
  readonly mount: ReturnType<typeof vi.fn<SkillMcpMount>>
  readonly mounted: MountedTestServer[]
} {
  const mounted: MountedTestServer[] = []
  const mount = vi.fn<SkillMcpMount>(async (scope, config) => {
    const outcome = outcomes.shift()
    if (outcome instanceof Error) throw outcome
    if (outcome !== undefined) return outcome as SkillMcpMountHandle
    const unregister = scope.tools.register(defineTool({
      name: `mcp__${config.serverName}__ping`,
      description: `Ping ${config.id}.`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async () => `pong:${config.id}`,
    }))
    const dispose = vi.fn(async () => { unregister() })
    const handle = { dispose }
    mounted.push({ scope, config, handle, dispose })
    return handle
  })
  return { mount, mounted }
}

async function setup(
  config: Config = CONFIG,
  mountFixture = testMount(),
  useFactory = true,
) {
  const harness = await createHarness()
  await harness.ctx.plugin(SkillRegistry)
  registerSkillTool(harness.ctx)
  let fiber: Fiber | undefined
  let lifecycle: SkillMcpLifecycle | undefined
  if (useFactory) {
    fiber = await harness.ctx.plugin(createSkillMcpPlugin(mountFixture.mount), config)
  } else {
    lifecycle = new SkillMcpLifecycle(harness.ctx, config, mountFixture.mount)
    lifecycle.apply()
  }
  return { ...harness, ...mountFixture, fiber, lifecycle }
}

async function startAutopilot(ctx: Context, agent: Agent): Promise<void> {
  const goal = ctx.goals.create(agent, { objective: 'Exercise on-demand MCP.', maxGoalRounds: 8 })
  await ctx.autonomy.start(agent, { goalId: goal.id, maxActiveMs: 60_000 })
}

function enterStepWithInvokedSkills(ctx: Context, agent: Agent, names: readonly string[]) {
  const dispose = ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return {
      kind: 'enter' as const,
      messages: [
        ...decision.messages,
        ...names.map(name => createUserMessage({
          content: [{ type: 'text', text: `<skill_content name="${name}">test</skill_content>` }],
          source: { kind: 'skill-invocation' as const, name, form: 'instructions' as const },
        })),
      ],
    }
  })
  const signal = new AbortController().signal
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] })).finally(dispose)
}

describe('Skill MCP metadata', () => {
  it('accepts a bounded unique lower-kebab-case reference list and freezes it', () => {
    const parsed = parseSkillMcpReferences(['docs', 'issue-tracker'], 'skill.metadata.mcpServers')
    expect(parsed).toEqual(['docs', 'issue-tracker'])
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it.each([
    [undefined, 'non-empty array'],
    [[], 'non-empty array'],
    [Array.from({ length: 9 }, (_, index) => `server-${index}`), 'at most 8'],
    [[3], 'lower-kebab-case'],
    [[' Bad '], 'lower-kebab-case'],
    [['docs', 'docs'], 'duplicate server ID'],
  ])('rejects invalid reference metadata %#', (value, message) => {
    expect(() => parseSkillMcpReferences(value, 'skill.metadata.mcpServers')).toThrow(message)
  })
})

describe('Skill MCP deployment policy', () => {
  it('materializes stdio and HTTP configs without granting Skill-owned execution fields', () => {
    const resolved = resolveSkillMcpConfig(CONFIG)
    expect(resolved.maxServersPerAgent).toBe(2)
    expect(resolved.servers.get('docs')).toEqual({
      ...STDIO_SERVER,
      failOnStartupError: true,
      reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 1 },
    })
    expect(resolved.servers.get('issues')).toEqual({
      ...HTTP_SERVER,
      url: 'https://mcp.example.test/rpc?tenant=test',
      failOnStartupError: true,
      reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 1 },
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.servers.get('docs'))).toBe(true)
  })

  it('applies inert defaults and transport field defaults', () => {
    expect(resolveSkillMcpConfig()).toMatchObject({ maxServersPerAgent: 4 })
    const resolved = resolveSkillMcpConfig({
      servers: [
        { id: 'local', transport: 'stdio', serverName: 'local', command: 'server' },
        { id: 'remote', transport: 'streamable-http', serverName: 'remote', url: 'http://127.0.0.1:4310/mcp' },
      ],
      allowedStdioCommands: ['server'],
      allowedHttpOrigins: ['http://127.0.0.1:4310'],
    })
    expect(resolved.servers.get('local')).toMatchObject({
      args: [], env: {}, cwd: '', toolCallTimeoutMs: 60_000,
    })
    expect(resolved.servers.get('remote')).toMatchObject({ headers: {}, toolCallTimeoutMs: 60_000 })
  })

  it.each([
    [null, 'must be an object'],
    [{ extra: true }, 'unsupported field "extra"'],
    [{ servers: 'bad' }, 'must be an array'],
    [{ servers: Array.from({ length: 33 }, () => STDIO_SERVER) }, 'at most 32'],
    [{ maxServersPerAgent: 0 }, 'positive integer'],
    [{ maxServersPerAgent: 9 }, 'no greater than 8'],
    [{ allowedStdioCommands: 'server' }, 'array of strings'],
    [{ allowedStdioCommands: ['server', 'server'] }, 'must not contain duplicates'],
    [{ allowedStdioCommands: [''] }, 'non-empty string'],
    [{ allowedHttpOrigins: ['not a URL'] }, 'Invalid URL'],
    [{ allowedHttpOrigins: ['ftp://example.test'] }, 'exact HTTP(S) origin'],
    [{ allowedHttpOrigins: ['https://user@example.test'] }, 'exact HTTP(S) origin'],
    [{ allowedHttpOrigins: ['https://example.test/path'] }, 'exact HTTP(S) origin'],
    [{ allowedHttpOrigins: ['https://example.test', 'https://example.test'] }, 'must not contain duplicates'],
    [{ servers: [null] }, 'must be an object'],
    [{ servers: [{ id: 'x', transport: 'socket', serverName: 'x' }] }, 'transport must be'],
    [{ servers: [{ ...STDIO_SERVER, extra: true }], allowedStdioCommands: ['approved-docs-server'] }, 'unsupported field'],
    [{ servers: [{ ...HTTP_SERVER, extra: true }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'unsupported field'],
    [{ servers: [{ ...STDIO_SERVER, id: 'Bad_Name' }], allowedStdioCommands: ['approved-docs-server'] }, '.id must be'],
    [{ servers: [STDIO_SERVER, { ...STDIO_SERVER }], allowedStdioCommands: ['approved-docs-server'] }, 'duplicate server ID'],
    [{ servers: [STDIO_SERVER, { ...HTTP_SERVER, serverName: 'docs' }], allowedStdioCommands: ['approved-docs-server'], allowedHttpOrigins: ['https://mcp.example.test'] }, 'duplicate serverName'],
    [{ servers: [{ ...STDIO_SERVER, serverName: 'bad namespace!' }], allowedStdioCommands: ['approved-docs-server'] }, '.serverName must be'],
    [{ servers: [{ ...STDIO_SERVER, toolCallTimeoutMs: 0 }], allowedStdioCommands: ['approved-docs-server'] }, '.toolCallTimeoutMs must be'],
    [{ servers: [{ ...STDIO_SERVER, command: '' }], allowedStdioCommands: ['approved-docs-server'] }, '.command must be'],
    [{ servers: [STDIO_SERVER] }, 'not in allowedStdioCommands'],
    [{ servers: [{ ...STDIO_SERVER, args: 'bad' }], allowedStdioCommands: ['approved-docs-server'] }, '.args must be'],
    [{ servers: [{ ...STDIO_SERVER, args: ['ok', ''] }], allowedStdioCommands: ['approved-docs-server'] }, '.args[1]'],
    [{ servers: [{ ...STDIO_SERVER, env: [] }], allowedStdioCommands: ['approved-docs-server'] }, '.env must be an object'],
    [{ servers: [{ ...STDIO_SERVER, env: { 'BAD-NAME': 'x' } }], allowedStdioCommands: ['approved-docs-server'] }, 'invalid key'],
    [{ servers: [{ ...STDIO_SERVER, cwd: 'relative' }], allowedStdioCommands: ['approved-docs-server'] }, '.cwd must be an absolute path'],
    [{ servers: [{ ...HTTP_SERVER, url: 'not a URL' }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'absolute HTTP(S) URL'],
    [{ servers: [{ ...HTTP_SERVER, url: 'ftp://mcp.example.test/rpc' }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'without credentials'],
    [{ servers: [{ ...HTTP_SERVER, url: 'https://user@mcp.example.test/rpc' }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'without credentials'],
    [{ servers: [{ ...HTTP_SERVER, url: 'https://mcp.example.test/rpc#fragment' }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'without credentials'],
    [{ servers: [HTTP_SERVER], allowedHttpOrigins: ['https://elsewhere.test'] }, 'not in allowedHttpOrigins'],
    [{ servers: [{ ...HTTP_SERVER, headers: [] }], allowedHttpOrigins: ['https://mcp.example.test'] }, '.headers must be an object'],
    [{ servers: [{ ...HTTP_SERVER, headers: { 'bad header': 'x' } }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'invalid key'],
    [{ servers: [{ ...HTTP_SERVER, headers: { Good: 'line\nbreak' } }], allowedHttpOrigins: ['https://mcp.example.test'] }, 'must not contain line breaks'],
  ])('rejects invalid or unauthorized config %#', (config, message) => {
    expect(() => resolveSkillMcpConfig(config as Config)).toThrow(message)
  })
})

describe('on-demand Skill MCP lifecycle', () => {
  it('mounts MCP for DSH direct Skill invocation messages before the model step enters', async () => {
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    })
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    registerSkill(harness.ctx, 'ordinary')
    await startAutopilot(harness.ctx, harness.agent)

    const decision = await enterStepWithInvokedSkills(
      harness.ctx,
      harness.agent,
      ['mcp-tools', 'mcp-tools', 'ordinary'],
    )

    expect(decision.kind).toBe('enter')
    expect(harness.mount).toHaveBeenCalledOnce()
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeDefined()
  })

  it('passes a rejected or ordinary proposed step without mounting a server', async () => {
    const harness = await setup()
    const signal = new AbortController().signal
    await expect(agentEvents(harness.ctx, harness.agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal,
    }, () => Promise.resolve({ kind: 'reject' as const }))).resolves.toEqual({ kind: 'reject' })
    await expect(agentEvents(harness.ctx, harness.agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 2, signal,
    }, () => Promise.resolve({
      kind: 'enter' as const,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ordinary' }], source: { kind: 'user' } })],
    }))).resolves.toMatchObject({ kind: 'enter' })
    expect(harness.mount).not.toHaveBeenCalled()
  })

  it('mounts allowlisted servers only after an exact successful active-Goal Skill result', async () => {
    const harness = await setup()
    registerSkill(harness.ctx, 'mcp-tools', ['docs', 'issues'])
    await startAutopilot(harness.ctx, harness.agent)

    const result = await executeSkill(harness.ctx, harness.agent, 'mcp-tools')

    expect(result.isError).toBe(false)
    expect(harness.mount).toHaveBeenCalledTimes(2)
    expect(harness.mount.mock.calls.map(call => call[0])).toEqual([harness.agent.ctx, harness.agent.ctx])
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeDefined()
    expect(harness.ctx.tools.get('mcp__issues__ping', harness.agent)).toBeDefined()
    expect(harness.ctx.tools.get('mcp__docs__ping')).toBeUndefined()
  })

  it('deduplicates repeated and concurrent requests for each Agent', async () => {
    const harness = await setup({
      servers: [STDIO_SERVER],
      maxServersPerAgent: 1,
      allowedStdioCommands: ['approved-docs-server'],
    })
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)

    const results = await Promise.all([
      executeSkill(harness.ctx, harness.agent, 'mcp-tools'),
      executeSkill(harness.ctx, harness.agent, 'mcp-tools'),
      executeSkill(harness.ctx, harness.agent, 'mcp-tools'),
    ])

    expect(results.every(result => !result.isError)).toBe(true)
    expect(harness.mount).toHaveBeenCalledTimes(1)
  })

  it('does nothing for ordinary Skills, failed tools, non-Skill tools, and malformed successful results', async () => {
    const harness = await setup()
    registerSkill(harness.ctx, 'ordinary')
    registerSkill(harness.ctx, 'tool-failure', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    harness.ctx.tools.register(defineTool({
      name: 'other', description: 'Other.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'ok',
    }))

    expect((await executeSkill(harness.ctx, harness.agent, 'ordinary')).isError).toBe(false)
    expect((await executeSkill(harness.ctx, harness.agent, 'tool-failure')).isError).toBe(true)
    expect((await harness.ctx.tools.execute({
      callId: CallId('skill-mcp-other'), name: 'other', arguments: {}, agent: harness.agent,
      signal: new AbortController().signal,
    })).isError).toBe(false)
    expect(harness.mount).not.toHaveBeenCalled()

    const original = harness.ctx.tools.get('skill', harness.agent)
    expect(original).toBeDefined()
    const dispose = harness.agent.ctx.tools.register(defineTool({
      name: 'skill', description: 'Malformed shadow.', parameters: { name: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => ({ name: 'different' }),
    }))
    expect((await executeSkill(harness.ctx, harness.agent, 'ordinary')).isError).toBe(false)
    expect(harness.mount).not.toHaveBeenCalled()
    dispose()
  })

  it('fails the Skill call outside exact Autopilot authority or outside the deployment allowlist', async () => {
    const harness = await setup()
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    registerSkill(harness.ctx, 'unauthorized-server', ['private-server'])

    const inactive = await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    expect(inactive).toMatchObject({ isError: true, error: { message: expect.stringContaining('exact active Autopilot Goal') } })
    expect(harness.mount).not.toHaveBeenCalled()

    await startAutopilot(harness.ctx, harness.agent)
    const denied = await executeSkill(harness.ctx, harness.agent, 'unauthorized-server')
    expect(denied).toMatchObject({ isError: true, error: { message: expect.stringContaining('outside the deployment allowlist') } })
    expect(harness.mount).not.toHaveBeenCalled()
  })

  it('fails explicitly, rolls back partial startup, and permits a clean retry', async () => {
    const fixture = testMount([undefined, new Error('remote startup failed')])
    const harness = await setup(CONFIG, fixture)
    registerSkill(harness.ctx, 'mcp-tools', ['docs', 'issues'])
    await startAutopilot(harness.ctx, harness.agent)

    const failed = await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    expect(failed).toMatchObject({ isError: true, error: { message: expect.stringContaining('remote startup failed') } })
    expect(harness.mounted[0]?.dispose).toHaveBeenCalledOnce()
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeUndefined()

    const retried = await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    expect(retried.isError).toBe(false)
    expect(harness.mount).toHaveBeenCalledTimes(4)
  })

  it('reports malformed mount handles and rollback disposal failures', async () => {
    const malformed = await setup(CONFIG, testMount([{}]))
    registerSkill(malformed.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(malformed.ctx, malformed.agent)
    expect(await executeSkill(malformed.ctx, malformed.agent, 'mcp-tools')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('did not return a disposable handle') },
    })

    const disposeError = new Error('rollback disposal failed')
    const fixture = testMount()
    fixture.mount.mockImplementationOnce(async () => {
      return { dispose: vi.fn(async () => { throw disposeError }) }
    }).mockRejectedValueOnce(new Error('second startup failed'))
    const rollback = await setup(CONFIG, fixture)
    registerSkill(rollback.ctx, 'mcp-tools', ['docs', 'issues'])
    await startAutopilot(rollback.ctx, rollback.agent)
    expect(await executeSkill(rollback.ctx, rollback.agent, 'mcp-tools')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('startup and rollback failed') },
    })
  })

  it('disposes a just-started server when exact Goal authority changes during startup', async () => {
    const dispose = vi.fn(async () => {})
    const fixture = testMount()
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture)
    fixture.mount.mockImplementationOnce(async () => {
      harness.ctx.goals.disarm(harness.agent)
      return { dispose }
    })
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)

    expect(await executeSkill(harness.ctx, harness.agent, 'mcp-tools')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('exact active Autopilot Goal') },
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rolls back only the new server when an existing mount remains authorized to the prior run', async () => {
    const fixture = testMount()
    const harness = await setup(CONFIG, fixture)
    registerSkill(harness.ctx, 'docs-only', ['docs'])
    registerSkill(harness.ctx, 'issues-only', ['issues'])
    await startAutopilot(harness.ctx, harness.agent)
    expect((await executeSkill(harness.ctx, harness.agent, 'docs-only')).isError).toBe(false)
    const mountNormally = fixture.mount.getMockImplementation()!
    fixture.mount.mockImplementationOnce(async (scope, config) => {
      const handle = await mountNormally(scope, config)
      harness.ctx.goals.disarm(harness.agent)
      return handle
    })

    expect(await executeSkill(harness.ctx, harness.agent, 'issues-only')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('exact active Autopilot Goal') },
    })
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeDefined()
    expect(harness.ctx.tools.get('mcp__issues__ping', harness.agent)).toBeUndefined()
  })

  it('rejects a server started for a superseded Autopilot run', async () => {
    const dispose = vi.fn(async () => {})
    const fixture = testMount()
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture)
    fixture.mount.mockImplementationOnce(async () => {
      await harness.ctx.autonomy.revoke(harness.agent, 'replace during MCP startup')
      const oldGoal = harness.ctx.goals.get(harness.agent)!
      harness.ctx.goals.clear(harness.agent, { id: oldGoal.id, revision: oldGoal.revision })
      const nextGoal = harness.ctx.goals.create(harness.agent, {
        objective: 'Replacement run.', maxGoalRounds: 8,
      })
      await harness.ctx.autonomy.start(harness.agent, { goalId: nextGoal.id, maxActiveMs: 60_000 })
      return { dispose }
    })
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)

    expect(await executeSkill(harness.ctx, harness.agent, 'mcp-tools')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('authorization changed during MCP startup') },
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('enforces the per-Agent server limit before starting additions', async () => {
    const harness = await setup({ ...CONFIG, maxServersPerAgent: 1 })
    registerSkill(harness.ctx, 'docs-only', ['docs'])
    registerSkill(harness.ctx, 'issues-only', ['issues'])
    await startAutopilot(harness.ctx, harness.agent)
    expect((await executeSkill(harness.ctx, harness.agent, 'docs-only')).isError).toBe(false)
    expect(await executeSkill(harness.ctx, harness.agent, 'issues-only')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('limit of 1') },
    })
    expect(harness.mount).toHaveBeenCalledTimes(1)
  })

  it('unloads on pause, terminal state, Agent disposal, and plugin HMR disposal', async () => {
    const paused = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    })
    registerSkill(paused.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(paused.ctx, paused.agent)
    await executeSkill(paused.ctx, paused.agent, 'mcp-tools')
    await paused.ctx.autonomy.pause(paused.agent, 'test pause')
    await vi.waitFor(() => expect(paused.mounted[0]?.dispose).toHaveBeenCalledOnce())

    const terminal = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    })
    registerSkill(terminal.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(terminal.ctx, terminal.agent)
    await executeSkill(terminal.ctx, terminal.agent, 'mcp-tools')
    await terminal.ctx.autonomy.revoke(terminal.agent, 'test revoke')
    await vi.waitFor(() => expect(terminal.mounted[0]?.dispose).toHaveBeenCalledOnce())

    const disposed = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, testMount(), false)
    registerSkill(disposed.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(disposed.ctx, disposed.agent)
    await executeSkill(disposed.ctx, disposed.agent, 'mcp-tools')
    disposed.ctx.emit('agent/disposed', { agent: disposed.agent })
    await disposed.lifecycle?.whenIdle()
    expect(disposed.mounted[0]?.dispose).toHaveBeenCalledOnce()

    const hmr = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    })
    registerSkill(hmr.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(hmr.ctx, hmr.agent)
    await executeSkill(hmr.ctx, hmr.agent, 'mcp-tools')
    await hmr.fiber?.dispose()
    expect(hmr.mounted[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('rejects new Skill activation while HMR teardown is draining a server', async () => {
    const draining = Promise.withResolvers<void>()
    const postGate = Promise.withResolvers<void>()
    const enteredPost = Promise.withResolvers<void>()
    const fixture = testMount()
    const dispose = vi.fn(() => draining.promise)
    fixture.mount.mockResolvedValue({ dispose })
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture)
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    harness.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const decision = await next()
      enteredPost.resolve()
      await postGate.promise
      return decision
    })

    const pending = executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    await enteredPost.promise
    const unloading = harness.fiber!.dispose()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    try {
      postGate.resolve()
      expect(await pending).toMatchObject({
        isError: true,
        error: { message: expect.stringContaining('lifecycle is unloading') },
      })
    } finally {
      draining.resolve()
      await unloading
    }
  })

  it('surfaces teardown failures from Autopilot lifecycle and HMR', async () => {
    const fixture = testMount()
    fixture.mount.mockResolvedValue({ dispose: vi.fn(async () => { throw new Error('dispose failed') }) })
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture)
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    await expect(harness.ctx.autonomy.pause(harness.agent, 'teardown failure')).resolves.toBeDefined()

    const hmrFixture = testMount()
    hmrFixture.mount.mockResolvedValue({ dispose: vi.fn(async () => { throw new Error('dispose failed') }) })
    const hmr = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, hmrFixture)
    registerSkill(hmr.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(hmr.ctx, hmr.agent)
    await executeSkill(hmr.ctx, hmr.agent, 'mcp-tools')
    const logged = vi.spyOn(hmr.fiber!.ctx.logger, 'error')
    await hmr.fiber?.dispose()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'Skill MCP unload failed' }))
  })

  it('retains failed cleanup, blocks a model step, and retries without a duplicate mount', async () => {
    const fixture = testMount()
    let first = true
    fixture.mount.mockImplementation(async (scope, config) => {
      const unregister = scope.tools.register(defineTool({
        name: `mcp__${config.serverName}__ping`,
        description: `Ping ${config.id}.`,
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => `pong:${config.id}`,
      }))
      const isFirst = first
      first = false
      let attempts = 0
      const dispose = vi.fn(async () => {
        attempts += 1
        if (isFirst && attempts <= 4) throw new Error(`cleanup attempt ${attempts} failed`)
        unregister()
      })
      const handle = { dispose }
      fixture.mounted.push({ scope, config, handle, dispose })
      return handle
    })
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture, false)
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    await executeSkill(harness.ctx, harness.agent, 'mcp-tools')

    await harness.ctx.autonomy.pause(harness.agent, 'exercise retained cleanup debt')
    await vi.waitFor(() => expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(2))
    await harness.lifecycle?.whenIdle()
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      phase: 'needs-attention', activation: 'disarmed',
    })
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeDefined()

    expect(await executeSkill(harness.ctx, harness.agent, 'mcp-tools')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('Skill MCP server disposal failed') },
    })
    expect(harness.mount).toHaveBeenCalledOnce()
    expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(3)

    await expect(agentEvents(harness.ctx, harness.agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 2, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))).rejects.toThrow('Skill MCP server disposal failed')
    expect(harness.mount).toHaveBeenCalledOnce()
    expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(4)

    await harness.lifecycle?.retryCleanup(harness.agent)
    await harness.lifecycle?.retryCleanup(harness.agent)
    expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(5)
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeUndefined()

    const goal = harness.ctx.goals.get(harness.agent)!
    await harness.ctx.autonomy.resume(harness.agent, goal.id)
    harness.ctx.goals.resume(harness.agent, { id: goal.id, revision: goal.revision })
    expect((await executeSkill(harness.ctx, harness.agent, 'mcp-tools')).isError).toBe(false)
    expect(harness.mount).toHaveBeenCalledTimes(2)
  })

  it('carries HMR cleanup debt into a replacement lifecycle for an explicit retry', async () => {
    const fixture = testMount()
    fixture.mount.mockImplementationOnce(async (scope, config) => {
      const unregister = scope.tools.register(defineTool({
        name: `mcp__${config.serverName}__ping`, description: 'Ping.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'pong',
      }))
      let attempts = 0
      const dispose = vi.fn(async () => {
        attempts += 1
        if (attempts <= 2) throw new Error('HMR cleanup still blocked')
        unregister()
      })
      const handle = { dispose }
      fixture.mounted.push({ scope, config, handle, dispose })
      return handle
    })
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture)
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    await executeSkill(harness.ctx, harness.agent, 'mcp-tools')

    await harness.fiber?.dispose()
    expect(fixture.mounted[0]?.dispose).toHaveBeenCalledOnce()
    const replacement = new SkillMcpLifecycle(harness.ctx, {
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture.mount)
    await expect(replacement.retryCleanup(harness.agent)).rejects.toThrow('Skill MCP server disposal failed')
    await replacement.retryCleanup(harness.agent)

    expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(3)
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeUndefined()
  })

  it.each([
    ['revoke', 1, 'revoked'],
    ['agent disposal', 2, 'needs-attention'],
  ] as const)('retains cleanup debt after %s until an explicit retry succeeds', async (
    trigger,
    failedAttempts,
    phase,
  ) => {
    const fixture = testMount()
    let cleanupAllowed = false
    fixture.mount.mockImplementationOnce(async (scope, config) => {
      const unregister = scope.tools.register(defineTool({
        name: `mcp__${config.serverName}__ping`, description: 'Ping.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'pong',
      }))
      const dispose = vi.fn(async () => {
        if (!cleanupAllowed) throw new Error(`${trigger} cleanup blocked`)
        unregister()
      })
      const handle = { dispose }
      fixture.mounted.push({ scope, config, handle, dispose })
      return handle
    })
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture, false)
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    await executeSkill(harness.ctx, harness.agent, 'mcp-tools')

    if (trigger === 'revoke') {
      await harness.ctx.autonomy.revoke(harness.agent, 'terminal cleanup exercise')
    } else {
      harness.ctx.emit('agent/disposed', { agent: harness.agent })
    }
    await vi.waitFor(() => expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(failedAttempts))
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ phase })
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeDefined()
    expect(harness.mount).toHaveBeenCalledOnce()

    cleanupAllowed = true
    await harness.lifecycle?.retryCleanup(harness.agent)
    expect(fixture.mounted[0]?.dispose).toHaveBeenCalledTimes(failedAttempts + 1)
    expect(harness.ctx.tools.get('mcp__docs__ping', harness.agent)).toBeUndefined()
  })

  it('logs an Agent-disposal teardown failure instead of creating an unhandled rejection', async () => {
    const fixture = testMount()
    fixture.mount.mockResolvedValue({ dispose: vi.fn(async () => { throw new Error('agent dispose failed') }) })
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    }, fixture, false)
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    const logged = vi.spyOn(harness.ctx.logger, 'error')

    harness.ctx.emit('agent/disposed', { agent: harness.agent })
    await harness.lifecycle?.whenIdle()

    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('failed to unload Skill MCP servers for disposed Agent'),
    ))
  })

  it('rejects malformed provider metadata and a Skill that disappears during activation', async () => {
    const harness = await setup()
    registerSkill(harness.ctx, 'malformed', 'docs')
    await startAutopilot(harness.ctx, harness.agent)
    expect(await executeSkill(harness.ctx, harness.agent, 'malformed')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('non-empty array') },
    })
    expect(harness.mount).not.toHaveBeenCalled()

    const dispose = harness.ctx.skills.register({
      name: 'disappearing', description: 'Disappears in post-processing.', source: 'runtime',
      content: '# Disappearing', metadata: { mcpServers: ['docs'] },
    })
    harness.ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name === 'skill') dispose()
      return decision
    })
    expect(await executeSkill(harness.ctx, harness.agent, 'disappearing')).toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('disappeared before MCP activation') },
    })
  })

  it('accepts verifying authority, a downstream value projection, and active lifecycle changes', async () => {
    const harness = await setup({
      servers: [STDIO_SERVER], maxServersPerAgent: 1, allowedStdioCommands: ['approved-docs-server'],
    })
    registerSkill(harness.ctx, 'mcp-tools', ['docs'])
    await startAutopilot(harness.ctx, harness.agent)
    const active = harness.ctx.autonomy.get(harness.agent)!
    const get = vi.spyOn(harness.ctx.autonomy, 'get').mockReturnValue({ ...active, phase: 'verifying' })
    await harness.ctx.parallel('autonomy/changed', {
      agent: harness.agent,
      operation: 'plan',
      view: active,
    })
    get.mockRestore()
    harness.ctx.on('tools/post-execute', async (_exec, result, next) => {
      await next()
      return result.isError ? { kind: 'accept' } : { kind: 'accept', value: result.value }
    })

    const result = await executeSkill(harness.ctx, harness.agent, 'mcp-tools')
    expect(result.isError).toBe(false)
    expect(harness.mount).toHaveBeenCalledOnce()
  })

  it('ignores a successful shadow Skill result without a string Skill name', async () => {
    const harness = await setup()
    await startAutopilot(harness.ctx, harness.agent)
    harness.agent.ctx.tools.register(defineTool({
      name: 'skill', description: 'Nonstandard shadow.', parameters: { name: { type: 'json' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          content: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.content }],
      },
      execute: async () => ({ name: 'mcp-tools', provider: 'shadow', content: 'shadow' }),
    }))
    callSequence += 1
    const result = await harness.ctx.tools.execute({
      callId: CallId(`skill-mcp-${callSequence}`), name: 'skill', arguments: { name: 7 },
      agent: harness.agent, signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(harness.mount).not.toHaveBeenCalled()
  })
})

describe('published MCP namespace mount', () => {
  it('mounts the loaded root namespace plugin without forwarding the deployment-only ID', async () => {
    const harness = await createHarness()
    const seen: unknown[] = []
    const plugin: Plugin.Object<unknown> = {
      name: 'fake-mcp-client',
      apply(_ctx: Context, config: unknown) { seen.push(config) },
    }
    const server = resolveSkillMcpConfig({
      servers: [STDIO_SERVER], allowedStdioCommands: ['approved-docs-server'],
    }).servers.get('docs')
    expect(server).toBeDefined()
    const fiber = await mountPublishedMcpClient(harness.agent.ctx, server!, async () => plugin)
    expect(seen).toEqual([expect.not.objectContaining({ id: 'docs' })])
    expect(seen).toEqual([expect.objectContaining({ transport: 'stdio', failOnStartupError: true })])
    await fiber.dispose()
  })

  it('rejects a non-plugin module and reports a missing published dependency', async () => {
    const harness = await createHarness()
    const server = resolveSkillMcpConfig({
      servers: [STDIO_SERVER], allowedStdioCommands: ['approved-docs-server'],
    }).servers.get('docs')!
    await expect(mountPublishedMcpClient(harness.agent.ctx, server, async () => ({})))
      .rejects.toThrow('root export is not a namespace plugin')
    await expect(mountPublishedMcpClient(harness.agent.ctx, server)).rejects.toThrow()
  })

  it('keeps the default apply entrypoint inert without referenced servers', async () => {
    const harness = await createHarness()
    await harness.ctx.plugin(SkillRegistry)
    const fiber = await harness.ctx.plugin({ name: 'default-skill-mcp', inject, apply: applySkillMcp }, {})
    await fiber.dispose()
  })
})

const inject = ['agents', 'autonomy', 'goals', 'skills', 'tools']
