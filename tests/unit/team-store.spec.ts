import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  acceptTeamMessage,
  acceptTeamStart,
  prepareTeamMessage,
  prepareTeamThread,
  TEAM_STATE_VERSION,
  teamChildLabel,
} from '../../src/team-state.ts'
import type { TeamAuditRecord, TeamOrphanRecord, TeamThreadSnapshot } from '../../src/team-state.ts'
import {
  DurableTeamStore,
  teamAuditKey,
  teamOrphanKey,
  TeamStoreError,
  teamStoreDomainSpec,
} from '../../src/team-store.ts'
import { createStorageHarness } from '../helpers.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

function initial(
  taskId = 'build',
  now = 100,
  limits: { readonly maxAuditRecords?: number; readonly maxAuditBytes?: number } = {},
): TeamThreadSnapshot {
  return prepareTeamThread({
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    runRevisionAtClaim: 3,
    maxAuditRecords: limits.maxAuditRecords ?? 8192,
    maxAuditBytes: limits.maxAuditBytes ?? 256 * 1024 * 1024,
    taskId,
    provider: 'spawn',
    label: teamChildLabel('run', 1, taskId),
    role: 'worker',
    promptSha256: sha(taskId),
  }, now)
}

function audit(operation: TeamAuditRecord['operation'], snapshot: TeamThreadSnapshot): TeamAuditRecord {
  return { version: TEAM_STATE_VERSION, operation, time: snapshot.updatedAt, snapshot }
}

function orphan(overrides: Partial<TeamOrphanRecord> = {}): TeamOrphanRecord {
  return {
    version: TEAM_STATE_VERSION,
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    childSessionId: 'orphan',
    observedAt: 500,
    reason: 'unattributed child',
    ...overrides,
  }
}

