import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeliveryService, { FixedGitRunner } from '../../src/delivery-service.ts'
import type { DeliveryGitRunner } from '../../src/delivery-service.ts'
import type { DurableDeliveryStore } from '../../src/delivery-store.ts'
import { DeliveryError } from '../../src/delivery-state.ts'
import { createServiceHarness, createTestAgent } from '../helpers.ts'

const execFileAsync = promisify(execFile)
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

interface RepositoryFixture {
  readonly root: string
  readonly repository: string
  readonly bare: string
  readonly worktrees: string
  readonly storage: string
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  return result.stdout.trim()
}

async function fixture(): Promise<RepositoryFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-')))
  roots.add(root)
  const repository = join(root, 'repository')
  const bare = join(root, 'origin.git')
  const worktrees = join(root, 'worktrees')
  const storage = join(root, 'storage')
  await mkdir(repository)
  await execFileAsync('git', ['init', '--bare', bare])
  await execFileAsync('git', ['init', '--initial-branch=main', repository])
  await git(repository, ['config', 'user.name', 'Autopilot Test'])
  await git(repository, ['config', 'user.email', 'autopilot@example.invalid'])
  await writeFile(join(repository, 'tracked.txt'), 'base\n')
  await git(repository, ['add', 'tracked.txt'])
  await git(repository, ['commit', '-m', 'initial'])
  await git(repository, ['remote', 'add', 'origin', bare])
  return { root, repository, bare, worktrees, storage }
}

const parents = new WeakMap<Context, Agent>()
const deliveryFibers = new WeakMap<Context, Fiber>()

function parent(ctx: Context): Agent {
  const agent = parents.get(ctx)
  if (agent === undefined) throw new Error('delivery test context is missing its parent Agent')
  return agent
}

