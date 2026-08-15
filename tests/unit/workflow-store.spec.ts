import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  applyManagedWorkflowTask,
  claimManagedWorkflow,
  finishManagedWorkflow,
  prepareManagedWorkflow,
  requestManagedWorkflowCancel,
  settleManagedWorkflow,
  startManagedWorkflow,
  WORKFLOW_STATE_VERSION,
} from '../../src/workflow-state.ts'
import type {
  ManagedWorkflowAuditRecord,
  ManagedWorkflowOperation,
  ManagedWorkflowSnapshot,
} from '../../src/workflow-state.ts'
import {
  DurableManagedWorkflowStore,
  foldManagedWorkflowAudit,
  managedWorkflowAuditBytes,
  managedWorkflowAuditKey,
  ManagedWorkflowStoreError,
} from '../../src/workflow-store.ts'
import { createStorageHarness } from '../helpers.ts'

function prepared(overrides: Partial<ManagedWorkflowSnapshot> = {}): ManagedWorkflowSnapshot {
  return prepareManagedWorkflow({
    workflowId: '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
    parentSessionId: 'parent', runId: 'run', generation: 1, goalId: 'goal',
    maxAuditRecords: 100, maxAuditBytes: 1_000_000,
    profileId: 'fanout', profileSha256: 'a'.repeat(64), argsSha256: 'b'.repeat(64),
    taskIds: ['build'], maxTotalAgents: 1, subagentsStartedBefore: 0,
    ...overrides,
  }, 100)
}

function record(operation: ManagedWorkflowOperation, snapshot: ManagedWorkflowSnapshot): ManagedWorkflowAuditRecord {
  return { version: WORKFLOW_STATE_VERSION, operation, time: snapshot.updatedAt, snapshot }
}

function history(first = prepared()): ManagedWorkflowAuditRecord[] {
  const claimed = claimManagedWorkflow(first, 2, 110)
  const active = startManagedWorkflow(claimed, 'engine', 120)
  const settling = settleManagedWorkflow(active, {
    stopReason: 'completed', agentsStarted: 1, targetPhase: 'completed',
    outcomes: [{
      taskId: 'build', status: 'completed', summary: 'done',
      evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
    }],
  }, 130)
  const applied = applyManagedWorkflowTask(settling, 'build', 140)
  const finished = finishManagedWorkflow(applied, 150)
  return [
    record('prepare', first), record('claim', claimed), record('start', active),
    record('settle', settling), record('task-applied', applied), record('finish', finished),
  ]
}

