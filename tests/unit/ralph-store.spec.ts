import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RALPH_STATE_VERSION } from '../../src/ralph-state.ts'
import type { RalphAuditRecord, RalphSnapshot } from '../../src/ralph-state.ts'
import {
  DurableRalphStore,
  foldRalphAudit,
  ralphAuditKey,
  RalphStoreError,
  ralphStoreDomainSpec,
} from '../../src/ralph-store.ts'
import { createStorageHarness } from '../helpers.ts'

function initial(taskId = 'leaf', now = 10): RalphSnapshot {
  return {
    version: RALPH_STATE_VERSION,
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    goalId: 'goal',
    taskId,
    revision: 1,
    phase: 'claiming',
    instruction: 'finish',
    policySha256: 'a'.repeat(64),
    maxRounds: 3,
    maxHandoffChars: 100,
    maxSummaryChars: 100,
    maxEvidenceItems: 4,
    reservedThroughRound: 0,
    rounds: [],
    createdAt: now,
    updatedAt: now,
  }
}

function audit(snapshot: RalphSnapshot): RalphAuditRecord {
  return { version: RALPH_STATE_VERSION, operation: 'prepare', time: snapshot.updatedAt, snapshot }
}

describe('durable Ralph store', () => {
  it('serializes appends, CAS, filtering, history, folding, and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-ralph-store-'))
    try {
      const first = await createStorageHarness(root)
      const store = await DurableRalphStore.open(first.ctx)
      const alpha = initial('alpha')
      const beta = initial('beta', 11)
      await Promise.all([store.append('prepare', beta), store.append('prepare', alpha)])
      const claimed: RalphSnapshot = {
        ...alpha,
        revision: 2,
        updatedAt: 12,
        phase: 'ready',
        claimedRunRevision: 4,
        reservedThroughRound: 1,
      }
      expect(await store.appendIfCurrent('claim', alpha, claimed)).toEqual(claimed)
      expect(await store.appendIfCurrent('claim', alpha, claimed)).toBeUndefined()
      expect(store.get(alpha)).toEqual(claimed)
      expect(store.list().map(item => item.taskId)).toEqual(['alpha', 'beta'])
      expect(store.list({ parentSessionId: 'other' })).toEqual([])
      expect(store.list({ runId: 'other' })).toEqual([])
      expect(store.list({ generation: 2 })).toEqual([])
      expect(store.history('other')).toEqual([])
      expect(store.history().map(item => item.snapshot.taskId)).toEqual(['alpha', 'alpha', 'beta'])
      expect(ralphAuditKey(claimed)).toContain('000000000002')
      expect(foldRalphAudit([audit(beta), audit(alpha)]).current.size).toBe(2)
      await store.close()
      await first.ctx.fiber.dispose()

      const second = await createStorageHarness(root)
      const reopened = await DurableRalphStore.open(second.ctx)
      expect(reopened.get(alpha)).toEqual(claimed)
      await reopened.close()
      await second.ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate keys, invalid history, disk failures, and closes failed opens', async () => {
    const { ctx } = await createStorageHarness()
    const store = await DurableRalphStore.open(ctx)
    const row = initial()
    await store.append('prepare', row)
    await expect(store.append('prepare', row)).rejects.toBeInstanceOf(Error)

    const duplicate = initial('duplicate')
    const internals = store as unknown as {
      events: { get(key: string): RalphAuditRecord | undefined; put(key: string, value: RalphAuditRecord): Promise<void> }
    }
    await internals.events.put(ralphAuditKey(duplicate), audit(duplicate))
    await expect(store.append('prepare', duplicate)).rejects.toBeInstanceOf(RalphStoreError)
    const failed = initial('failed')
    vi.spyOn(internals.events, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.append('prepare', failed)).rejects.toThrow('disk full')
    expect(store.get(failed)).toBeUndefined()
    await store.close()

    const domain = await ctx.storageDomain.open(ralphStoreDomainSpec)
    const malformed = initial('malformed')
    await domain.table('events').put('bad', {
      ...audit(malformed), operation: 'claim',
    })
    await domain.close()
    await expect(DurableRalphStore.open(ctx)).rejects.toBeInstanceOf(Error)

    const close = vi.fn(async () => {})
    vi.spyOn(ctx.storageDomain, 'open').mockResolvedValueOnce({
      table() { throw new Error('table unavailable') }, close,
    } as never)
    await expect(DurableRalphStore.open(ctx)).rejects.toThrow('table unavailable')
    expect(close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