async function serviceHarness(value: RepositoryFixture, options: {
  readonly maxVerificationRecords?: number
  readonly maxAuditRecords?: number
  readonly maxAuditBytes?: number
  readonly storage?: string
  readonly worktreeRoot?: string | undefined
} = {}) {
  const { ctx, agent } = await createServiceHarness({
    storageRoot: options.storage ?? value.storage,
    agentId: `delivery-${value.repository}`,
  })
  const recovered = ctx.autonomy.get(agent)
  if (recovered === undefined) {
    const goal = ctx.goals.create(agent, { objective: 'exercise isolated delivery' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
  } else if (recovered.activation === 'disarmed') {
    if (recovered.phase === 'running') await ctx.autonomy.pause(agent, 'rearm recovered delivery test')
    await ctx.autonomy.resume(agent, recovered.goalId)
  }
  const deliveryFiber = await ctx.plugin(DeliveryService, {
    ...(options.worktreeRoot === undefined && !('worktreeRoot' in options)
      ? { worktreeRoot: value.worktrees }
      : options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
    ...(options.maxVerificationRecords === undefined ? {} : {
      maxVerificationRecords: options.maxVerificationRecords,
    }),
    ...(options.maxAuditRecords === undefined ? {} : { maxAuditRecords: options.maxAuditRecords }),
    ...(options.maxAuditBytes === undefined ? {} : { maxAuditBytes: options.maxAuditBytes }),
  })
  parents.set(ctx, agent)
  deliveryFibers.set(ctx, deliveryFiber)
  return ctx
}

describe('isolated delivery service', () => {
  it('creates, checkpoints, plans without delivery, and cleans an isolated generation', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value, { maxAuditRecords: 8, maxAuditBytes: 50_000 })
    await expect(ctx.autopilotDelivery.status(value.repository)).resolves.toBeUndefined()
    const created = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    const lease = ctx.autonomy.get(parent(ctx))!
    expect(created).toMatchObject({
      generation: 1,
      revision: 1,
      phase: 'active',
      dirty: false,
      baseBranch: 'main',
      parentSessionId: String(parent(ctx).id),
      parentRunId: lease.id,
      parentRunGeneration: lease.generation,
      parentGoalId: String(lease.goalId),
      maxAuditRecords: 8,
      maxAuditBytes: 50_000,
    })
    expect(created.worktreePath.startsWith(value.worktrees)).toBe(true)
    expect(ctx.autopilotDelivery.list()).toEqual([created])
    expect(await git(value.repository, ['status', '--porcelain=v1'])).toBe('')
    expect(await ctx.autopilotDelivery.status(value.repository)).toMatchObject({
      snapshot: { deliveryId: created.deliveryId },
      observation: { present: true, dirty: false, drifted: false },
    })

    await writeFile(join(created.worktreePath, 'feature.txt'), 'feature\n')
    const checkpoint = await ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository,
      expectedGeneration: 1,
      expectedRevision: 1,
      verification: {
        verdict: 'pass',
        summary: 'focused checks passed',
        checks: [{ name: 'unit', passed: true, summary: 'passed' }],
      },
      handoff: { summary: 'Feature is ready.', nextAction: 'Review the delivery plan.' },
    })
    expect(checkpoint).toMatchObject({ revision: 2, dirty: true, handoff: { summary: 'Feature is ready.' } })
    const prepared = await ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository,
      expectedGeneration: 1,
      expectedRevision: 2,
      commitMessage: 'Add isolated feature',
      pullRequestTitle: 'Add isolated feature safely',
      pullRequestBody: 'Verified in the isolated worktree.',
    })
    expect(prepared).toMatchObject({
      revision: 3,
      phase: 'prepared',
      plan: {
        commit: { required: true },
        push: { remote: 'origin', branch: created.branch },
        pullRequest: { base: 'main', title: 'Add isolated feature safely' },
        requiresHumanAuthorization: ['push', 'pull-request'],
      },
    })
    expect(prepared.plan?.commit.argv[0]).toEqual(['git', '-C', created.worktreePath, 'add', '--all'])
    expect(await git(created.worktreePath, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(await git(value.repository, ['branch', '--remotes'])).toBe('')
    await expect(ctx.autopilotDelivery.executeExternalDelivery(value.repository, {
      source: 'human',
      token: 'not-consumed',
      deliveryId: created.deliveryId,
      generation: 1,
      revision: 3,
      operations: ['push'],
      expiresAt: Date.now() + 60_000,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    await expect(ctx.autopilotDelivery.cleanup(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 3,
    })).rejects.toMatchObject({ code: 'DELIVERY_DIRTY_WORKTREE' })

    await rm(join(created.worktreePath, 'feature.txt'))
    const cleanCheckpoint = await ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 3,
    })
    expect(cleanCheckpoint).toMatchObject({ revision: 4, phase: 'active', dirty: false, plan: undefined })
    const cleaned = await ctx.autopilotDelivery.cleanup(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 4,
    })
    expect(cleaned).toMatchObject({ revision: 5, phase: 'cleaned' })
    expect(await ctx.autopilotDelivery.status(value.repository)).toMatchObject({
      observation: { present: false, drifted: false },
    })
    expect(await git(value.repository, ['show-ref', '--verify', `refs/heads/${created.branch}`])).toBeTruthy()
    await expect(ctx.autopilotDelivery.cleanup(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 5,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await ctx.fiber.dispose()
  })

  it('requires the exact armed parent for every mutation while status stays read-only', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value)
    const agent = parent(ctx)
    const created = await ctx.autopilotDelivery.create(agent, {
      repository: value.repository, expectedGeneration: 0,
    })
    const goalId = ctx.autonomy.get(agent)!.goalId
    await expect(ctx.autopilotDelivery.cleanupAbandoned({
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    await ctx.autonomy.pause(agent, 'operator stopped the run')
    await expect(ctx.autopilotDelivery.status(value.repository)).resolves.toMatchObject({
      snapshot: { deliveryId: created.deliveryId },
      observation: { drifted: false },
    })
    await expect(ctx.autopilotDelivery.checkpoint(agent, {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    await expect(ctx.autopilotDelivery.cleanup(createTestAgent('other-parent', value.repository), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })

    await ctx.autonomy.resume(agent, goalId)
    const checkpoint = await ctx.autopilotDelivery.checkpoint(agent, {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })
    ctx.goals.disarm(agent)
    await expect(ctx.autopilotDelivery.cleanup(agent, {
      repository: value.repository, expectedGeneration: 1, expectedRevision: checkpoint.revision,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    await ctx.fiber.dispose()
  })

  it('offers abandoned cleanup only through a Host-owned human authorizer and rechecks drift', async () => {
    const value = await fixture()
    const harness = await createServiceHarness({
      storageRoot: value.storage,
      agentId: `hosted-delivery-${value.repository}`,
    })
    const goal = harness.ctx.goals.create(harness.agent, { objective: 'exercise Host cleanup' })
    await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
    const authorizeCleanup = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async (request: { readonly worktreePath: string }) => {
        await writeFile(join(request.worktreePath, 'authorization-drift.txt'), 'drift\n')
        return true
      })
      .mockResolvedValueOnce(true)
    class HostedDeliveryService extends DeliveryService {
      constructor(inner: Context) {
        super(inner, { worktreeRoot: value.worktrees }, undefined, { authorizeCleanup })
      }
    }
    await harness.ctx.plugin(HostedDeliveryService)
    const created = await harness.ctx.autopilotDelivery.create(harness.agent, {
      repository: value.repository, expectedGeneration: 0,
    })
    await harness.ctx.autonomy.revoke(harness.agent, 'parent is terminal')
    harness.ctx.goals.complete(harness.agent, harness.ctx.goals.get(harness.agent)!)

    const cleanupInput = {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    }
    await expect(harness.ctx.autopilotDelivery.cleanupAbandoned(cleanupInput))
      .rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    const request = authorizeCleanup.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.isFrozen(request)).toBe(true)
    expect(request).toMatchObject({
      deliveryId: created.deliveryId,
      parentSessionId: String(harness.agent.id),
      parentRunId: created.parentRunId,
      parentRunGeneration: created.parentRunGeneration,
      parentGoalId: created.parentGoalId,
      present: true,
    })
    await expect(harness.ctx.autopilotDelivery.cleanupAbandoned(cleanupInput))
      .rejects.toMatchObject({ code: 'DELIVERY_DIRTY_WORKTREE' })
    await rm(join(created.worktreePath, 'authorization-drift.txt'))
    await expect(harness.ctx.autopilotDelivery.cleanupAbandoned(cleanupInput))
      .resolves.toMatchObject({ phase: 'cleaned', revision: 2 })
    expect(authorizeCleanup).toHaveBeenCalledTimes(3)
    const hostedStore = harness.ctx.autopilotDelivery as unknown as { readonly store: DurableDeliveryStore }
    expect(hostedStore.store.history(value.repository).at(-1)?.operation).toBe('host-cleanup')
    await harness.ctx.fiber.dispose()

    const missing = await fixture()
    const missingHarness = await createServiceHarness({
      storageRoot: missing.storage,
      agentId: `hosted-missing-${missing.repository}`,
    })
    const missingGoal = missingHarness.ctx.goals.create(missingHarness.agent, { objective: 'clean removed worktree' })
    await missingHarness.ctx.autonomy.start(missingHarness.agent, { goalId: missingGoal.id })
    class MissingHostedDeliveryService extends DeliveryService {
      constructor(inner: Context) {
        super(inner, { worktreeRoot: missing.worktrees }, undefined, {
          authorizeCleanup: async () => true,
        })
      }
    }
    await missingHarness.ctx.plugin(MissingHostedDeliveryService)
    const missingCreated = await missingHarness.ctx.autopilotDelivery.create(missingHarness.agent, {
      repository: missing.repository, expectedGeneration: 0,
    })
    await missingHarness.ctx.autonomy.revoke(missingHarness.agent, 'parent is terminal')
    missingHarness.ctx.goals.complete(missingHarness.agent, missingHarness.ctx.goals.get(missingHarness.agent)!)
    await git(missing.repository, ['worktree', 'remove', missingCreated.worktreePath])
    await expect(missingHarness.ctx.autopilotDelivery.cleanupAbandoned({
      repository: missing.repository, expectedGeneration: 1, expectedRevision: 1,
    })).resolves.toMatchObject({ phase: 'cleaned' })
    await missingHarness.ctx.fiber.dispose()
  })

  it('rejects a later armed run and an authority swap during worktree creation', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value)
    const agent = parent(ctx)
    await ctx.autopilotDelivery.create(agent, { repository: value.repository, expectedGeneration: 0 })
    await ctx.autonomy.revoke(agent, 'replace the parent run')
    ctx.goals.complete(agent, ctx.goals.get(agent)!)
    const replacementGoal = ctx.goals.create(agent, { objective: 'replacement run' })
    await ctx.autonomy.start(agent, { goalId: replacementGoal.id })
    await expect(ctx.autopilotDelivery.checkpoint(agent, {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    await ctx.fiber.dispose()

    const swapped = await fixture()
    const swappedCtx = await serviceHarness(swapped)
    const swappedAgent = parent(swappedCtx)
    const internals = swappedCtx.autopilotDelivery as unknown as { readonly git: DeliveryGitRunner }
    const realRun = internals.git.run.bind(internals.git)
    vi.spyOn(internals.git, 'run').mockImplementation(async (repository, argv) => {
      const result = await realRun(repository, argv)
      if (argv[0] === 'worktree' && argv[1] === 'add') {
        await swappedCtx.autonomy.revoke(swappedAgent, 'swap during create')
        swappedCtx.goals.complete(swappedAgent, swappedCtx.goals.get(swappedAgent)!)
        const goal = swappedCtx.goals.create(swappedAgent, { objective: 'new run during create' })
        await swappedCtx.autonomy.start(swappedAgent, { goalId: goal.id })
      }
      return result
    })
    await expect(swappedCtx.autopilotDelivery.create(swappedAgent, {
      repository: swapped.repository, expectedGeneration: 0,
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    expect(await git(swapped.repository, ['branch', '--list', 'dsh-autopilot/*'])).toBe('')
    await swappedCtx.fiber.dispose()
  })

  it('recovers after HMR and converges a worktree removed before its audit write', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value)
    const created = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    await deliveryFibers.get(ctx)!.dispose()
    deliveryFibers.set(ctx, await ctx.plugin(DeliveryService, { worktreeRoot: value.worktrees }))

    expect(await ctx.autopilotDelivery.status(value.repository)).toMatchObject({
      snapshot: { deliveryId: created.deliveryId, revision: 1 },
      observation: { present: true, drifted: false },
    })
    await git(value.repository, ['worktree', 'remove', created.worktreePath])
    const attention = await ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })
    expect(attention).toMatchObject({ revision: 2, phase: 'needs-attention', reason: 'isolated worktree is missing' })
    const cleaned = await ctx.autopilotDelivery.cleanup(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 2,
    })
    expect(cleaned.phase).toBe('cleaned')
    const second = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 1 })
    expect(second.generation).toBe(2)
    await ctx.autopilotDelivery.cleanup(parent(ctx), {
      repository: value.repository, expectedGeneration: 2, expectedRevision: 1,
    })
    await ctx.fiber.dispose()
  })

  it('rejects non-repositories, subdirectories, dirty baselines, unsafe roots, refs, and stale generations', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value)
    const plain = join(value.root, 'plain')
    const subdirectory = join(value.repository, 'subdirectory')
    await mkdir(plain)
    await mkdir(subdirectory)
    await expect(ctx.autopilotDelivery.create(parent(ctx), { repository: plain, expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'DELIVERY_GIT_FAILED' })
    await expect(ctx.autopilotDelivery.create(parent(ctx), { repository: subdirectory, expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await writeFile(join(value.repository, 'dirty.txt'), 'dirty\n')
    await expect(ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'DELIVERY_DIRTY_BASELINE' })
    await rm(join(value.repository, 'dirty.txt'))
    await expect(ctx.autopilotDelivery.create(parent(ctx), {
      repository: value.repository, expectedGeneration: 0, baseBranch: 'bad ref',
    })).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    await expect(ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await expect(ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 1 }))
      .rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await ctx.autopilotDelivery.cleanup(parent(ctx), { repository: value.repository, expectedGeneration: 1, expectedRevision: 1 })
    await ctx.fiber.dispose()

    const insideStorage = join(value.root, 'inside-storage')
    const inside = await serviceHarness(value, {
      storage: insideStorage,
      worktreeRoot: join(value.repository, '.worktrees'),
    })
    await expect(inside.autopilotDelivery.create(parent(inside), { repository: value.repository, expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    expect(await git(value.repository, ['status', '--porcelain=v1'])).toBe('')
    await inside.fiber.dispose()

    const linkedRoot = join(value.root, 'linked-worktrees')
    await symlink(value.repository, linkedRoot, 'dir')
    const linkedStorage = await serviceHarness(value, {
      storage: join(value.root, 'linked-storage'),
      worktreeRoot: linkedRoot,
    })
    await expect(linkedStorage.autopilotDelivery.create(parent(linkedStorage), {
      repository: value.repository, expectedGeneration: 0,
    }))
      .rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await linkedStorage.fiber.dispose()
  })

  it('fails closed on crash residue and worktree symlink substitution', async () => {
    const residue = await fixture()
    const residueCtx = await serviceHarness(residue)
    await git(residue.repository, ['branch', 'dsh-autopilot/orphan'])
    await expect(residueCtx.autopilotDelivery.create(parent(residueCtx), {
      repository: residue.repository, expectedGeneration: 0,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await git(residue.repository, ['branch', '-D', 'dsh-autopilot/orphan'])
    await mkdir(residue.worktrees, { recursive: true })
    await git(residue.repository, ['worktree', 'add', '-b', 'orphan-worktree', join(residue.worktrees, 'orphan')])
    await expect(residueCtx.autopilotDelivery.create(parent(residueCtx), {
      repository: residue.repository, expectedGeneration: 0,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await residueCtx.fiber.dispose()

    const substituted = await fixture()
    const substitutedCtx = await serviceHarness(substituted)
    const created = await substitutedCtx.autopilotDelivery.create(parent(substitutedCtx), {
      repository: substituted.repository, expectedGeneration: 0,
    })
    await rm(created.worktreePath, { recursive: true, force: true })
    const outside = join(substituted.root, 'outside')
    await mkdir(outside)
    await symlink(outside, created.worktreePath, 'dir')
    await expect(substitutedCtx.autopilotDelivery.status(substituted.repository))
      .rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await substitutedCtx.fiber.dispose()

    const nested = await fixture()
    const nestedCtx = await serviceHarness(nested)
    const nestedCreated = await nestedCtx.autopilotDelivery.create(parent(nestedCtx), {
      repository: nested.repository, expectedGeneration: 0,
    })
    await rm(nestedCreated.worktreePath, { recursive: true, force: true })
    await execFileAsync('git', ['init', '--initial-branch=main', nestedCreated.worktreeRoot])
    await git(nestedCreated.worktreeRoot, ['config', 'user.name', 'Autopilot Test'])
    await git(nestedCreated.worktreeRoot, ['config', 'user.email', 'autopilot@example.invalid'])
    await writeFile(join(nestedCreated.worktreeRoot, 'root.txt'), 'root repository\n')
    await git(nestedCreated.worktreeRoot, ['add', 'root.txt'])
    await git(nestedCreated.worktreeRoot, ['commit', '-m', 'root'])
    await mkdir(nestedCreated.worktreePath)
    await expect(nestedCtx.autopilotDelivery.status(nested.repository))
      .rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await nestedCtx.fiber.dispose()

    const missing = await fixture()
    const missingCtx = await serviceHarness(missing)
    const missingCreated = await missingCtx.autopilotDelivery.create(parent(missingCtx), {
      repository: missing.repository, expectedGeneration: 0,
    })
    await rm(missingCreated.worktreePath, { recursive: true, force: true })
    await expect(missingCtx.autopilotDelivery.cleanup(parent(missingCtx), {
      repository: missing.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await missingCtx.fiber.dispose()
  })

  it('records conflicts and unexpected branches as attention and refuses cleanup', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value)
    const created = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    await writeFile(join(created.worktreePath, 'tracked.txt'), 'worktree\n')
    await git(created.worktreePath, ['add', 'tracked.txt'])
    await git(created.worktreePath, ['commit', '-m', 'worktree change'])
    await writeFile(join(value.repository, 'tracked.txt'), 'main\n')
    await git(value.repository, ['add', 'tracked.txt'])
    await git(value.repository, ['commit', '-m', 'main change'])
    await expect(git(created.worktreePath, ['merge', 'main'])).rejects.toThrow()

    const conflict = await ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })
    expect(conflict).toMatchObject({ phase: 'needs-attention', dirty: true, conflicted: true })
    await expect(ctx.autopilotDelivery.cleanup(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 2,
    })).rejects.toMatchObject({ code: 'DELIVERY_DIRTY_WORKTREE' })
    await expect(ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository,
      expectedGeneration: 1,
      expectedRevision: 2,
      commitMessage: 'blocked',
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await ctx.fiber.dispose()

    const branchValue = await fixture()
    const branchCtx = await serviceHarness(branchValue)
    const branchCreated = await branchCtx.autopilotDelivery.create(parent(branchCtx), { repository: branchValue.repository, expectedGeneration: 0 })
    await git(branchCreated.worktreePath, ['checkout', '-b', 'unexpected'])
    const branchAttention = await branchCtx.autopilotDelivery.checkpoint(parent(branchCtx), {
      repository: branchValue.repository, expectedGeneration: 1, expectedRevision: 1,
    })
    expect(branchAttention).toMatchObject({ phase: 'needs-attention', reason: expect.stringContaining('unexpected') })
    await expect(branchCtx.autopilotDelivery.cleanup(parent(branchCtx), {
      repository: branchValue.repository, expectedGeneration: 1, expectedRevision: 2,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await branchCtx.fiber.dispose()

    const driftValue = await fixture()
    const driftCtx = await serviceHarness(driftValue)
    const driftCreated = await driftCtx.autopilotDelivery.create(parent(driftCtx), {
      repository: driftValue.repository, expectedGeneration: 0,
    })
    await writeFile(join(driftCreated.worktreePath, 'drift.txt'), 'uncheckpointed commit\n')
    await git(driftCreated.worktreePath, ['add', 'drift.txt'])
    await git(driftCreated.worktreePath, ['commit', '-m', 'uncheckpointed'])
    await expect(driftCtx.autopilotDelivery.cleanup(parent(driftCtx), {
      repository: driftValue.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await driftCtx.fiber.dispose()

    const missingDrift = await fixture()
    const missingDriftCtx = await serviceHarness(missingDrift)
    const missingDriftCreated = await missingDriftCtx.autopilotDelivery.create(parent(missingDriftCtx), {
      repository: missingDrift.repository, expectedGeneration: 0,
    })
    await writeFile(join(missingDriftCreated.worktreePath, 'drift.txt'), 'retained branch commit\n')
    await git(missingDriftCreated.worktreePath, ['add', 'drift.txt'])
    await git(missingDriftCreated.worktreePath, ['commit', '-m', 'retained branch drift'])
    await git(missingDrift.repository, ['worktree', 'remove', missingDriftCreated.worktreePath])
    await expect(missingDriftCtx.autopilotDelivery.cleanup(parent(missingDriftCtx), {
      repository: missingDrift.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await missingDriftCtx.fiber.dispose()
  })

  it('uses revision CAS, bounded verification, and a clean committed-change plan', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value, { maxVerificationRecords: 1 })
    const created = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    await writeFile(join(created.worktreePath, 'tracked.txt'), 'committed feature\n')
    await git(created.worktreePath, ['add', 'tracked.txt'])
    await git(created.worktreePath, ['commit', '-m', 'feature'])
    const contenders = await Promise.allSettled([
      ctx.autopilotDelivery.checkpoint(parent(ctx), {
        repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
        verification: { verdict: 'pass', summary: 'passed' },
      }),
      ctx.autopilotDelivery.checkpoint(parent(ctx), {
        repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
        verification: { verdict: 'fail', summary: 'failed' },
      }),
    ])
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.filter(result => result.status === 'rejected')).toHaveLength(1)
    const current = (await ctx.autopilotDelivery.status(value.repository))!.snapshot
    if (current.verifications[0]?.verdict !== 'pass') {
      await ctx.fiber.dispose()
      return
    }
    expect(() => ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 2,
      verification: { verdict: 'pass', summary: 'too many', checks: Array.from({ length: 33 }, (_, index) => ({
        name: `check-${index}`, passed: true, summary: 'passed',
      })) },
    })).toThrow(DeliveryError)
    await expect(ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 2,
      verification: { verdict: 'pass', summary: 'second' },
    })).rejects.toMatchObject({ code: 'DELIVERY_LIMIT' })
    const prepared = await ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository,
      expectedGeneration: 1,
      expectedRevision: 2,
      commitMessage: 'Already committed',
      remote: 'upstream',
      targetBranch: 'release/next',
    })
    expect(prepared.plan).toMatchObject({ commit: { required: false, argv: [] }, push: { remote: 'upstream' } })
    expect(() => ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository,
      expectedGeneration: 1,
      expectedRevision: 3,
      commitMessage: 'bad remote',
      remote: 'not safe!',
    })).toThrow(DeliveryError)
    await ctx.autopilotDelivery.cleanup(parent(ctx), { repository: value.repository, expectedGeneration: 1, expectedRevision: 3 })
    await ctx.fiber.dispose()
  })

  it('validates revisions, missing repositories, unchanged or unverified work, and Git runner argv', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value)
    await expect(ctx.autopilotDelivery.status(join(value.root, 'missing'))).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    expect(() => ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: -1 })).toThrow(/non-negative/)
    expect(() => ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 0, expectedRevision: 1,
    })).toThrow(/positive/)
    await expect(ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND' })
    const created = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    await expect(ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1, commitMessage: 'unchanged',
    })).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await writeFile(join(created.worktreePath, 'unverified.txt'), 'change\n')
    const dirty = await ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 1,
    })
    await rm(join(created.worktreePath, 'unverified.txt'))
    await expect(ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: dirty.revision, commitMessage: 'drifted',
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await writeFile(join(created.worktreePath, 'unverified.txt'), 'change\n')
    await expect(ctx.autopilotDelivery.prepareDelivery(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: dirty.revision, commitMessage: 'unverified',
    })).rejects.toMatchObject({ code: 'DELIVERY_PERMISSION_DENIED' })
    await expect(ctx.autopilotDelivery.checkpoint(parent(ctx), {
      repository: value.repository, expectedGeneration: 1, expectedRevision: 99,
    })).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await ctx.fiber.dispose()

    const runner = new FixedGitRunner(30_000, 10_000)
    await expect(runner.run(value.repository, [])).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await expect(runner.run(value.repository, ['status', 'bad\u0000arg'])).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await expect(runner.run(value.repository, ['not-a-git-subcommand'])).rejects.toMatchObject({ code: 'DELIVERY_GIT_FAILED' })
    await expect(new FixedGitRunner(30_000, 1).run(value.repository, ['show', 'HEAD:tracked.txt']))
      .rejects.toMatchObject({ code: 'DELIVERY_GIT_FAILED' })
    const inheritedGitDirectory = process.env['GIT_DIR']
    try {
      process.env['GIT_DIR'] = join(value.root, 'host-controlled-override')
      await expect(runner.run(value.repository, ['status', '--porcelain=v1'])).resolves.toMatchObject({ stdout: '' })
    } finally {
      if (inheritedGitDirectory === undefined) delete process.env['GIT_DIR']
      else process.env['GIT_DIR'] = inheritedGitDirectory
    }
    const direct = new Context()
    new DeliveryService(direct)
    await direct.fiber.dispose()
    const invalidConfig = new Context()
    expect(() => new DeliveryService(invalidConfig, { worktreeRoot: 'relative' })).toThrow(/absolute/)
    await invalidConfig.fiber.dispose()
    const invalidLimit = new Context()
    expect(() => new DeliveryService(invalidLimit, { maxAuditRecords: 0 })).toThrow(/maxAuditRecords/)
    await invalidLimit.fiber.dispose()
  })

  it('uses the safe default root and rolls back worktrees when persistence fails', async () => {
    const value = await fixture()
    const ctx = await serviceHarness(value, { worktreeRoot: undefined })
    const defaultRoot = await ctx.autopilotDelivery.create(parent(ctx), { repository: value.repository, expectedGeneration: 0 })
    expect(defaultRoot.worktreeRoot).toContain(join(value.repository, '.git', 'dsh-autopilot-worktrees'))
    expect(await git(value.repository, ['status', '--porcelain=v1'])).toBe('')
    await ctx.autopilotDelivery.cleanup(parent(ctx), { repository: value.repository, expectedGeneration: 1, expectedRevision: 1 })
    await ctx.fiber.dispose()

    const rollbackValue = await fixture()
    const rollbackCtx = await serviceHarness(rollbackValue)
    const internals = rollbackCtx.autopilotDelivery as unknown as {
      readonly store: DurableDeliveryStore
      readonly git: DeliveryGitRunner
    }
    const createSpy = vi.spyOn(internals.store, 'create')
    createSpy.mockRejectedValueOnce(new DeliveryError('storage failed', 'DELIVERY_CONFLICT'))
    await expect(rollbackCtx.autopilotDelivery.create(parent(rollbackCtx), { repository: rollbackValue.repository, expectedGeneration: 0 }))
      .rejects.toThrow('storage failed')
    expect(await git(rollbackValue.repository, ['branch', '--list', 'dsh-autopilot/*'])).toBe('')

    const realRun = internals.git.run.bind(internals.git)
    const runSpy = vi.spyOn(internals.git, 'run').mockImplementation((repository, argv) => {
      if ((argv[0] === 'worktree' && argv[1] === 'remove') || argv[0] === 'branch') {
        return Promise.reject(new DeliveryError('rollback blocked', 'DELIVERY_GIT_FAILED'))
      }
      return realRun(repository, argv)
    })
    createSpy.mockRejectedValueOnce(new DeliveryError('storage failed again', 'DELIVERY_CONFLICT'))
    await expect(rollbackCtx.autopilotDelivery.create(parent(rollbackCtx), { repository: rollbackValue.repository, expectedGeneration: 0 }))
      .rejects.toThrow('storage failed again')
    expect(runSpy).toHaveBeenCalledWith(rollbackValue.repository, [
      'worktree', 'remove', expect.stringContaining(rollbackValue.worktrees),
    ])
    expect(runSpy.mock.calls.filter(([, argv]) => argv[0] === 'branch')).toHaveLength(0)
    await rollbackCtx.fiber.dispose()

    const dirtyValue = await fixture()
    const dirtyCtx = await serviceHarness(dirtyValue)
    const dirtyInternals = dirtyCtx.autopilotDelivery as unknown as {
      readonly store: DurableDeliveryStore
    }
    vi.spyOn(dirtyInternals.store, 'create').mockImplementationOnce(async (_expected, snapshot) => {
      await writeFile(join(snapshot.worktreePath, 'unsaved.txt'), 'retain me\n')
      throw new DeliveryError('dirty storage failure', 'DELIVERY_CONFLICT')
    })
    await expect(dirtyCtx.autopilotDelivery.create(parent(dirtyCtx), {
      repository: dirtyValue.repository, expectedGeneration: 0,
    })).rejects.toThrow('dirty storage failure')
    expect(await git(dirtyValue.repository, ['branch', '--list', 'dsh-autopilot/*'])).not.toBe('')
    await dirtyCtx.fiber.dispose()

    const opaqueValue = await fixture()
    const opaqueCtx = await serviceHarness(opaqueValue)
    const opaqueInternals = opaqueCtx.autopilotDelivery as unknown as {
      readonly store: DurableDeliveryStore
      readonly git: DeliveryGitRunner
    }
    vi.spyOn(opaqueInternals.store, 'create')
      .mockRejectedValueOnce(new DeliveryError('opaque storage failure', 'DELIVERY_CONFLICT'))
    const opaqueRun = opaqueInternals.git.run.bind(opaqueInternals.git)
    vi.spyOn(opaqueInternals.git, 'run').mockImplementation((repository, argv) => {
      if (repository.startsWith(opaqueValue.worktrees) && argv[0] === 'rev-parse') {
        return Promise.reject(new DeliveryError('inspection unavailable', 'DELIVERY_GIT_FAILED'))
      }
      return opaqueRun(repository, argv)
    })
    await expect(opaqueCtx.autopilotDelivery.create(parent(opaqueCtx), {
      repository: opaqueValue.repository, expectedGeneration: 0,
    })).rejects.toThrow('opaque storage failure')
    expect(await git(opaqueValue.repository, ['branch', '--list', 'dsh-autopilot/*'])).not.toBe('')
    await opaqueCtx.fiber.dispose()
  })

  it('rejects the default root when repository metadata disappears or belongs to a linked worktree', async () => {
    const missing = await fixture()
    const missingCtx = await serviceHarness(missing, { worktreeRoot: undefined })
    const missingInternals = missingCtx.autopilotDelivery as unknown as {
      readonly git: DeliveryGitRunner
    }
    const missingRun = missingInternals.git.run.bind(missingInternals.git)
    vi.spyOn(missingInternals.git, 'run').mockImplementation(async (repository, argv) => {
      const result = await missingRun(repository, argv)
      if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
        await rm(join(repository, '.git'), { recursive: true, force: true })
      }
      return result
    })
    await expect(missingCtx.autopilotDelivery.create(parent(missingCtx), {
      repository: missing.repository,
      expectedGeneration: 0,
    })).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await missingCtx.fiber.dispose()

    const linked = await fixture()
    const linkedRepository = join(linked.root, 'linked-repository')
    await git(linked.repository, ['worktree', 'add', '-b', 'linked-default-root', linkedRepository])
    const linkedFixture: RepositoryFixture = {
      ...linked,
      repository: linkedRepository,
      storage: join(linked.root, 'linked-storage'),
    }
    const linkedCtx = await serviceHarness(linkedFixture, { worktreeRoot: undefined })
    await expect(linkedCtx.autopilotDelivery.create(parent(linkedCtx), {
      repository: linkedRepository,
      expectedGeneration: 0,
    })).rejects.toMatchObject({ code: 'DELIVERY_INVALID' })
    await linkedCtx.fiber.dispose()
  })
})
