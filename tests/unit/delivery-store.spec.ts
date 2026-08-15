import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_STATE_VERSION,
} from '../../src/delivery-state.ts'
import type {
  DeliveryAuditRecord,
  DeliveryOperation,
  DeliveryPlan,
  DeliverySnapshot,
} from '../../src/delivery-state.ts'
import {
  DurableDeliveryStore,
  deliveryAuditKey,
  deliveryAuditRecordBytes,
  foldDeliveryAudit,
} from '../../src/delivery-store.ts'
import { createStorageHarness } from '../helpers.ts'

const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function plan(): DeliveryPlan {
  return {
    createdAt: 102,
    commit: { required: true, message: 'change', argv: [['git', 'add', '--all']] },
    push: { remote: 'origin', branch: 'dsh-autopilot/1-delivery', argv: ['git', 'push'] },
    pullRequest: { base: 'main', head: 'dsh-autopilot/1-delivery', title: 'change', body: 'body' },
    requiresHumanAuthorization: ['push', 'pull-request'],
  }
}

function snapshot(overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return {
    version: DELIVERY_STATE_VERSION,
    deliveryId: '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
    parentSessionId: 'parent-session',
    parentRunId: 'run-1',
    parentRunGeneration: 1,
    parentGoalId: 'goal-1',
    repository: '/repo',
    generation: 1,
    revision: 1,
    maxAuditRecords: 16,
    maxAuditBytes: 1_000_000,
    phase: 'active',
    createdAt: 100,
    updatedAt: 100,
    baseBranch: 'main',
    baseHead: 'a'.repeat(40),
    worktreeRoot: '/controlled',
    worktreePath: '/controlled/worktree',
    branch: 'dsh-autopilot/1-delivery',
    head: 'a'.repeat(40),
    dirty: false,
    conflicted: false,
    verifications: [],
    ...overrides,
  }
}

function mutate(previous: DeliverySnapshot, overrides: Partial<DeliverySnapshot>): DeliverySnapshot {
  return { ...previous, revision: previous.revision + 1, updatedAt: previous.updatedAt + 1, ...overrides }
}

function record(operation: DeliveryOperation, value: DeliverySnapshot): DeliveryAuditRecord {
  return { version: DELIVERY_STATE_VERSION, operation, time: value.updatedAt, snapshot: value }
}

async function openStore(root?: string) {
  const storageRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-autopilot-delivery-store-'))
  roots.add(storageRoot)
  const { ctx } = await createStorageHarness(storageRoot)
  return { ctx, root: storageRoot, store: await DurableDeliveryStore.open(ctx) }
}

describe('delivery audit folding', () => {
  it('sorts histories and selects the latest cleaned generation per repository', () => {
    const first = snapshot()
    const cleaned = mutate(first, { phase: 'cleaned' })
    const second = snapshot({
      deliveryId: '8791447a-cb54-4218-9a13-b2cf80bfc74f',
      generation: 2,
      createdAt: 200,
      updatedAt: 200,
    })
    const other = snapshot({
      deliveryId: '985157bb-50ef-45b0-9264-20bc45c27a25',
      repository: '/another',
      worktreePath: '/controlled/other',
    })
    const folded = foldDeliveryAudit([
      record('create', second),
      record('cleanup', cleaned),
      record('create', other),
      record('create', first),
    ])

    expect(folded.current.get('/repo')).toEqual(second)
    expect(folded.current.get('/another')).toEqual(other)
    expect(folded.history.map(item => [item.snapshot.repository, item.snapshot.generation, item.snapshot.revision])).toEqual([
      ['/another', 1, 1], ['/repo', 1, 1], ['/repo', 1, 2], ['/repo', 2, 1],
    ])
    expect(Object.isFrozen(folded)).toBe(true)
    expect(Object.isFrozen(folded.history)).toBe(true)
    expect(foldDeliveryAudit([]).current.size).toBe(0)
    expect(() => foldDeliveryAudit([
      record('create', first),
      record('create', snapshot({ deliveryId: '8791447a-cb54-4218-9a13-b2cf80bfc74f' })),
    ])).toThrow()
  })

  it.each([
    [[record('checkpoint', snapshot())], /begin with create/],
    [[record('create', snapshot({ revision: 2 }))], /invalid initial/],
    [[record('create', snapshot({ generation: 2 }))], /must be 1/],
    [[record('create', snapshot()), record('create', snapshot({ deliveryId: '8791447a-cb54-4218-9a13-b2cf80bfc74f', generation: 2 }))], /live worktree/],
    [[record('create', snapshot()), record('checkpoint', mutate(snapshot(), { repository: '/changed' }))], /begin with create/],
    [[record('create', snapshot()), record('checkpoint', mutate(snapshot(), { branch: 'changed' }))], /immutable identity/],
    [[record('create', snapshot()), record('checkpoint', mutate(snapshot(), { parentRunId: 'run-2' }))], /immutable identity/],
    [[record('create', snapshot()), record('checkpoint', mutate(snapshot(), { maxAuditBytes: 999_999 }))], /immutable identity/],
    [[record('create', snapshot()), record('checkpoint', snapshot({ revision: 3, updatedAt: 103 }))], /must follow/],
    [[record('create', snapshot({ updatedAt: 200 })), record('checkpoint', snapshot({ revision: 2, updatedAt: 199 }))], /backwards/],
    [[record('create', snapshot({ verifications: [{ verdict: 'pass', summary: 'x', checks: [], recordedAt: 100 }] }))], /invalid initial/],
    [[
      record('create', snapshot()),
      record('checkpoint', mutate(snapshot(), { verifications: [{ verdict: 'pass', summary: 'x', checks: [], recordedAt: 101 }] })),
      record('checkpoint', snapshot({ revision: 3, updatedAt: 102 })),
    ], /rewrote verification/],
    [[record('create', snapshot()), record('prepare-delivery', mutate(snapshot(), { phase: 'active' }))], /cannot produce/],
    [[record('create', snapshot()), record('create', mutate(snapshot(), {}))], /cannot produce/],
    [[record('create', snapshot({ maxAuditBytes: 100 }))], /audit ceiling/],
    [[record('create', snapshot()), { ...record('checkpoint', mutate(snapshot(), {})), time: 999 }], /time does not match/],
    [[record('create', snapshot()), record('cleanup', mutate(snapshot(), { phase: 'cleaned' })), record('checkpoint', snapshot({ revision: 3, phase: 'active', updatedAt: 103 }))], /cleaned delivery/],
  ])('rejects corrupt durable history %#', (records, message) => {
    expect(() => foldDeliveryAudit(records)).toThrow(message)
  })
})

