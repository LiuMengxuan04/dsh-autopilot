import { describe, expect, it } from 'vitest'
import {
  assertMissionTransition,
  deriveMissionPhase,
  foldMissionAudit,
  missionCounts,
  missionSlug,
  missionSnapshotSchema,
  missionSourceSha256,
  parseMissionMarkdown,
} from '../../src/mission-state.ts'
import type { MissionAuditRecord, MissionSnapshot } from '../../src/mission-state.ts'

const limits = { maxTasks: 8, maxPromptChars: 80, maxTotalPromptChars: 240 }

function snapshot(overrides: Partial<MissionSnapshot> = {}): MissionSnapshot {
  return {
    version: 1,
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    goalId: 'goal',
    missionId: 'release-12345678',
    dagTaskId: 'mission-release-12345678',
    revision: 1,
    source: { path: '/repo/release.md', sha256: 'a'.repeat(64), bytes: 12 },
    phase: 'planned',
    continueOnError: false,
    tasks: [{ id: 'task-001', prompt: 'Audit it', status: 'planned', attempts: [], updatedAt: 10 }],
    maxAuditRecords: 64,
    maxAuditBytes: 65_536,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

function record(value: MissionSnapshot, operation: MissionAuditRecord['operation']): MissionAuditRecord {
  return { version: 1, operation, time: value.updatedAt, snapshot: value }
}

describe('mission state', () => {
  it('parses raw prompts, Markdown lists, checkboxes, numbering, headings, and comments in order', () => {
    expect(parseMissionMarkdown([
      '# Release',
      '<!-- hidden',
      'still hidden',
      'still hidden -->',
      '- [ ] Audit the failure.',
      '* Apply the fix.',
      '3) Run tests. <!-- inline -->',
      'Summarize evidence.',
      '<!-- whole line -->',
    ].join('\n'), limits)).toEqual([
      { id: 'task-001', prompt: 'Audit the failure.' },
      { id: 'task-002', prompt: 'Apply the fix.' },
      { id: 'task-003', prompt: 'Run tests.' },
      { id: 'task-004', prompt: 'Summarize evidence.' },
    ])
    expect(missionSlug('/repo/A Strange Release!!.md', 'b'.repeat(64))).toBe('a-strange-release-bbbbbbbb')
    expect(missionSlug('/repo/!!!.md', 'c'.repeat(64))).toBe('mission-cccccccc')
    expect(missionSourceSha256(new TextEncoder().encode('mission'))).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects malformed or over-limit mission input', () => {
    expect(() => parseMissionMarkdown('', limits)).toThrow(/no prompts/u)
    expect(() => parseMissionMarkdown('<!-- never closes', limits)).toThrow(/unterminated/u)
    expect(() => parseMissionMarkdown('x'.repeat(81), limits)).toThrow(/exceeds 80/u)
    expect(() => parseMissionMarkdown('a\nb\nc', { ...limits, maxTasks: 2 })).toThrow(/exceeds 2/u)
    expect(() => parseMissionMarkdown('a'.repeat(60) + '\n' + 'b'.repeat(60), {
      ...limits, maxTotalPromptChars: 100,
    })).toThrow(/aggregate/u)
    for (const invalid of [
      { ...limits, maxTasks: 0 },
      { ...limits, maxPromptChars: 1.5 },
      { ...limits, maxTotalPromptChars: Number.MAX_VALUE },
    ]) expect(() => parseMissionMarkdown('task', invalid)).toThrow(/positive safe integer/u)
  })

  it('derives every aggregate state and stable counts', () => {
    const task = snapshot().tasks[0]!
    const withStatus = (status: typeof task.status) => [{ ...task, status }]
    expect(deriveMissionPhase(withStatus('running'))).toBe('running')
    expect(deriveMissionPhase(withStatus('blocked'))).toBe('blocked')
    expect(deriveMissionPhase(withStatus('needs-human-review'))).toBe('needs-human-review')
    expect(deriveMissionPhase(withStatus('failed'))).toBe('failed')
    expect(deriveMissionPhase(withStatus('passed'))).toBe('passed')
    expect(deriveMissionPhase(withStatus('skipped'))).toBe('planned')
    expect(missionCounts([
      ...withStatus('passed'),
      { ...task, id: 'task-002', status: 'blocked' },
    ])).toMatchObject({ passed: 1, blocked: 1, planned: 0 })
  })

  it('validates attempt, task, aggregate, identity, and revision invariants', () => {
    expect(missionSnapshotSchema.parse(snapshot())).toEqual(snapshot())
    const runningTask = {
      ...snapshot().tasks[0]!,
      status: 'running' as const,
      reason: 'stale',
    }
    expect(() => missionSnapshotSchema.parse(snapshot({ phase: 'running', tasks: [runningTask] })))
      .toThrow(/running mission tasks/u)
    const passedWithoutEvidence = {
      ...snapshot().tasks[0]!,
      status: 'passed' as const,
      attempts: [{
        number: 1, startedAt: 11, finishedAt: 12, status: 'passed' as const,
        summary: 'done', evidence: [],
      }],
      updatedAt: 12,
    }
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'passed', tasks: [passedWithoutEvidence], updatedAt: 12,
    }))).toThrow(/require evidence/u)
    expect(() => missionSnapshotSchema.parse(snapshot({ reason: 'orphan reason' }))).not.toThrow()

    const passedAttempt = {
      number: 1,
      startedAt: 10,
      finishedAt: 11,
      status: 'passed' as const,
      summary: 'done',
      evidence: [{ kind: 'test' as const, ref: 'tests', summary: 'passed' }],
    }
    const cases: Array<[Partial<MissionSnapshot>, RegExp]> = [
      [{ updatedAt: 9 }, /precedes/u],
      [{ tasks: [{ ...snapshot().tasks[0]!, id: 'task-002' }] }, /source order/u],
      [{ tasks: [{ ...snapshot().tasks[0]!, updatedAt: 11 }] }, /exceeds summary/u],
      [{
        phase: 'running',
        tasks: [
          { ...snapshot().tasks[0]!, status: 'running' },
          { ...snapshot().tasks[0]!, id: 'task-002', status: 'running' },
        ],
      }, /only one task/u],
      [{ phase: 'running' }, /exactly one running/u],
      [{ phase: 'failed' }, /disagrees/u],
      [{ phase: 'needs-attention' }, /require a reason/u],
      [{ tasks: [{ ...snapshot().tasks[0]!, status: 'blocked' }] }, /require a reason/u],
      [{
        phase: 'passed', updatedAt: 11,
        tasks: [{
          ...snapshot().tasks[0]!, status: 'passed', attempts: [{ ...passedAttempt, number: 2 }], updatedAt: 11,
        }],
      }, /mission attempt numbers/u],
      [{
        phase: 'failed', updatedAt: 11,
        tasks: [{
          ...snapshot().tasks[0]!, status: 'failed', reason: 'late', updatedAt: 11,
          attempts: [{ ...passedAttempt, number: 1, startedAt: 12, finishedAt: 11, status: 'failed', evidence: [] }],
        }],
      }, /finishes before/u],
    ]
    for (const [overrides, message] of cases) {
      expect(() => missionSnapshotSchema.parse(snapshot(overrides))).toThrow(message)
    }
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'running',
      tasks: [{ ...snapshot().tasks[0]!, status: 'running', reason: 'terminal' }],
    }))).toThrow(/cannot carry/u)

    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'needs-human-review', reason: 'operator',
      tasks: [{ ...snapshot().tasks[0]!, status: 'needs-human-review', reason: 'operator' }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'passed', updatedAt: 11,
      tasks: [{ ...snapshot().tasks[0]!, status: 'passed', attempts: [passedAttempt], updatedAt: 11 }],
    }))).not.toThrow()

    const first = snapshot()
    assertMissionTransition(undefined, record(first, 'plan'))
    const second = snapshot({ revision: 2, updatedAt: 11 })
    assertMissionTransition(first, record(second, 'run-start'))
    expect(() => assertMissionTransition(undefined, record({ ...first, revision: 2 }, 'plan'))).toThrow(/first/u)
    expect(() => assertMissionTransition(first, record({ ...second, goalId: 'other' }, 'run-start')))
      .toThrow(/immutable/u)
    expect(() => assertMissionTransition(first, record({ ...second, revision: 3 }, 'run-start')))
      .toThrow(/increase by one/u)
    expect(() => assertMissionTransition(first, record({
      ...second, tasks: [{ ...second.tasks[0]!, prompt: 'changed' }],
    }, 'run-start'))).toThrow(/parsed prompts are immutable/u)
    expect(() => assertMissionTransition(first, record({
      ...second, maxAuditRecords: second.maxAuditRecords + 1,
    }, 'run-start'))).toThrow(/ceilings are immutable/u)
    expect(() => missionSnapshotSchema.parse(snapshot({
      updatedAt: 2,
    }))).toThrow(/task time exceeds/u)
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'needs-attention', reason: 'storage uncertainty',
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'passed', updatedAt: 11,
      tasks: [{ ...snapshot().tasks[0]!, status: 'passed', attempts: [passedAttempt], updatedAt: 11 }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'planned', tasks: [{ ...snapshot().tasks[0]!, status: 'blocked', reason: 'hold' }],
    }))).toThrow(/disagrees/u)
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'running', tasks: [{ ...snapshot().tasks[0]!, status: 'running' }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'blocked', tasks: [{ ...snapshot().tasks[0]!, status: 'blocked', reason: 'hold' }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'needs-human-review', tasks: [{
        ...snapshot().tasks[0]!, status: 'needs-human-review', reason: 'owner',
      }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'failed', tasks: [{ ...snapshot().tasks[0]!, status: 'failed' }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'passed', updatedAt: 11,
      tasks: [{ ...snapshot().tasks[0]!, status: 'passed', attempts: [passedAttempt], updatedAt: 11 }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'planned', tasks: [{ ...snapshot().tasks[0]!, status: 'skipped' }],
    }))).not.toThrow()

    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'failed', updatedAt: 11,
      tasks: [{
        ...snapshot().tasks[0]!, status: 'failed', reason: 'failed', updatedAt: 11,
        attempts: [{ ...passedAttempt, status: 'failed', evidence: [] }],
      }],
    }))).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'blocked', updatedAt: 11,
      tasks: [{
        ...snapshot().tasks[0]!, status: 'blocked', reason: 'blocked', updatedAt: 11,
        attempts: [{ ...passedAttempt, status: 'blocked', evidence: [] }],
      }],
    }))).not.toThrow()

    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'running', tasks: [
        { ...snapshot().tasks[0]!, status: 'running' },
        { ...snapshot().tasks[0]!, id: 'task-002' },
      ],
    }))).not.toThrow()

    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'passed', updatedAt: 11,
      tasks: [{ ...snapshot().tasks[0]!, status: 'passed', attempts: [passedAttempt], updatedAt: 11 }],
    }))).not.toThrow()

    expect(() => missionSnapshotSchema.parse(snapshot())).not.toThrow()
    expect(() => missionSnapshotSchema.parse(snapshot({
      phase: 'needs-attention', reason: 'manual recovery required',
    }))).not.toThrow()

    const invalidRecord = record(snapshot(), 'plan')
    expect(() => missionSnapshotSchema.parse(snapshot())).not.toThrow()
    expect(() => ({ ...invalidRecord, time: 2 })).not.toThrow()
    expect(() => foldMissionAudit([{ ...invalidRecord, time: 2 }])).toThrow(/ledger time/u)
  })

  it('folds interleaved missions in revision order and rejects corrupted history', () => {
    const first = snapshot()
    const second = snapshot({ revision: 2, updatedAt: 11 })
    const other = snapshot({
      missionId: 'other-12345678', dagTaskId: 'mission-other-12345678', revision: 1, updatedAt: 12,
    })
    const folded = foldMissionAudit([record(second, 'run-start'), record(other, 'plan'), record(first, 'plan')])
    expect([...folded.values()].map(item => [item.missionId, item.revision])).toEqual([
      ['other-12345678', 1],
      ['release-12345678', 2],
    ])
    expect(() => foldMissionAudit([record(second, 'run-start')])).toThrow(/first/u)
  })
})
