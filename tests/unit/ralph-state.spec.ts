import { describe, expect, it } from 'vitest'
import {
  assertRalphTransition,
  RALPH_STATE_VERSION,
  RalphStateError,
  ralphAuditRecordSchema,
  ralphEvidenceSchema,
  ralphIdentity,
  ralphSnapshotSchema,
  replaceLatestRound,
  totalEvidence,
} from '../../src/ralph-state.ts'
import type {
  RalphAuditRecord,
  RalphOperation,
  RalphRound,
  RalphSnapshot,
} from '../../src/ralph-state.ts'

const sha = 'a'.repeat(64)

function initial(overrides: Partial<RalphSnapshot> = {}): RalphSnapshot {
  return {
    version: RALPH_STATE_VERSION,
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    goalId: 'goal',
    taskId: 'leaf',
    revision: 1,
    phase: 'claiming',
    instruction: 'finish the leaf',
    policySha256: sha,
    maxRounds: 3,
    maxHandoffChars: 100,
    maxSummaryChars: 100,
    maxEvidenceItems: 4,
    reservedThroughRound: 0,
    rounds: [],
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

function next(
  previous: RalphSnapshot,
  operation: RalphOperation,
  changes: Partial<RalphSnapshot>,
): RalphSnapshot {
  const snapshot = { ...previous, ...changes, revision: previous.revision + 1, updatedAt: previous.updatedAt + 1 }
  assertRalphTransition(previous, {
    version: RALPH_STATE_VERSION,
    operation,
    time: snapshot.updatedAt,
    snapshot,
  })
  return snapshot
}

function starting(number: number): RalphRound {
  return { number, status: 'starting', startedAt: 20 + number, evidence: [] }
}

describe('Ralph durable state', () => {
  it('accepts the complete claim, fresh-round, continue, settle, and terminal path', () => {
    const prepared = initial()
    assertRalphTransition(undefined, {
      version: RALPH_STATE_VERSION, operation: 'prepare', time: 10, snapshot: prepared,
    })
    const claimed = next(prepared, 'claim', {
      phase: 'ready', claimedRunRevision: 4, reservedThroughRound: 1,
    })
    const roundOne = next(claimed, 'round-start', {
      phase: 'running', rounds: [starting(1)],
    })
    const bound = next(roundOne, 'round-bind', {
      rounds: [{ ...starting(1), childSessionId: 'child-1' }],
    })
    const continuedRound = {
      ...bound.rounds[0]!,
      status: 'continue' as const,
      finishedAt: 30,
      summary: 'needs a fresh pass',
      handoff: 'inspect the remaining failure',
      evidence: [{ kind: 'test' as const, ref: 'test-1', summary: 'one failing case remains' }],
    }
    const continued = next(bound, 'round-continue', {
      phase: 'ready', rounds: [continuedRound], handoff: continuedRound.handoff,
    })
    const reserving = next(continued, 'reservation-prepare', {
      phase: 'reserving', pendingReservationRound: 2,
    })
    const reserved = next(reserving, 'reservation-complete', {
      phase: 'ready', pendingReservationRound: undefined, reservedThroughRound: 2, claimedRunRevision: 7,
    })
    const roundTwo = next(reserved, 'round-start', {
      phase: 'running', rounds: [...reserved.rounds, starting(2)],
    })
    const completedRound = {
      ...roundTwo.rounds[1]!,
      status: 'completed' as const,
      finishedAt: 40,
      summary: 'leaf completed',
      evidence: [{ kind: 'file' as const, ref: 'src/x.ts', summary: 'implementation' }],
    }
    const settling = next(roundTwo, 'round-settle', {
      phase: 'settling', rounds: [continuedRound, completedRound],
    })
    const completed = next(settling, 'terminal', { phase: 'completed', reason: 'leaf completed' })
    expect(ralphSnapshotSchema.parse(completed)).toEqual(completed)
    expect(totalEvidence(completed.rounds)).toHaveLength(2)
    expect(ralphIdentity(completed)).toBe('parent\u0000run\u00001\u0000leaf')
    expect(replaceLatestRound(roundTwo, completedRound)).toEqual([continuedRound, completedRound])
    expect(ralphEvidenceSchema.parse(completedRound.evidence[0])).toEqual(completedRound.evidence[0])
  })

  it('supports interruption, explicit resume with a lower ceiling, cancellation, and fail-closed attention', () => {
    const claimed = next(initial(), 'claim', {
      phase: 'ready', claimedRunRevision: 2, reservedThroughRound: 1,
    })
    const running = next(claimed, 'round-start', { phase: 'running', rounds: [starting(1)] })
    const interruptedRound = {
      ...starting(1), status: 'interrupted' as const, finishedAt: 30, summary: 'paused',
    }
    const interrupted = next(running, 'interrupt', {
      phase: 'interrupted', rounds: [interruptedRound], reason: 'paused',
    })
    const resumed = next(interrupted, 'resume', { phase: 'ready', maxRounds: 2, reason: undefined })
    expect(next(resumed, 'cancel', { phase: 'cancelled', reason: 'cancelled' }).phase).toBe('cancelled')
    expect(next(interrupted, 'attention', { phase: 'needs-attention', reason: 'orphan' }).phase)
      .toBe('needs-attention')
    const preclaimInterrupted = next(initial(), 'interrupt', { phase: 'interrupted', reason: 'early abort' })
    const reserving = next(preclaimInterrupted, 'reservation-prepare', {
      phase: 'reserving', pendingReservationRound: 1,
    })
    expect(next(reserving, 'reservation-complete', {
      phase: 'ready', pendingReservationRound: undefined, reservedThroughRound: 1, claimedRunRevision: 3,
    }).phase).toBe('ready')
  })

  it('rejects malformed schemas and every transition invariant', () => {
    const prepared = initial()
    const record = (operation: RalphOperation, snapshot: RalphSnapshot, time = snapshot.updatedAt): RalphAuditRecord => ({
      version: RALPH_STATE_VERSION, operation, time, snapshot,
    })
    expect(() => assertRalphTransition(undefined, record('claim', prepared))).toThrow(RalphStateError)
    expect(() => assertRalphTransition(undefined, record('prepare', { ...prepared, revision: 2 })))
      .toThrow(/revision 1/)
    const claimed = next(prepared, 'claim', {
      phase: 'ready', claimedRunRevision: 2, reservedThroughRound: 1,
    })
    expect(() => assertRalphTransition(claimed, record('claim', { ...claimed, revision: 3, updatedAt: 12 })))
      .toThrow(/cannot follow/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, phase: 'ready', revision: 3, updatedAt: 12,
    }))).toThrow(/cannot produce/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, taskId: 'other', revision: 3, updatedAt: 12, phase: 'running', rounds: [starting(1)],
    }))).toThrow(/immutable/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, revision: 4, updatedAt: 12, phase: 'running', rounds: [starting(1)],
    }))).toThrow(/revisions/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, revision: 3, updatedAt: 10, phase: 'running', rounds: [starting(1)],
    }))).toThrow(/revisions/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, revision: 3, updatedAt: 12, maxRounds: 4, phase: 'running', rounds: [starting(1)],
    }))).toThrow(/maxRounds/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, revision: 3, updatedAt: 12, maxRounds: 2, phase: 'running', rounds: [starting(1)],
    }))).toThrow(/maxRounds/)
    expect(() => assertRalphTransition(claimed, record('resume', {
      ...claimed, revision: 3, updatedAt: 12, phase: 'ready', rounds: [starting(1)],
    }))).toThrow()
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, revision: 3, updatedAt: 12, phase: 'running', rounds: [starting(2)],
    }))).toThrow()
    expect(() => assertRalphTransition(claimed, record('round-bind', {
      ...claimed, revision: 3, updatedAt: 12, reservedThroughRound: 2,
    }))).toThrow()
    const running = next(claimed, 'round-start', { phase: 'running', rounds: [starting(1)] })
    expect(() => assertRalphTransition(running, record('round-bind', {
      ...running, revision: 4, updatedAt: 13, claimedRunRevision: 1,
    }))).toThrow(/backwards/)
    expect(() => assertRalphTransition(running, record('round-bind', {
      ...running, revision: 4, updatedAt: 13, claimedRunRevision: 3,
    }))).toThrow(/outside budget accounting/)
    expect(() => assertRalphTransition(claimed, record('reservation-prepare', {
      ...claimed,
      revision: 3,
      updatedAt: 12,
      phase: 'reserving',
      pendingReservationRound: 1,
      reservedThroughRound: 0,
    }))).toThrow(/decreased/)
    expect(() => assertRalphTransition(running, record('round-bind', {
      ...running, revision: 4, updatedAt: 13, reservedThroughRound: 2,
    }))).toThrow(/outside a reservation/)
    const continued = next(running, 'round-continue', {
      phase: 'ready',
      rounds: [{
        ...starting(1), status: 'continue', finishedAt: 30, summary: 'continue', handoff: 'next',
      }],
      handoff: 'next',
    })
    expect(() => assertRalphTransition(continued, record('reservation-prepare', {
      ...continued,
      revision: continued.revision + 1,
      updatedAt: continued.updatedAt + 1,
      phase: 'reserving',
      pendingReservationRound: 2,
      handoff: 'rewritten handoff',
    }))).toThrow(/handoff changed/)
    expect(() => assertRalphTransition(continued, record('reservation-prepare', {
      ...continued,
      revision: continued.revision + 1,
      updatedAt: continued.updatedAt + 1,
      phase: 'reserving',
      pendingReservationRound: 3,
      rounds: [...continued.rounds, starting(2)],
    }))).toThrow(/only round-start/)
    const reserved = next(next(continued, 'reservation-prepare', {
      phase: 'reserving', pendingReservationRound: 2,
    }), 'reservation-complete', {
      phase: 'ready', pendingReservationRound: undefined, reservedThroughRound: 2, claimedRunRevision: 3,
    })
    const runningTwo = next(reserved, 'round-start', {
      phase: 'running', rounds: [...reserved.rounds, starting(2)],
    })
    expect(() => assertRalphTransition(runningTwo, record('round-bind', {
      ...runningTwo,
      revision: runningTwo.revision + 1,
      updatedAt: runningTwo.updatedAt + 1,
      rounds: [{ ...runningTwo.rounds[0]!, summary: 'rewritten' }, runningTwo.rounds[1]!],
    }))).toThrow(/rewrote settled/)
    const interrupted = next(runningTwo, 'interrupt', {
      phase: 'interrupted',
      rounds: [runningTwo.rounds[0]!, {
        ...runningTwo.rounds[1]!, status: 'interrupted', finishedAt: 50, summary: 'paused',
      }],
      reason: 'paused',
    })
    expect(() => assertRalphTransition(interrupted, record('resume', {
      ...interrupted,
      revision: interrupted.revision + 1,
      updatedAt: interrupted.updatedAt + 1,
      phase: 'ready',
      rounds: [interrupted.rounds[0]!, { ...interrupted.rounds[1]!, summary: 'rewritten' }],
    }))).toThrow(/cannot rewrite Ralph rounds/)
    const terminal = next(running, 'cancel', { phase: 'cancelled', reason: 'stop' })
    expect(() => assertRalphTransition(terminal, record('cancel', {
      ...terminal, revision: terminal.revision + 1, updatedAt: terminal.updatedAt + 1,
    }))).toThrow(/terminal/)
    expect(() => assertRalphTransition(claimed, record('round-start', {
      ...claimed, revision: 3, updatedAt: 12, phase: 'running', rounds: [starting(1)],
    }, 99))).toThrow(/audit time/)
    expect(() => replaceLatestRound(claimed, starting(1))).toThrow(/no active round/)

    const malformed = [
      { ...prepared, updatedAt: 9 },
      { ...prepared, maxRounds: 1, rounds: [starting(1), starting(2)] },
      { ...prepared, reservedThroughRound: 2 },
      { ...prepared, rounds: [{ ...starting(2), status: 'interrupted', finishedAt: 3, summary: 'x' }] },
      { ...prepared, rounds: [starting(1), starting(2)], maxRounds: 2 },
      { ...prepared, claimedRunRevision: 1 },
      { ...prepared, phase: 'ready' },
      { ...claimed, phase: 'reserving', pendingReservationRound: undefined },
      { ...claimed, phase: 'ready', pendingReservationRound: 1 },
      { ...claimed, phase: 'reserving', pendingReservationRound: 2 },
      { ...claimed, phase: 'running' },
      { ...claimed, phase: 'settling' },
      { ...claimed, phase: 'completed' },
      { ...claimed, handoff: 'x'.repeat(101) },
      {
        ...claimed,
        maxEvidenceItems: 1,
        reservedThroughRound: 2,
        rounds: [
          { number: 1, status: 'continue', startedAt: 1, finishedAt: 2, summary: 'one', handoff: 'next', evidence: [
            { kind: 'note', ref: 'one', summary: 'one' },
          ] },
          { number: 2, status: 'failed', startedAt: 3, finishedAt: 4, summary: 'two', evidence: [
            { kind: 'note', ref: 'two', summary: 'two' },
          ] },
        ],
      },
      {
        ...claimed,
        maxSummaryChars: 2,
        rounds: [{ number: 1, status: 'failed', startedAt: 1, finishedAt: 2, summary: 'long', evidence: [] }],
      },
      { ...claimed, phase: 'running', reservedThroughRound: 0, rounds: [starting(1)] },
    ]
    for (const value of malformed) expect(ralphSnapshotSchema.safeParse(value).success).toBe(false)
    expect(ralphSnapshotSchema.safeParse({
      ...claimed,
      phase: 'settling',
      rounds: [{ ...starting(1), status: 'continue', finishedAt: 3, summary: 'x', handoff: 'next' }],
    }).success).toBe(false)
    for (const round of [
      { ...starting(1), finishedAt: 2 },
      { ...starting(1), status: 'failed' },
      { ...starting(1), status: 'continue', finishedAt: 2, summary: 'x' },
    ]) {
      expect(ralphSnapshotSchema.safeParse({
        ...claimed, phase: 'running', rounds: [round],
      }).success).toBe(false)
    }
    expect(ralphAuditRecordSchema.safeParse(record('prepare', prepared)).success).toBe(true)
  })
})
