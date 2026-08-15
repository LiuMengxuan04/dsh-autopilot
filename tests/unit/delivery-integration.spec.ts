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
import { createHarness } from '../helpers.ts'

const execFileAsync = promisify(execFile)
const roots = new Set<string>()
let sequence = 0

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function repositoryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-integration-')))
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

function execute(ctx: Context, agent: Agent, args: unknown) {
  sequence += 1
  return ctx.tools.execute({
    callId: CallId(`delivery-integration-${sequence}`),
    name: 'autopilot_delivery',
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

describe('delivery parent-run integration', () => {
  it('keeps status readable but gates every mutation on the exact armed Goal pair', async () => {
    const value = await repositoryFixture()
    const { ctx, agent } = await createHarness({ cwd: value.repository })
    const goal = ctx.goals.create(agent, { objective: 'exercise exact delivery authority' })
    const lease = await ctx.autonomy.start(agent, { goalId: goal.id })
    await ctx.plugin(DeliveryService, { worktreeRoot: value.worktrees })
    await ctx.plugin(deliveryTool)

    const created = await execute(ctx, agent, { action: 'create', expectedGeneration: 0 })
    expect(created).toMatchObject({
      isError: false,
      value: {
        snapshot: {
          parentSessionId: String(agent.id),
          parentRunId: lease.id,
          parentRunGeneration: lease.generation,
          parentGoalId: String(goal.id),
        },
      },
    })

    await ctx.autonomy.pause(agent, 'operator paused the exact parent')
    await expect(execute(ctx, agent, { action: 'status' })).resolves.toMatchObject({ isError: false })
    await expect(execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 1,
    })).resolves.toMatchObject({ isError: true })

    await ctx.autonomy.resume(agent, goal.id)
    await expect(execute(ctx, agent, {
      action: 'checkpoint', expectedGeneration: 1, expectedRevision: 1,
    })).resolves.toMatchObject({ isError: false, value: { snapshot: { revision: 2 } } })
    await expect(execute(ctx, agent, {
      action: 'cleanup', expectedGeneration: 1, expectedRevision: 2,
    })).resolves.toMatchObject({ isError: false, value: { snapshot: { phase: 'cleaned' } } })
    await ctx.fiber.dispose()
  })
})