describe('durable continuable-team store', () => {
  it('persists serialized revisions, child indexes, filters, history, and idempotent orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-team-store-'))
    try {
      const firstHarness = await createStorageHarness(root)
      const store = await DurableTeamStore.open(firstHarness.ctx)
      const build = initial('build')
      const test = initial('test', 101)
      await Promise.all([
        store.append('prepare', build),
        store.append('prepare', test),
      ])
      expect(await store.reduceCurrent(build, () => undefined)).toBeUndefined()
      const active = acceptTeamStart(build, 'child-build', 'initial-build', 110)
      expect(await store.reduceCurrent(build, current => {
        expect(current).toEqual(build)
        return { operation: 'start', snapshot: active }
      })).toEqual(active)
      expect(store.get(build)).toEqual(active)
      expect(store.getByChild('child-build')).toEqual(active)
      expect(store.getByChild('missing')).toBeUndefined()
      expect(store.list().map(item => item.taskId)).toEqual(['build', 'test'])
      expect(store.list({ parentSessionId: 'other' })).toEqual([])
      expect(store.list({ parentSessionId: 'parent', runId: 'other' })).toEqual([])
      expect(store.list({ parentSessionId: 'parent', runId: 'run', generation: 2 })).toEqual([])
      expect(store.history().map(item => item.operation)).toEqual(['prepare', 'start', 'prepare'])
      expect(store.history('other')).toEqual([])

      const firstOrphan = orphan({ label: 'unknown', parentId: 'parent', depth: 1 })
      expect(await store.recordOrphan(firstOrphan)).toEqual(firstOrphan)
      expect(await store.recordOrphan({ ...firstOrphan, reason: 'later observation', observedAt: 600 }))
        .toEqual(firstOrphan)
      await store.recordOrphan(orphan({ childSessionId: 'another', observedAt: 400 }))
      expect(store.orphans().map(item => item.childSessionId)).toEqual(['another', 'orphan'])
      expect(store.orphans('other')).toEqual([])
      expect(teamAuditKey(active)).toMatch(/\.000000000001\./u)
      expect(teamOrphanKey(firstOrphan)).toBe(teamOrphanKey({ ...firstOrphan, reason: 'different' }))

      await store.close()
      await firstHarness.ctx.fiber.dispose()

      const secondHarness = await createStorageHarness(root)
      const reopened = await DurableTeamStore.open(secondHarness.ctx)
      expect(reopened.get(build)).toEqual(active)
      expect(reopened.getByChild('child-build')).toEqual(active)
      expect(reopened.orphans()).toHaveLength(2)
      await reopened.close()
      await secondHarness.ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate revisions, child collisions, write failures, and malformed appends', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableTeamStore.open(ctx)
    const build = initial('build')
    await store.append('prepare', build)
    await expect(store.append('prepare', build)).rejects.toBeInstanceOf(Error)

    const active = acceptTeamStart(build, 'shared-child', 'initial-build', 110)
    await store.append('start', active)
    const pending = prepareTeamMessage(active, {
      kind: 'followup', contentSha256: sha('next'), preparedAt: 120,
    }, 120)
    await store.append('followup-prepare', pending)
    await store.append('followup-accepted', acceptTeamMessage(pending, 'next-message', 130))
    const test = initial('test')
    await store.append('prepare', test)
    await expect(store.append('start', acceptTeamStart(test, 'shared-child', 'initial-test', 110)))
      .rejects.toBeInstanceOf(TeamStoreError)

    const future = initial('future')
    const internals = store as unknown as {
      events: {
        put(key: string, value: TeamAuditRecord): Promise<void>
      }
    }
    await internals.events.put(teamAuditKey(future), audit('prepare', future))
    await expect(store.append('prepare', future)).rejects.toThrow(/already exists/u)
    const diskFailure = initial('disk-failure')
    vi.spyOn(internals.events, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.append('prepare', diskFailure)).rejects.toThrow('disk full')
    expect(store.get(diskFailure)).toBeUndefined()

    await expect(store.recordOrphan({ ...orphan(), reason: '' })).rejects.toBeInstanceOf(Error)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('enforces materialized whole-snapshot audit record and aggregate-byte ceilings', async () => {
    const recordsHarness = await createStorageHarness()
    const recordsStore = await DurableTeamStore.open(recordsHarness.ctx)
    const recordLimited = initial('record-limited', 100, { maxAuditRecords: 1 })
    await recordsStore.append('prepare', recordLimited)
    await expect(recordsStore.append(
      'start',
      acceptTeamStart(recordLimited, 'record-child', 'record-message', 110),
    )).rejects.toThrow(/audit records/u)
    expect(recordsStore.get(recordLimited)).toEqual(recordLimited)
    await recordsStore.close()
    await recordsHarness.ctx.fiber.dispose()

    const bytesHarness = await createStorageHarness()
    const bytesStore = await DurableTeamStore.open(bytesHarness.ctx)
    const byteProbe = initial('byte-limited')
    const firstRecordBytes = Buffer.byteLength(JSON.stringify(audit('prepare', byteProbe)), 'utf8')
    const byteLimited = initial('byte-limited', 100, { maxAuditBytes: firstRecordBytes })
    await bytesStore.append('prepare', byteLimited)
    await expect(bytesStore.append(
      'start',
      acceptTeamStart(byteLimited, 'byte-child', 'byte-message', 110),
    )).rejects.toThrow(/audit bytes/u)
    expect(bytesStore.get(byteLimited)).toEqual(byteLimited)
    await bytesStore.close()
    await bytesHarness.ctx.fiber.dispose()

    const failedWriteHarness = await createStorageHarness()
    const failedWriteStore = await DurableTeamStore.open(failedWriteHarness.ctx)
    const failedWriteInternals = failedWriteStore as unknown as {
      events: { put(key: string, value: TeamAuditRecord): Promise<void> }
    }
    vi.spyOn(failedWriteInternals.events, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(failedWriteStore.append(
      'prepare',
      initial('failed-limit-write', 100, { maxAuditRecords: 1 }),
    )).rejects.toThrow('disk full')
    await expect(failedWriteStore.append(
      'prepare',
      initial('replacement-limit', 101, { maxAuditRecords: 2 }),
    )).resolves.toBeDefined()
    await failedWriteStore.close()
    await failedWriteHarness.ctx.fiber.dispose()
  })

  it('rejects a second task that changes one run generation materialized audit limits', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableTeamStore.open(ctx)
    await store.append('prepare', initial('first'))
    await expect(store.append(
      'prepare',
      initial('second', 101, { maxAuditRecords: 8191 }),
    )).rejects.toThrow(/changed its materialized audit limits/u)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('fails open atomically when persisted audit or orphan history is inconsistent', async () => {
    const { ctx } = await createStorageHarness()
    const domain = await ctx.storageDomain.open(teamStoreDomainSpec)
    const duplicate = orphan()
    await domain.table('orphans').put('orphan-one', duplicate)
    await domain.table('orphans').put('orphan-two', duplicate)
    await domain.close()
    await expect(DurableTeamStore.open(ctx)).rejects.toBeInstanceOf(Error)
    await ctx.fiber.dispose()
  })

  it('rejects persisted audit history that exceeds either materialized ceiling', async () => {
    for (const kind of ['records', 'bytes'] as const) {
      const { ctx } = await createStorageHarness()
      const domain = await ctx.storageDomain.open(teamStoreDomainSpec)
      const probe = initial(`persisted-${kind}`)
      const firstBytes = Buffer.byteLength(JSON.stringify(audit('prepare', probe)), 'utf8')
      const first = initial(`persisted-${kind}`, 100, kind === 'records'
        ? { maxAuditRecords: 1 }
        : { maxAuditBytes: firstBytes })
      const second = acceptTeamStart(first, `${kind}-child`, `${kind}-message`, 110)
      await domain.table('events').put(teamAuditKey(first), audit('prepare', first))
      await domain.table('events').put(teamAuditKey(second), audit('start', second))
      await domain.close()
      await expect(DurableTeamStore.open(ctx)).rejects.toThrow(/exceeds its audit limits/u)
      await ctx.fiber.dispose()
    }
  })

  it('closes a newly opened domain when table construction throws', async () => {
    const { ctx } = await createStorageHarness()
    const close = vi.fn(async () => {})
    const open = vi.spyOn(ctx.storageDomain, 'open').mockResolvedValueOnce({
      table() { throw new Error('table unavailable') },
      close,
    } as never)
    await expect(DurableTeamStore.open(ctx)).rejects.toThrow('table unavailable')
    expect(open).toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
