import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import ProjectMemoryService from '../../src/memory.ts'
import * as memoryTools from '../../src/tool-memory.ts'
import type { RunTask } from '../../src/run-state.ts'
import type { AutonomyLeaseView } from '../../src/service.ts'
import { createHarness, prepareTestPlan } from '../helpers.ts'

let callSequence = 0

function executeMemoryTool(ctx: Context, agent: Agent, name: string, args: unknown) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`memory-call-${callSequence}`),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

describe('project memory tools', () => {
  it('writes, lists, reads, deletes, and records a durable handoff under active authorization', async () => {
    const { ctx, agent } = await createHarness({ cwd: '/workspace' })
    await ctx.plugin(ProjectMemoryService)
    await ctx.plugin(memoryTools)
    await ctx.commands.execute(agent, '/autopilot start remember this project', new AbortController().signal)
    await prepareTestPlan(ctx, agent, ['handoff is inspectable'], [{
      id: 'document',
      title: 'Document the state',
      description: 'Preserve one task with a reason in the handoff.',
      acceptanceCriteria: ['reason is retained'],
    }, {
      id: 'continue',
      title: 'Continue later',
      description: 'Remain pending for the next session.',
      acceptanceCriteria: ['next action is visible'],
    }])
    await ctx.autonomy.updateTask(agent, 'document', 'start')
    await ctx.autonomy.updateTask(agent, 'document', 'fail', { reason: 'requires a later session' })
    const applying = await ctx.autonomy.beginDynamicExtension(agent, {
      logicalId: 'handoff-probe',
      name: 'Handoff probe',
      purpose: 'Exercise the durable extension summary.',
      hostCode: 'return () => {}',
      sourceSha256: 'a'.repeat(64),
    })
    await ctx.autonomy.settleDynamicExtension(agent, 'handoff-probe', applying.extension.version, { ok: true })

    const write = await executeMemoryTool(ctx, agent, 'autopilot_memory', {
      action: 'write', key: 'decision:api', value: 'Use the DSH public API.', tags: ['decision'],
    })
    if (write.isError) throw write.error
    expect(write.value).toMatchObject({ entry: { key: 'decision:api', revision: 1 } })
    const list = await executeMemoryTool(ctx, agent, 'autopilot_memory', { action: 'list' })
    expect(list.value).toMatchObject({ entries: [{ key: 'decision:api' }] })
    const read = await executeMemoryTool(ctx, agent, 'autopilot_memory', { action: 'read', key: 'decision:api' })
    expect(read.value).toMatchObject({ entry: { value: 'Use the DSH public API.' } })
    const missingKey = await executeMemoryTool(ctx, agent, 'autopilot_memory', { action: 'read' })
    expect(missingKey.isError).toBe(true)
    const missingValue = await executeMemoryTool(ctx, agent, 'autopilot_memory', {
      action: 'write', key: 'missing-value',
    })
    expect(missingValue.isError).toBe(true)
    const defaultTags = await executeMemoryTool(ctx, agent, 'autopilot_memory', {
      action: 'write', key: 'without-tags', value: 'No tags were supplied.',
    })
    expect(defaultTags.isError).toBe(false)

    const handoff = await executeMemoryTool(ctx, agent, 'autopilot_handoff', {
      summary: 'Continue from the durable task graph.',
      nextAction: 'Resume the pending continue task and rerun verification.',
    })
    expect(handoff.value).toMatchObject({ key: expect.stringMatching(/^handoff:run-/u), revision: 1 })
    const handoffEntry = ctx.autopilotMemory.read('/workspace', String((handoff.value as { key: string }).key))
    expect(handoffEntry?.value).toContain('requires a later session')
    expect(handoffEntry?.value).toContain('handoff-probe')
    expect(JSON.parse(handoffEntry!.value)).toMatchObject({
      version: 2,
      run: { generation: 1, revision: expect.any(Number), phase: 'running' },
      goal: { roundsStarted: 0, maxGoalRounds: expect.any(Number) },
      usage: { dynamicPackages: 1 },
      nextSafeAction: 'Resume the pending continue task and rerun verification.',
      truncated: false,
    })

    const deleted = await executeMemoryTool(ctx, agent, 'autopilot_memory', {
      action: 'delete', key: 'decision:api', expectedRevision: 1,
    })
    expect(deleted.value).toEqual({ deleted: true })
    await ctx.fiber.dispose()
  })

  it('allows explicit reads but rejects mutation after Autopilot pauses', async () => {
    const { ctx, agent } = await createHarness({ cwd: '/workspace' })
    await ctx.plugin(ProjectMemoryService)
    await ctx.plugin(memoryTools)
    await ctx.commands.execute(agent, '/autopilot start guard memory', new AbortController().signal)
    await ctx.commands.execute(agent, '/autopilot pause', new AbortController().signal)

    const read = await executeMemoryTool(ctx, agent, 'autopilot_memory', { action: 'read', key: 'missing' })
    expect(read).toMatchObject({ isError: false })
    expect(read.value).toEqual({ entry: null })
    const write = await executeMemoryTool(ctx, agent, 'autopilot_memory', {
      action: 'write', key: 'blocked', value: 'no',
    })
    expect(write.isError).toBe(true)
    if (write.isError) expect(write.error.message).toContain('Autopilot')
    await ctx.fiber.dispose()
  })

  it('rejects missing Agent, workspace, run, and handoff summary inputs', async () => {
    const { ctx, agent } = await createHarness()
    await ctx.plugin(ProjectMemoryService)
    await ctx.plugin(memoryTools)
    const subjectless = await ctx.tools.execute({
      callId: CallId('memory-subjectless'),
      name: 'autopilot_memory',
      arguments: { action: 'list' },
      signal: new AbortController().signal,
    })
    expect(subjectless.isError).toBe(true)
    const noWorkspace = await executeMemoryTool(ctx, agent, 'autopilot_memory', { action: 'list' })
    expect(noWorkspace.isError).toBe(true)
    await ctx.fiber.dispose()

    const second = await createHarness({ cwd: '/workspace' })
    await second.ctx.plugin(ProjectMemoryService)
    await second.ctx.plugin(memoryTools)
    const noRun = await executeMemoryTool(second.ctx, second.agent, 'autopilot_handoff', {
      summary: 'none', nextAction: 'none',
    })
    expect(noRun.isError).toBe(true)
    await second.ctx.commands.execute(
      second.agent, '/autopilot start validate handoff', new AbortController().signal,
    )
    const noPlan = await executeMemoryTool(second.ctx, second.agent, 'autopilot_handoff', {
      summary: 'No task plan exists yet.',
      nextAction: 'Create the durable task plan.',
    })
    expect(noPlan.isError).toBe(false)
    const empty = await executeMemoryTool(second.ctx, second.agent, 'autopilot_handoff', {
      summary: ' ', nextAction: 'continue',
    })
    expect(empty.isError).toBe(true)
    const emptyNext = await executeMemoryTool(second.ctx, second.agent, 'autopilot_handoff', {
      summary: 'state', nextAction: ' ',
    })
    expect(emptyNext.isError).toBe(true)
    const oversized = await executeMemoryTool(second.ctx, second.agent, 'autopilot_handoff', {
      summary: 'x'.repeat(4001), nextAction: 'continue',
    })
    expect(oversized.isError).toBe(true)
    await second.ctx.fiber.dispose()
  })

  it('records a revision-addressed handoff after a human pause without rearming work', async () => {
    const { ctx, agent } = await createHarness({ cwd: '/workspace' })
    await ctx.plugin(ProjectMemoryService)
    await ctx.plugin(memoryTools)
    await ctx.commands.execute(agent, '/autopilot start pause and hand off', new AbortController().signal)
    await ctx.commands.execute(agent, '/autopilot pause', new AbortController().signal)

    const handoff = await executeMemoryTool(ctx, agent, 'autopilot_handoff', {
      summary: 'The operator paused before implementation.',
      nextAction: 'Wait for explicit /autopilot resume.',
    })

    expect(handoff).toMatchObject({ isError: false })
    expect(handoff.value).toMatchObject({ key: expect.stringMatching(/^handoff:run-.+:1:\d+$/u) })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    const entry = ctx.autopilotMemory.read('/workspace', String((handoff.value as { key: string }).key))
    expect(JSON.parse(entry!.value)).toMatchObject({
      run: { phase: 'paused', activation: 'disarmed' },
      nextSafeAction: 'Wait for explicit /autopilot resume.',
    })
    await ctx.fiber.dispose()
  })

  it('bounds rich task, baseline, and verification history in a compact handoff', async () => {
    const { ctx, agent } = await createHarness({ cwd: '/workspace' })
    await ctx.plugin(ProjectMemoryService)
    await ctx.plugin(memoryTools)
    await ctx.commands.execute(agent, '/autopilot start compact a large handoff', new AbortController().signal)
    const lease = ctx.autonomy.get(agent)
    if (lease === undefined) throw new Error('missing Autopilot run')
    const now = Date.now()
    const tasks: RunTask[] = Array.from({ length: 40 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index} ${'title'.repeat(100)}`,
      description: `Description ${index}`,
      acceptanceCriteria: Array.from({ length: 6 }, () => 'criterion'.repeat(100)),
      dependencies: index === 0 ? [] : [`task-${index - 1}`],
      status: index === 0 ? 'completed' : 'pending',
      attempts: index === 0 ? 1 : 0,
      attemptHistory: [],
      evidence: index === 0
        ? [{ kind: 'test', ref: 'command'.repeat(100), summary: 'passed'.repeat(100) }]
        : [],
      createdAt: now,
      updatedAt: now,
      ...(index % 2 === 0 ? { reason: 'reason'.repeat(100) } : {}),
    }))
    const rich: AutonomyLeaseView = {
      ...lease,
      expiresAt: now + 60_000,
      reason: 'attention'.repeat(100),
      verificationBaseline: {
        kind: 'project',
        workspace: '/workspace',
        frozenAt: now,
        manifests: [{ name: 'package.json', sha256: 'a'.repeat(64) }],
        checks: [{
          id: 'js:test',
          label: 'test',
          cwd: '/workspace',
          argv: ['pnpm', 'run', 'test'],
          command: 'pnpm run test',
          manifest: 'package.json',
        }],
      },
      plan: {
        revision: 3,
        intent: 'implementation',
        acceptanceCriteria: ['goal criterion'.repeat(100)],
        tasks,
        createdAt: now,
        updatedAt: now,
      },
      verificationHistory: [{
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        verdict: 'fail',
        summary: 'verification summary'.repeat(100),
        findings: ['finding'.repeat(100)],
        checks: [{ name: 'test', passed: false, summary: 'failed'.repeat(100) }],
        reviewers: [{
          role: 'requirements',
          verdict: 'fail',
          summary: 'review'.repeat(100),
          findings: ['review finding'.repeat(100)],
          childSessionId: 'review-child',
        }],
      }],
    }
    vi.spyOn(ctx.autonomy, 'get').mockReturnValue(rich)

    const handoff = await executeMemoryTool(ctx, agent, 'autopilot_handoff', {
      summary: 'Bound this large state.',
      nextAction: 'Resume with the first incomplete task.',
    })

    expect(handoff.isError).toBe(false)
    const entry = ctx.autopilotMemory.read('/workspace', String((handoff.value as { key: string }).key))
    expect(entry?.value.length).toBeLessThanOrEqual(30_000)
    expect(JSON.parse(entry!.value)).toMatchObject({
      truncated: true,
      omittedTaskCount: 24,
      verificationBaseline: { kind: 'project', checks: ['js:test'] },
      verificationHistory: [{ verdict: 'fail' }],
    })
    await ctx.fiber.dispose()
  })
})
