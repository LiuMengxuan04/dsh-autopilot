import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { MissionSnapshot } from '../../src/mission-state.ts'
import { apply, missionJson } from '../../src/tool-mission.ts'
import { createTestAgent } from '../helpers.ts'

function snapshot(overrides: Partial<MissionSnapshot> = {}): MissionSnapshot {
  return {
    version: 1,
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    goalId: 'goal',
    missionId: 'queue-12345678',
    dagTaskId: 'mission-queue-12345678',
    revision: 1,
    source: { path: '/workspace/mission.md', sha256: 'a'.repeat(64), bytes: 4 },
    phase: 'planned',
    continueOnError: false,
    tasks: [{ id: 'task-001', prompt: 'work', status: 'planned', attempts: [], updatedAt: 1 }],
    maxAuditRecords: 100,
    maxAuditBytes: 100_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function fileSystem(overrides: Record<string, unknown> = {}) {
  const target = { displayPath: '/workspace/mission.md' }
  return {
    lstat: vi.fn(async () => ({ type: 'file' })),
    resolve: vi.fn(async (path: string) => path === '.' ? { displayPath: '/workspace' } : target),
    contains: vi.fn(() => true),
    stat: vi.fn(async () => ({ type: 'file', version: 'v1' })),
    readBytes: vi.fn(async () => new TextEncoder().encode('Do work')),
    ...overrides,
  }
}

async function toolHarness(options: {
  readonly fs?: ReturnType<typeof fileSystem> | false
  readonly lease?: unknown
  readonly mission?: MissionSnapshot
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const value = options.mission ?? snapshot()
  const service = {
    limits: { maxTasks: 8, maxPromptChars: 100, maxTotalPromptChars: 400, maxSourceBytes: 1024 },
    plan: vi.fn(async (_agent: unknown, _request: unknown) => value),
    resume: vi.fn(async (_agent: unknown, _missionId: unknown, _policy: unknown) => value),
    rerun: vi.fn(async (_agent: unknown, _missionId: unknown, _taskId: unknown, _policy: unknown) => value),
    mark: vi.fn(async (_agent: unknown, _request: unknown) => value),
    status: vi.fn(() => options.mission),
    listRun: vi.fn(() => [value]),
    history: vi.fn(() => [{ version: 1, operation: 'plan', time: 1, snapshot: value }]),
  }
  ctx.provide('autopilotMissions', service as never)
  ctx.provide('autonomy', { get: vi.fn(() => options.lease) } as never)
  if (options.fs !== false) ctx.provide('fs', (options.fs ?? fileSystem()) as never)
  apply(ctx, {
    routes: [],
    routingPreference: 'declared',
    toolAllowlist: ['bash'],
    startSubagent: vi.fn(),
  })
  const agent = createTestAgent('mission-tool-agent', '/workspace')
  return { ctx, agent, service }
}

let call = 0

function execute(ctx: Context, name: string, args: unknown, agent?: ReturnType<typeof createTestAgent>) {
  call += 1
  return ctx.tools.execute({
    callId: CallId(`mission-tool-${call}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

describe('mission tool', () => {
  it('projects optional task, attempt, and mission fields without undefined JSON values', () => {
    expect(missionJson(snapshot())).toMatchObject({ phase: 'planned', tasks: [{ attempts: [] }] })
    const completed = snapshot({
      phase: 'needs-attention',
      reason: 'operator check',
      updatedAt: 2,
      tasks: [{
        id: 'task-001', prompt: 'work', status: 'failed', reason: 'failed', updatedAt: 2,
        attempts: [{
          number: 1, startedAt: 1, finishedAt: 2, status: 'failed', summary: 'failed',
          evidence: [{ kind: 'test', ref: 'test', summary: 'failed' }],
          childSessionId: 'child',
        }],
      }],
    })
    expect(missionJson(completed)).toMatchObject({
      reason: 'operator check',
      tasks: [{ reason: 'failed', attempts: [{ childSessionId: 'child' }] }],
    })
    const withoutChild = {
      ...completed,
      tasks: [{
        ...completed.tasks[0]!,
        attempts: [{ ...completed.tasks[0]!.attempts[0]!, childSessionId: undefined }],
      }],
    } as MissionSnapshot
    expect(missionJson(withoutChild)).toMatchObject({ tasks: [{ attempts: [{ summary: 'failed' }] }] })
  })

  it('requires an Agent workspace and DSH filesystem service', async () => {
    const agentless = await toolHarness()
    await expect(execute(agentless.ctx, 'autopilot_mission', { action: 'status' })).resolves.toMatchObject({
      isError: true, error: { message: expect.stringContaining('Agent-backed') },
    })

    const noWorkspace = await toolHarness()
    const agent = createTestAgent('mission-no-workspace')
    await expect(execute(noWorkspace.ctx, 'autopilot_mission', { action: 'plan', path: 'mission.md' }, agent))
      .resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('Agent workspace') } })

    const noFs = await toolHarness({ fs: false })
    await expect(execute(noFs.ctx, 'autopilot_mission', { action: 'plan', path: 'mission.md' }, noFs.agent))
      .resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('filesystem service') } })
  })

  it.each([
    [{ lstat: vi.fn(async () => ({ type: 'symlink' })) }, 'symbolic link'],
    [{ lstat: vi.fn(async () => ({ type: 'directory' })) }, 'regular file'],
    [{ contains: vi.fn(() => false) }, 'inside the Agent workspace'],
    [{ stat: vi.fn(async () => ({ type: 'directory', version: 'v1' })) }, 'resolve to a regular file'],
  ])('rejects unsafe mission source metadata %#', async (overrides, message) => {
    const base = await toolHarness({ fs: fileSystem(overrides) })
    await expect(execute(base.ctx, 'autopilot_mission', { action: 'plan', path: 'mission.md' }, base.agent))
      .resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining(message) } })
  })

  it('rejects a changing or invalid UTF-8 source', async () => {
    const changingFs = fileSystem()
    changingFs.stat
      .mockResolvedValueOnce({ type: 'file', version: 'v1' })
      .mockResolvedValueOnce({ type: 'file', version: 'v2' })
    const changing = await toolHarness({ fs: changingFs })
    await expect(execute(changing.ctx, 'autopilot_mission', { action: 'plan', path: 'mission.md' }, changing.agent))
      .resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('changed while') } })

    const invalidFs = fileSystem({ readBytes: vi.fn(async () => Uint8Array.of(0xff)) })
    const invalid = await toolHarness({ fs: invalidFs })
    await expect(execute(invalid.ctx, 'autopilot_mission', { action: 'plan', path: 'mission.md' }, invalid.agent))
      .resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('valid UTF-8') } })
  })

  it('plans sources and dispatches every operator action through the same service', async () => {
    const value = snapshot()
    const base = await toolHarness({ lease: { id: 'run', generation: 1 }, mission: value })
    await expect(execute(base.ctx, 'autopilot_mission', { action: 'plan', path: 'mission.md' }, base.agent))
      .resolves.toMatchObject({ isError: false, value: { missionId: value.missionId } })
    expect(base.service.plan.mock.calls[0]?.[1]).not.toHaveProperty('continueOnError')
    await execute(base.ctx, 'autopilot_mission', {
      action: 'plan', path: 'mission.md', continueOnError: true,
    }, base.agent)
    expect(base.service.plan).toHaveBeenLastCalledWith(base.agent, expect.objectContaining({ continueOnError: true }))

    await expect(execute(base.ctx, 'autopilot_mission', { action: 'audit' }, base.agent))
      .resolves.toMatchObject({ isError: false, value: [{ operation: 'plan' }] })
    await expect(execute(base.ctx, 'autopilot_mission', { action: 'status' }, base.agent))
      .resolves.toMatchObject({ isError: false, value: [{ missionId: value.missionId }] })
    await expect(execute(base.ctx, 'autopilot_mission', {
      action: 'status', missionId: value.missionId,
    }, base.agent)).resolves.toMatchObject({ isError: false, value: { missionId: value.missionId } })
    await execute(base.ctx, 'autopilot_mission', { action: 'resume', missionId: value.missionId }, base.agent)
    await execute(base.ctx, 'autopilot_mission', {
      action: 'rerun', missionId: value.missionId, taskId: 'task-001',
    }, base.agent)
    await execute(base.ctx, 'autopilot_mission', {
      action: 'mark', missionId: value.missionId, taskId: 'task-001', status: 'blocked', reason: 'hold',
    }, base.agent)
    expect(base.service.resume).toHaveBeenCalledOnce()
    expect(base.service.rerun).toHaveBeenCalledOnce()
    expect(base.service.mark).toHaveBeenCalledOnce()
  })

  it('renders empty and missing status and rejects incomplete action arguments', async () => {
    const noLease = await toolHarness()
    await expect(execute(noLease.ctx, 'autopilot_mission', { action: 'plan' }, noLease.agent))
      .resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('requires path') } })
    await expect(execute(noLease.ctx, 'autopilot_mission', { action: 'status' }, noLease.agent))
      .resolves.toMatchObject({ isError: false, value: [] })
    await expect(execute(noLease.ctx, 'autopilot_mission', {
      action: 'status', missionId: 'missing-12345678',
    }, noLease.agent)).resolves.toMatchObject({
      isError: false, value: { status: 'missing', missionId: 'missing-12345678' },
    })
    for (const [args, message] of [
      [{ action: 'audit', limit: 0 }, 'integer from 1 to 200'],
      [{ action: 'resume' }, 'requires missionId'],
      [{ action: 'rerun', missionId: 'queue-12345678' }, 'requires taskId'],
      [{ action: 'mark', missionId: 'queue-12345678', taskId: 'task-001' }, 'requires status and reason'],
    ] as const) {
      await expect(execute(noLease.ctx, 'autopilot_mission', args, noLease.agent)).resolves.toMatchObject({
        isError: true, error: { message: expect.stringContaining(message) },
      })
    }
  })
})
