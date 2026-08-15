import { describe, expect, it, vi } from 'vitest'
import { createStorageHarness } from '../helpers.ts'
import type { MissionSnapshot } from '../../src/mission-state.ts'
import {
  DurableMissionStore,
  missionAuditKey,
  MissionStoreError,
  missionStoreDomainSpec,
} from '../../src/mission-store.ts'

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
    source: { path: '/repo/queue.md', sha256: 'a'.repeat(64), bytes: 8 },
    phase: 'planned',
    continueOnError: false,
    tasks: [{ id: 'task-001', prompt: 'Do it', status: 'planned', attempts: [], updatedAt: 1 }],
    maxAuditRecords: 8,
    maxAuditBytes: 100_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('durable mission store', () => {
  it('serializes append/reduce, lists exact runs, and rebuilds the ledger', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableMissionStore.open(ctx)
    const first = await store.append('plan', snapshot())
    const second = await store.reduceCurrent(first, current => current === undefined ? undefined : ({
      operation: 'run-start',
      snapshot: { ...current, revision: 2, updatedAt: 2 },
    }))
    expect(second?.revision).toBe(2)
    expect(await store.reduceCurrent({ ...first, missionId: 'missing-12345678' }, () => undefined)).toBeUndefined()
    expect(store.get(first)?.revision).toBe(2)
    expect(store.list({ parentSessionId: 'parent', runId: 'run', generation: 1 })).toHaveLength(1)
    expect(store.list({ generation: 2 })).toEqual([])
    expect(store.history('parent')).toHaveLength(2)
    expect(store.history('absent')).toEqual([])
    await store.close()

    const reopened = await DurableMissionStore.open(ctx)
    expect(reopened.get(first)?.revision).toBe(2)
    expect(reopened.history()).toHaveLength(2)
    await reopened.close()
  })

  it('rejects duplicate/stale revisions without corrupting the current summary', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableMissionStore.open(ctx)
    const first = await store.append('plan', snapshot())
    await expect(store.append('run-start', { ...first, revision: 1, updatedAt: 2 }))
      .rejects.toThrow(/increase by one/u)
    expect(store.get(first)?.revision).toBe(1)
    await store.close()
  })

  it('enforces record and byte ceilings during writes and cold rebuild', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableMissionStore.open(ctx)
    const first = await store.append('plan', snapshot({ maxAuditRecords: 1 }))
    await expect(store.append('run-start', { ...first, revision: 2, updatedAt: 2 }))
      .rejects.toThrow(/exceeded 1 audit records/u)
    await store.close()

    const tiny = await DurableMissionStore.open(ctx)
    const separate = snapshot({
      runId: 'bytes', missionId: 'bytes-12345678', dagTaskId: 'mission-bytes-12345678', maxAuditBytes: 1,
    })
    await expect(tiny.append('plan', separate)).rejects.toThrow(/audit bytes/u)
    await tiny.close()

    const domain = await ctx.storageDomain.open(missionStoreDomainSpec)
    const corrupt = snapshot({
      runId: 'corrupt', missionId: 'corrupt-12345678', dagTaskId: 'mission-corrupt-12345678',
      maxAuditBytes: 1,
    })
    await domain.table('events').put(missionAuditKey(corrupt), {
      version: 1, operation: 'plan', time: 1, snapshot: corrupt,
    })
    await domain.close()
    await expect(DurableMissionStore.open(ctx)).rejects.toBeInstanceOf(MissionStoreError)
  })

  it('detects storage-key collisions before publication', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableMissionStore.open(ctx)
    const first = snapshot()
    const events = (store as unknown as {
      readonly events: { get(key: string): unknown }
    }).events
    vi.spyOn(events, 'get').mockReturnValueOnce({
      version: 1, operation: 'plan', time: 1, snapshot: first,
    })
    await expect(store.append('plan', first)).rejects.toThrow(/already exists/u)
    await store.close()
  })

  it('sorts summaries by parent, generation, and mission id', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableMissionStore.open(ctx)
    const values = [
      snapshot({ parentSessionId: 'b', generation: 2, missionId: 'z-12345678', dagTaskId: 'mission-z-12345678' }),
      snapshot({ parentSessionId: 'a', generation: 2, missionId: 'z-12345678', dagTaskId: 'mission-z-12345678' }),
      snapshot({ parentSessionId: 'a', generation: 1, missionId: 'z-12345678', dagTaskId: 'mission-z-12345678' }),
      snapshot({ parentSessionId: 'a', generation: 1, missionId: 'a-12345678', dagTaskId: 'mission-a-12345678' }),
    ]
    for (const value of values) await store.append('plan', value)
    expect(store.list().map(value => [value.parentSessionId, value.generation, value.missionId])).toEqual([
      ['a', 1, 'a-12345678'],
      ['a', 1, 'z-12345678'],
      ['a', 2, 'z-12345678'],
      ['b', 2, 'z-12345678'],
    ])
    await store.close()
  })
})
