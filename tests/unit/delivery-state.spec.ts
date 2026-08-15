import { describe, expect, it } from 'vitest'
import {
  DELIVERY_STATE_VERSION,
  DeliveryError,
  assertDeliverySnapshot,
  deliveryGitRef,
  deliveryPathIsWithin,
  deliveryText,
} from '../../src/delivery-state.ts'
import type { DeliverySnapshot } from '../../src/delivery-state.ts'

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

describe('isolated delivery state', () => {
  it('accepts bounded refs, text, and strict descendant paths', () => {
    expect(deliveryGitRef(' feature/one ', 'branch')).toBe('feature/one')
    expect(deliveryText(' message ', 'message', 20)).toBe('message')
    expect(deliveryPathIsWithin('/root', '/root/child')).toBe(true)
    expect(deliveryPathIsWithin('/root', '/root')).toBe(false)
    expect(deliveryPathIsWithin('/root', '/elsewhere')).toBe(false)
    expect(() => assertDeliverySnapshot(snapshot())).not.toThrow()
  })

  it.each(['', '.hidden', 'bad..ref', 'bad.lock', 'bad name', 'bad/@{ref'])('rejects unsafe ref %j', value => {
    expect(() => deliveryGitRef(value, 'branch')).toThrow(DeliveryError)
  })

  it('rejects empty and oversized bounded prose', () => {
    expect(() => deliveryText(' ', 'message', 2)).toThrow(/1-2/)
    expect(() => deliveryText('abc', 'message', 2)).toThrow(/1-2/)
  })

  it.each([
    [snapshot({ worktreePath: '/escape' }), /escapes/],
    [snapshot({ updatedAt: 99 }), /precedes/],
    [snapshot({ dirty: false, conflicted: true }), /must also be dirty/],
    [snapshot({ phase: 'prepared' }), /missing its plan/],
    [snapshot({ phase: 'needs-attention' }), /missing its reason/],
    [snapshot({ reason: 'unexpected' }), /only an attention/],
    [snapshot({ revision: 17 }), /audit-record ceiling/],
  ])('rejects inconsistent durable state %#', (value, message) => {
    expect(() => assertDeliverySnapshot(value)).toThrow(message)
  })
})