describe('durable delivery store', () => {
  it('lists the current repository generations in stable path order', async () => {
    const { ctx, store } = await openStore()
    const later = snapshot({
      repository: '/z-repository',
      worktreePath: '/controlled/z-repository',
    })
    const earlier = snapshot({
      deliveryId: '8791447a-cb54-4218-9a13-b2cf80bfc74f',
      repository: '/a-repository',
      worktreePath: '/controlled/a-repository',
    })
    await store.create(0, later)
    await store.create(0, earlier)

    expect(store.list().map(item => item.repository)).toEqual(['/a-repository', '/z-repository'])

    await store.close()
    await ctx.fiber.dispose()
  })

  it('persists create, compare-and-set mutations, history, and reopen recovery', async () => {
    const firstOpen = await openStore()
    const first = snapshot()
    await expect(firstOpen.store.create(0, first)).resolves.toEqual(first)
    const checkpoint = mutate(first, { dirty: true })
    await expect(firstOpen.store.appendIfCurrent('checkpoint', first, checkpoint)).resolves.toEqual(checkpoint)
    expect(firstOpen.store.get('/repo')).toEqual(checkpoint)
    expect(firstOpen.store.history('/repo')).toHaveLength(2)
    expect(firstOpen.store.history()).toHaveLength(2)
    expect(deliveryAuditKey(first)).toContain(first.deliveryId)
    await firstOpen.store.close()
    await firstOpen.ctx.fiber.dispose()

    const reopened = await openStore(firstOpen.root)
    expect(reopened.store.get('/repo')).toEqual(checkpoint)
    const prepared = mutate(checkpoint, { phase: 'prepared', plan: plan() })
    await expect(reopened.store.appendIfCurrent('prepare-delivery', checkpoint, prepared)).resolves.toEqual(prepared)
    await reopened.store.close()
    await reopened.ctx.fiber.dispose()
  })

  it('rejects stale generations, live replacement, invalid starts, and stale revisions', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    await expect(store.create(1, first)).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await expect(store.create(0, snapshot({ generation: 2 }))).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await store.create(0, first)
    await expect(store.create(1, snapshot({ deliveryId: '8791447a-cb54-4218-9a13-b2cf80bfc74f', generation: 2 })))
      .rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await expect(store.appendIfCurrent('checkpoint', { ...first, deliveryId: 'wrong' }, mutate(first, {})))
      .rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' })
    await expect(store.appendIfCurrent('checkpoint', first, mutate(first, { branch: 'changed' })))
      .rejects.toThrow(/immutable identity/)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('serializes concurrent revision contenders', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    await store.create(0, first)
    const results = await Promise.allSettled([
      store.appendIfCurrent('checkpoint', first, mutate(first, { dirty: true })),
      store.appendIfCurrent('attention', first, mutate(first, {
        phase: 'needs-attention', dirty: true, conflicted: true, reason: 'conflict',
      })),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('materializes record and byte ceilings across cold recovery', async () => {
    const firstOpen = await openStore()
    const first = snapshot({ maxAuditRecords: 2 })
    await firstOpen.store.create(0, first)
    const second = mutate(first, {})
    await firstOpen.store.appendIfCurrent('checkpoint', first, second)
    await firstOpen.store.close()
    await firstOpen.ctx.fiber.dispose()

    const reopened = await openStore(firstOpen.root)
    await expect(reopened.store.appendIfCurrent('checkpoint', second, mutate(second, {})))
      .rejects.toMatchObject({ code: 'DELIVERY_LIMIT' })
    expect(reopened.store.history('/repo')).toHaveLength(2)
    await reopened.store.close()
    await reopened.ctx.fiber.dispose()

    const bytesOpen = await openStore()
    const byteLimited = snapshot({ maxAuditBytes: 2_000 })
    const createRecord = record('create', byteLimited)
    expect(deliveryAuditRecordBytes(createRecord)).toBeGreaterThan(0)
    await bytesOpen.store.create(0, byteLimited)
    await bytesOpen.store.close()
    await bytesOpen.ctx.fiber.dispose()
    const reopenedBytes = await openStore(bytesOpen.root)
    const oversized = mutate(byteLimited, {
      handoff: { summary: 'x'.repeat(1_500), nextAction: 'continue', recordedAt: 101 },
    })
    await expect(reopenedBytes.store.appendIfCurrent('checkpoint', byteLimited, oversized))
      .rejects.toMatchObject({ code: 'DELIVERY_LIMIT' })
    expect(reopenedBytes.store.get('/repo')).toEqual(byteLimited)
    await reopenedBytes.store.close()
    await reopenedBytes.ctx.fiber.dispose()
  })

  it('does not charge a failed durable write against generation limits', async () => {
    const close = vi.fn(async () => {})
    const records = new Map<string, DeliveryAuditRecord>()
    let failNext = false
    const table = {
      entries: () => records.entries(),
      get: (key: string) => records.get(key),
      put: vi.fn(async (key: string, value: DeliveryAuditRecord) => {
        if (failNext) {
          failNext = false
          throw new Error('storage unavailable')
        }
        records.set(key, value)
      }),
    }
    const ctx = {
      storageDomain: { open: vi.fn(async () => ({ table: () => table, close })) },
    } as unknown as Context
    const store = await DurableDeliveryStore.open(ctx)
    const first = snapshot({ maxAuditRecords: 2, maxAuditBytes: 6_000 })
    await store.create(0, first)
    const second = mutate(first, {
      handoff: { summary: 'x'.repeat(2_000), nextAction: 'continue', recordedAt: 101 },
    })
    const firstBytes = deliveryAuditRecordBytes(record('create', first))
    const secondBytes = deliveryAuditRecordBytes(record('checkpoint', second))
    expect(firstBytes + secondBytes).toBeLessThanOrEqual(first.maxAuditBytes)
    expect(firstBytes + (2 * secondBytes)).toBeGreaterThan(first.maxAuditBytes)
    failNext = true
    await expect(store.appendIfCurrent('checkpoint', first, second)).rejects.toThrow('storage unavailable')
    expect(store.get('/repo')).toEqual(first)
    expect(store.history('/repo')).toHaveLength(1)
    await expect(store.appendIfCurrent('checkpoint', first, second)).resolves.toEqual(second)
    expect(store.history('/repo')).toHaveLength(2)
    await store.close()
  })

  it('closes the domain when stored history is corrupt', async () => {
    const close = vi.fn(async () => {})
    const ctx = {
      storageDomain: {
        open: vi.fn(async () => ({
          table: () => ({ entries: () => [['bad', record('checkpoint', snapshot())]] }),
          close,
        })),
      },
    } as unknown as Context
    await expect(DurableDeliveryStore.open(ctx)).rejects.toThrow(/begin with create/)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects an occupied immutable audit key', async () => {
    const close = vi.fn(async () => {})
    const table = {
      entries: () => [],
      get: () => record('create', snapshot()),
      put: vi.fn(async () => {}),
    }
    const ctx = {
      storageDomain: { open: vi.fn(async () => ({ table: () => table, close })) },
    } as unknown as Context
    const store = await DurableDeliveryStore.open(ctx)
    await expect(store.create(0, snapshot())).rejects.toThrow(/already exists/)
    expect(table.put).not.toHaveBeenCalled()
    await store.close()
  })
})