describe('managed workflow audit folding', () => {
  it('folds stable histories and aggregates limits by exact run generation', () => {
    const first = history()
    const secondIntent = prepared({ workflowId: '8791447a-cb54-4218-9a13-b2cf80bfc74f' })
    const folded = foldManagedWorkflowAudit([...first, record('prepare', secondIntent)].reverse())
    expect(folded.current.get(first[0]?.snapshot.workflowId ?? '')).toEqual(first.at(-1)?.snapshot)
    expect(folded.current.get(secondIntent.workflowId)).toEqual(secondIntent)
    expect(folded.history).toHaveLength(7)
    expect(folded.usage.values().next().value).toMatchObject({ records: 7, bytes: expect.any(Number) })
    expect(foldManagedWorkflowAudit([]).current.size).toBe(0)
    expect(managedWorkflowAuditKey(secondIntent)).toContain(secondIntent.workflowId)
    expect(managedWorkflowAuditBytes(record('prepare', secondIntent))).toBeGreaterThan(0)
  })

  it.each([
    [[record('claim', prepared())], /begin with/u],
    [[record('prepare', { ...prepared(), revision: 2 })], /revision-one/u],
    [[{ ...record('prepare', prepared()), time: 999 }], /time does not match/u],
    [[record('prepare', prepared()), record('claim', { ...claimManagedWorkflow(prepared(), 2, 110), profileId: 'other' })], /immutable/u],
    [[record('prepare', prepared()), record('start', claimManagedWorkflow(prepared(), 2, 110))], /cannot produce/u],
    [[record('prepare', prepared()), record('claim', { ...claimManagedWorkflow(prepared(), 2, 110), revision: 3 })], /revision or timestamp/u],
    [[record('prepare', { ...prepared(), updatedAt: 200 }), record('claim', { ...claimManagedWorkflow(prepared(), 2, 110), updatedAt: 199 })], /revision or timestamp/u],
    [[...history(), record('uncertain', { ...history().at(-1)!.snapshot, revision: 7, phase: 'uncertain', reason: 'x', updatedAt: 160 })], /terminal workflow/u],
    [[record('prepare', prepared()), record('claim', { ...claimManagedWorkflow(prepared(), 2, 110), phase: 'claimed' }), record('settle', { ...claimManagedWorkflow(prepared(), 2, 110), revision: 3, phase: 'settling', engineRunId: 'e', engineStopReason: 'error', engineAgentsStarted: 0, targetPhase: 'error', outcomes: [{ taskId: 'build', status: 'failed', summary: 'x', evidence: [] }], reason: 'x', updatedAt: 120 })], /requires running/u],
  ])('rejects corrupt history %#', (records, message) => {
    expect(() => foldManagedWorkflowAudit(records)).toThrow(message)
  })

  it('rejects changed aggregate limits and record or byte exhaustion', () => {
    const first = prepared({ maxAuditRecords: 1 })
    expect(() => foldManagedWorkflowAudit([
      record('prepare', first),
      record('prepare', prepared({ workflowId: '8791447a-cb54-4218-9a13-b2cf80bfc74f' })),
    ])).toThrow(/changed its audit limits/u)
    const sameLimits = prepared({
      workflowId: '8791447a-cb54-4218-9a13-b2cf80bfc74f', maxAuditRecords: 1,
    })
    expect(() => foldManagedWorkflowAudit([record('prepare', first), record('prepare', sameLimits)]))
      .toThrow(/audit records/u)
    expect(() => foldManagedWorkflowAudit([record('prepare', prepared({ maxAuditBytes: 100 }))]))
      .toThrow(/audit bytes/u)
  })

  it('rejects operation-specific predecessor corruption and rewritten settlement order', () => {
    const first = prepared()
    const claimed = claimManagedWorkflow(first, 2, 110)
    const active = startManagedWorkflow(claimed, 'engine', 120)
    const rewoundClaim = { ...claimed, revision: 4, updatedAt: 130 }
    expect(() => foldManagedWorkflowAudit([
      record('prepare', first), record('claim', claimed), record('start', active),
      record('claim', rewoundClaim),
    ])).toThrow(/claim must follow prepared/u)

    const cancelling = requestManagedWorkflowCancel(claimed, 'cancel', 120)
    const restarted = { ...startManagedWorkflow(claimed, 'engine', 120), revision: 4, updatedAt: 130 }
    expect(() => foldManagedWorkflowAudit([
      record('prepare', first), record('claim', claimed), record('cancel-request', cancelling),
      record('start', restarted),
    ])).toThrow(/start must follow claimed/u)

    const two = prepared({ taskIds: ['build', 'test'], maxTotalAgents: 2 })
    const twoClaimed = claimManagedWorkflow(two, 2, 110)
    const twoActive = startManagedWorkflow(twoClaimed, 'engine', 120)
    const settling = settleManagedWorkflow(twoActive, {
      stopReason: 'completed', agentsStarted: 2, targetPhase: 'completed',
      outcomes: [
        { taskId: 'build', status: 'completed', summary: 'built', evidence: [{ kind: 'test', ref: 'a', summary: 'a' }] },
        { taskId: 'test', status: 'completed', summary: 'tested', evidence: [{ kind: 'test', ref: 'b', summary: 'b' }] },
      ],
    }, 130)
    expect(() => foldManagedWorkflowAudit([
      record('prepare', two), record('claim', twoClaimed), record('start', twoActive),
      record('task-applied', settling),
    ])).toThrow(/task-applied must append/u)
    const applied = applyManagedWorkflowTask(settling, 'build', 140)
    const reordered = {
      ...applied,
      revision: 6,
      updatedAt: 150,
      settledTaskIds: ['test', 'build'],
    }
    expect(() => foldManagedWorkflowAudit([
      record('prepare', two), record('claim', twoClaimed), record('start', twoActive),
      record('settle', settling), record('task-applied', applied), record('task-applied', reordered),
    ])).toThrow(/task-applied must append/u)
  })
})

