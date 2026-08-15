import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import DeliveryService from '../../src/delivery-service.ts'
import * as deliveryTool from '../../src/tool-delivery.ts'
import { createHarness, createTestAgent } from '../helpers.ts'

const execFileAsync = promisify(execFile)
const roots = new Set<string>()
let sequence = 0

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-tool-')))
  roots.add(root)
  const repository = join(root, 'repository')
  await mkdir(repository)
  await execFileAsync('git', ['init', '--initial-branch=main', repository])
  await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'Autopilot Test'])
  await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'autopilot@example.invalid'])
  await writeFile(join(repository, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['-C', repository, 'add', 'tracked.txt'])
  await execFileAsync('git', ['-C', repository, 'commit', '-m', 'initial'])
  return { root, repository, worktrees: join(root, 'worktrees') }
}

function execute(ctx: Context, agent: Agent | undefined, args: unknown) {
  sequence += 1
  return ctx.tools.execute({
    callId: CallId(`delivery-call-${sequence}`),
    name: 'autopilot_delivery',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

describe('isolated delivery tool', () => {
  it('exposes structured lifecycle actions but no external delivery execution', async () => {
    const value = await fixture()
    const { ctx, agent } = await createHarness({ cwd: value.repository })
    const goal = ctx.goals.create(agent, { objective: 'exercise delivery tools' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await ctx.plugin(DeliveryService, { worktreeRoot: value.worktrees })
    await ctx.plugin(deliveryTool)

    const empty = await execute(ctx, agent, { action: 'status' })
    expect(empty).toMatchObject({ isError: false, value: { status: null } })
    const createdResult = await execute(ctx, agent, { action: 'create', expectedGeneration: 0, baseBranch: 'main' })
    expect(createdResult.isError).toBe(false)
    const created = (createdResult.value as { snapshot: { worktreePath: string } }).snapshot
    await writeFile(join(created.worktreePath, 'tool.txt'), 'tool change\n')

    const checkpoint = await execute(ctx, agent, {
      action: 'checkpoint',
      expectedGeneration: 1,
      expectedRevision: 1,
      verificationVerdict: 'pass',
      verificationSummary: 'tool verification passed',
      verificationChecks: [{ name: 'unit', passed: true, summary: 'passed' }],
      handoffSummary: 'Ready for review.',
      handoffNextAction: 'Inspect the structured plan.',
    })
    expect(checkpoint).toMatchObject({ isError: false, value: { snapshot: { revision: 2, dirty: true } } })
    const prepared = await execute(ctx, agent, {
      action: 'prepare',
      expectedGeneration: 1,
      expectedRevision: 2,
      commitMessage: 'Tool delivery plan',
      remote: 'origin',
      targetBranch: 'main',
      pullRequestTitle: 'Tool delivery plan',
      pullRequestBody: 'This remains a plan.',
    })
    expect(prepared).toMatchObject({
      isError: false,
      value: { snapshot: { phase: 'prepared', plan: { requiresHumanAuthorization: ['push', 'pull-request'] } } },
    })
    await rm(join(created.worktreePath, 'tool.txt'))
    const cleanCheckpoint = await execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 3,
    })
    expect(cleanCheckpoint).toMatchObject({ isError: false, value: { snapshot: { revision: 4 } } })
    const cleaned = await execute(ctx, agent, {
      action: 'cleanup', expectedGeneration: 1, expectedRevision: 4,
    })
    expect(cleaned).toMatchObject({ isError: false, value: { snapshot: { phase: 'cleaned' } } })
    await ctx.fiber.dispose()
  })

  it('rejects missing Agent, workspace, revisions, verification fields, handoff fields, and commit text', async () => {
    const value = await fixture()
    const { ctx, agent } = await createHarness({ cwd: value.repository })
    const goal = ctx.goals.create(agent, { objective: 'validate delivery tool input' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await ctx.plugin(DeliveryService, { worktreeRoot: value.worktrees })
    await ctx.plugin(deliveryTool)
    expect((await execute(ctx, undefined, { action: 'status' })).isError).toBe(true)
    expect((await execute(ctx, createTestAgent(), { action: 'status' })).isError).toBe(true)
    expect((await execute(ctx, agent, { action: 'create' })).isError).toBe(true)
    const created = await execute(ctx, agent, { action: 'create', expectedGeneration: 0 })
    expect(created.isError).toBe(false)
    const worktreePath = (created.value as { snapshot: { worktreePath: string } }).snapshot.worktreePath
    expect((await execute(ctx, agent, { action: 'checkpoint', expectedGeneration: 1 })).isError).toBe(true)
    expect((await execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 1, verificationSummary: 'missing verdict',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 1, verificationVerdict: 'pass',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 1, handoffSummary: 'missing next action',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 1, handoffNextAction: 'missing summary',
    })).isError).toBe(true)
    expect((await execute(ctx, agent, {
      action: 'prepare', expectedGeneration: 1, expectedRevision: 1,
    })).isError).toBe(true)
    await writeFile(join(worktreePath, 'defaults.txt'), 'defaults\n')
    const checkpoint = await execute(ctx, agent, {
      action: 'checkpoint',
      expectedGeneration: 1,
      expectedRevision: 1,
      verificationVerdict: 'pass',
      verificationSummary: 'passed without detailed checks',
    })
    expect(checkpoint.isError).toBe(false)
    const prepared = await execute(ctx, agent, {
      action: 'prepare', expectedGeneration: 1, expectedRevision: 2, commitMessage: 'Use safe defaults',
    })
    expect(prepared).toMatchObject({ isError: false, value: { snapshot: { revision: 3 } } })
    await rm(join(worktreePath, 'defaults.txt'))
    await execute(ctx, agent, { action: 'checkpoint', expectedGeneration: 1, expectedRevision: 3 })
    await ctx.autopilotDelivery.cleanup(agent, {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 4,
    })
    await ctx.fiber.dispose()
  })
})