describe('durable managed workflow store', () => {
  it('persists create, compare-and-set, reduce, list, history, and cold reopen', async () => {
    const harness = await createStorageHarness()
    const store = await DurableManagedWorkflowStore.open(harness.ctx)
    const first = prepared()
    await expect(store.create(first)).resolves.toEqual(first)
    const claimed = claimManagedWorkflow(first, 2, 110)
    await expect(store.appendIfCurrent('claim', first, claimed)).resolves.toEqual(claimed)
    const active = startManagedWorkflow(claimed, 'engine', 120)
    await expect(store.reduceCurrent(first.workflowId, current => current === undefined ? undefined : ({
      operation: 'start', snapshot: active,
    }))).resolves.toEqual(active)
    expect(store.get(first.workflowId)).toEqual(active)
    expect(store.list({ parentSessionId: 'parent', runId: 'run', generation: 1 })).toEqual([active])
    expect(store.list({ parentSessionId: 'other' })).toEqual([])
    expect(store.list({ includeTerminal: true })).toEqual([active])
    expect(store.history('parent')).toHaveLength(3)
    expect(store.history('other')).toEqual([])
    expect(store.history()).toHaveLength(3)
    await store.close()

    const reopened = await DurableManagedWorkflowStore.open(harness.ctx)
    expect(reopened.get(first.workflowId)).toEqual(active)
    await reopened.close()
    await harness.ctx.fiber.dispose()
  })

  it('rejects duplicate ids, stale appends, absent reductions, and invalid transitions', async () => {
    const harness = await createStorageHarness()
    const store = await DurableManagedWorkflowStore.open(harness.ctx)
    const first = prepared()
    await store.create(first)
    await expect(store.create(first)).rejects.toBeInstanceOf(ManagedWorkflowStoreError)
    const claimed = claimManagedWorkflow(first, 2, 110)
    await expect(store.appendIfCurrent('claim', { workflowId: first.workflowId, revision: 99 }, claimed))
      .rejects.toThrow(/revision changed/u)
    await expect(store.appendIfCurrent('start', first, claimed)).rejects.toThrow(/cannot produce/u)
    await expect(store.reduceCurrent('missing', () => ({ operation: 'claim', snapshot: claimed })))
      .rejects.toThrow(/does not exist/u)
    await expect(store.reduceCurrent('missing', () => undefined)).resolves.toBeUndefined()
    await store.close()
    await harness.ctx.fiber.dispose()
  })

  it('does not charge failed writes and enforces aggregate ceilings', async () => {
    const records = new Map<string, ManagedWorkflowAuditRecord>()
    let fail = false
    const table = {
      entries: () => records.entries(),
      get: (key: string) => records.get(key),
      put: vi.fn(async (key: string, value: ManagedWorkflowAuditRecord) => {
        if (fail) { fail = false; throw new Error('storage unavailable') }
        records.set(key, value)
      }),
    }
    const close = vi.fn(async () => {})
    const ctx = { storageDomain: { open: vi.fn(async () => ({ table: () => table, close })) } } as unknown as Context
    const store = await DurableManagedWorkflowStore.open(ctx)
    const first = prepared({ maxAuditRecords: 2, maxAuditBytes: 20_000 })
    await store.create(first)
    const claimed = claimManagedWorkflow(first, 2, 110)
    fail = true
    await expect(store.appendIfCurrent('claim', first, claimed)).rejects.toThrow('storage unavailable')
    await expect(store.appendIfCurrent('claim', first, claimed)).resolves.toEqual(claimed)
    await expect(store.appendIfCurrent('start', claimed, startManagedWorkflow(claimed, 'engine', 120)))
      .rejects.toThrow(/audit records/u)
    await store.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a corrupt domain and rejects a pre-existing immutable row key', async () => {
    const corruptClose = vi.fn(async () => {})
    const corruptRecord = { ...record('prepare', prepared()), time: 999 }
    const corruptContext = {
      storageDomain: {
        open: vi.fn(async () => ({
          table: () => ({ entries: () => new Map([['bad', corruptRecord]]).entries() }),
          close: corruptClose,
        })),
      },
    } as unknown as Context
    await expect(DurableManagedWorkflowStore.open(corruptContext)).rejects.toThrow(/time does not match/u)
    expect(corruptClose).toHaveBeenCalledOnce()

    const collisionClose = vi.fn(async () => {})
    const first = prepared()
    const existing = record('prepare', first)
    const collisionContext = {
      storageDomain: {
        open: vi.fn(async () => ({
          table: () => ({
            entries: () => new Map<string, ManagedWorkflowAuditRecord>().entries(),
            get: () => existing,
            put: vi.fn(),
          }),
          close: collisionClose,
        })),
      },
    } as unknown as Context
    const collisionStore = await DurableManagedWorkflowStore.open(collisionContext)
    await expect(collisionStore.create(first)).rejects.toThrow(/audit key/u)
    await collisionStore.close()
    expect(collisionClose).toHaveBeenCalledOnce()
  })
})
