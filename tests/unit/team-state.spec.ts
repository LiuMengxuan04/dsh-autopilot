import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  acceptTeamMessage,
  acceptTeamStart,
  assertTeamAuditTransition,
  bindAcceptedTeamStartAttention,
  failTeamMessage,
  failTeamStart,
  foldTeamAudit,
  interruptTeamThread,
  markTeamThreadAttention,
  parseTeamChildLabel,
  prepareTeamMessage,
  prepareTeamThread,
  settleTeamThread,
  TEAM_STATE_VERSION,
  teamAuditRecordSchema,
  teamChildLabel,
  teamOrphanRecordSchema,
  TeamStateError,
  teamThreadIdentity,
  teamThreadSnapshotSchema,
} from '../../src/team-state.ts'
import type {
  TeamAuditRecord,
  TeamPendingMessage,
  TeamThreadOperation,
  TeamThreadSnapshot,
} from '../../src/team-state.ts'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

function prepared(taskId = 'build', now = 100): TeamThreadSnapshot {
  const runId = 'run/with symbols'
  return prepareTeamThread({
    parentSessionId: 'parent',
    runId,
    generation: 2,
    runRevisionAtClaim: 7,
    maxAuditRecords: 8192,
    maxAuditBytes: 256 * 1024 * 1024,
    taskId,
    provider: 'spawn',
    label: teamChildLabel(runId, 2, taskId),
    role: 'implementer',
    promptSha256: digest('build it'),
  }, now)
}

function record(operation: TeamThreadOperation, snapshot: TeamThreadSnapshot): TeamAuditRecord {
  return { version: TEAM_STATE_VERSION, operation, time: snapshot.updatedAt, snapshot }
}

function started(taskId = 'build', child = `child-${taskId}`): TeamThreadSnapshot {
  return acceptTeamStart(prepared(taskId), child, `initial-${taskId}`, 110)
}

const evidence = [{ kind: 'test' as const, ref: 'pnpm test', summary: 'tests passed' }]

describe('continuable team state', () => {
  it('tracks exact start, mailbox, interrupt, report, and settlement identities', () => {
    const first = prepared()
    expect(first).toMatchObject({ revision: 1, phase: 'starting', messages: [] })
    expect(Object.isFrozen(first)).toBe(true)
    expect(teamThreadIdentity(first)).toBe('parent\u0000run/with symbols\u00002\u0000build')
    expect(parseTeamChildLabel(first.label)).toEqual({ runId: first.runId, generation: 2, taskId: 'build' })

    const active = acceptTeamStart(first, 'child', 'initial', 110)
    expect(active).toMatchObject({
      revision: 2,
      phase: 'active',
      childSessionId: 'child',
      messages: [{ sequence: 1, kind: 'initial', messageId: 'initial', contentSha256: first.promptSha256 }],
    })
    const pending = prepareTeamMessage(active, {
      kind: 'followup', contentSha256: digest('continue'), preparedAt: 120,
    }, 120)
    const followed = acceptTeamMessage(pending, 'followup', 130)
    const interrupted = interruptTeamThread(followed, 'operator paused', 140)
    const resumed = acceptTeamMessage(prepareTeamMessage(interrupted, {
      kind: 'followup', contentSha256: digest('resume'), preparedAt: 150,
    }, 150), 'resume', 160)
    const report: TeamPendingMessage = {
      kind: 'report',
      contentSha256: digest('report'),
      preparedAt: 170,
      report: { status: 'completed', summary: 'done', evidence, submittedAt: 170 },
    }
    const reporting = acceptTeamMessage(prepareTeamMessage(resumed, report, 170), 'report', 180)
    const settled = settleTeamThread(reporting, 190)
    expect(settled).toMatchObject({
      phase: 'settled',
      report: { status: 'completed', messageId: 'report', acceptedAt: 180 },
      messages: [
        { kind: 'initial', messageId: 'initial' },
        { kind: 'followup', messageId: 'followup' },
        { kind: 'followup', messageId: 'resume' },
        { kind: 'report', messageId: 'report' },
      ],
    })
    expect(Object.isFrozen(settled.messages)).toBe(true)
    expect(Object.isFrozen(settled.report?.evidence)).toBe(true)

    const history = [
      record('prepare', first),
      record('start', active),
      record('followup-prepare', pending),
      record('followup-accepted', followed),
      record('interrupt', interrupted),
      record('followup-prepare', { ...prepareTeamMessage(interrupted, {
        kind: 'followup', contentSha256: digest('resume'), preparedAt: 150,
      }, 150) }),
      record('followup-accepted', resumed),
      record('report-prepare', prepareTeamMessage(resumed, report, 170)),
      record('report-accepted', reporting),
      record('settle', settled),
    ]
    const folded = foldTeamAudit([...history].reverse())
    expect(folded.current.get(teamThreadIdentity(first))).toEqual(settled)
    expect(folded.byChild.get('child')).toEqual(settled)
    expect(folded.history.map(item => item.snapshot.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('records pre-acceptance failures and fail-closed uncertainty without identities', () => {
    const first = prepared()
    const failed = failTeamStart(first, ' transport down ', 110)
    expect(failed).toMatchObject({ phase: 'failed', reason: 'transport down' })
    assertTeamAuditTransition(first, record('start-failed', failed))

    const active = started()
    const pendingFollowup = prepareTeamMessage(active, {
      kind: 'followup', contentSha256: digest('next'), preparedAt: 120,
    }, 120)
    const followupFailed = failTeamMessage(pendingFollowup, ' rejected ', 130)
    expect(followupFailed).toMatchObject({ phase: 'active', lastError: 'rejected' })
    assertTeamAuditTransition(pendingFollowup, record('followup-failed', followupFailed))

    const interrupted = interruptTeamThread(active, 'pause', 120)
    const retry = prepareTeamMessage(interrupted, {
      kind: 'followup', contentSha256: digest('next'), preparedAt: 130,
    }, 130)
    expect(failTeamMessage(retry, 'not accepted', 140).phase).toBe('interrupted')

    const pendingReport = prepareTeamMessage(active, {
      kind: 'report',
      contentSha256: digest('failed report'),
      preparedAt: 150,
      report: { status: 'failed', summary: 'could not build', evidence: [], submittedAt: 150 },
    }, 150)
    const reportFailed = failTeamMessage(pendingReport, 'parent absent', 160)
    expect(reportFailed.phase).toBe('active')
    assertTeamAuditTransition(pendingReport, record('report-failed', reportFailed))

    const attention = markTeamThreadAttention(active, ' acceptance uncertain ', 170)
    expect(attention).toMatchObject({ phase: 'needs-attention', reason: 'acceptance uncertain' })
    assertTeamAuditTransition(active, record('attention', attention))

    const uncertainStart = bindAcceptedTeamStartAttention(
      first,
      'accepted-child',
      'accepted-message',
      'normal binding append failed',
      180,
    )
    expect(uncertainStart).toMatchObject({
      phase: 'needs-attention',
      childSessionId: 'accepted-child',
      messages: [{ kind: 'initial', messageId: 'accepted-message' }],
    })
    assertTeamAuditTransition(first, record('attention', uncertainStart))
  })

  it('rejects malformed labels, reports, snapshots, and illegal local transitions', () => {
    expect(() => teamChildLabel('', 1, 'build')).toThrow(TeamStateError)
    expect(() => teamChildLabel('run', 0, 'build')).toThrow(TeamStateError)
    expect(() => teamChildLabel('run', 1, 'Bad')).toThrow(TeamStateError)
    expect(parseTeamChildLabel('other')).toBeUndefined()
    expect(parseTeamChildLabel('dsh-autopilot-team:A:1:build')).toBeUndefined()
    expect(parseTeamChildLabel(`dsh-autopilot-team:${Buffer.from('run').toString('base64url')}:999999999999999999999:build`))
      .toBeUndefined()

    const first = prepared()
    const active = started()
    expect(() => acceptTeamStart(active, 'other', 'other', 120)).toThrow(/cannot accept start/u)
    expect(() => failTeamStart(active, 'bad', 120)).toThrow(/cannot fail start/u)
    expect(() => failTeamStart(first, ' ', 120)).toThrow(/must not be empty/u)
    expect(() => bindAcceptedTeamStartAttention(active, 'child', 'message', 'x', 120))
      .toThrow(/cannot bind uncertain start/u)
    expect(() => bindAcceptedTeamStartAttention(first, 'child', 'message', ' ', 120))
      .toThrow(/must not be empty/u)
    expect(() => prepareTeamMessage(first, {
      kind: 'followup', contentSha256: digest('x'), preparedAt: 120,
    }, 120)).toThrow(/cannot prepare followup/u)
    const pending = prepareTeamMessage(active, {
      kind: 'followup', contentSha256: digest('x'), preparedAt: 120,
    }, 120)
    expect(() => prepareTeamMessage(pending, {
      kind: 'followup', contentSha256: digest('y'), preparedAt: 121,
    }, 121)).toThrow(/already pending/u)
    expect(() => acceptTeamMessage(active, 'none', 120)).toThrow(/no team delivery/u)
    expect(() => failTeamMessage(active, 'none', 120)).toThrow(/no team delivery/u)
    expect(() => failTeamMessage(pending, ' ', 130)).toThrow(/must not be empty/u)
    expect(() => interruptTeamThread(first, 'x', 120)).toThrow(/cannot interrupt/u)
    expect(() => interruptTeamThread(active, ' ', 120)).toThrow(/must not be empty/u)
    expect(() => settleTeamThread(active, 120)).toThrow(/cannot settle/u)
    expect(() => markTeamThreadAttention(first, 'x', 120)).toThrow(/cannot mark attention/u)
    expect(() => markTeamThreadAttention(failTeamStart(first, 'x', 110), 'x', 120)).toThrow(/cannot mark attention/u)
    expect(() => markTeamThreadAttention(active, ' ', 120)).toThrow(/must not be empty/u)

    expect(() => prepareTeamMessage(active, {
      kind: 'report',
      contentSha256: digest('report'),
      preparedAt: 120,
      report: { status: 'completed', summary: 'done', evidence: [], submittedAt: 120 },
    }, 120)).toThrow(/completed team reports require evidence/u)

    const malformed = { ...active, updatedAt: 99 }
    expect(() => teamThreadSnapshotSchema.parse(malformed)).toThrow(/updatedAt precedes/u)
    expect(() => teamThreadSnapshotSchema.parse({
      ...active,
      messages: [{ ...active.messages[0], sequence: 2 }],
    })).toThrow(/contiguous/u)
    expect(() => teamThreadSnapshotSchema.parse({
      ...active,
      messages: [{ ...active.messages[0], kind: 'followup' }],
    })).toThrow(/first team message/u)
    expect(() => teamThreadSnapshotSchema.parse({
      ...active,
      messages: [...active.messages, { ...active.messages[0], sequence: 2 }],
    })).toThrow(/unique/u)
    expect(() => teamThreadSnapshotSchema.parse({ ...active, messages: [] })).toThrow(/appear together/u)
    expect(() => teamThreadSnapshotSchema.parse({
      ...active,
      messages: [{ ...active.messages[0], contentSha256: digest('wrong') }],
    })).toThrow(/claimed prompt/u)
    expect(() => teamThreadSnapshotSchema.parse({ ...first, childSessionId: 'child' })).toThrow(/cannot own/u)
    expect(() => teamThreadSnapshotSchema.parse({ ...active, phase: 'active', childSessionId: undefined }))
      .toThrow()
    expect(() => teamThreadSnapshotSchema.parse({ ...active, report: {
      status: 'failed', summary: 'x', evidence: [], submittedAt: 1, messageId: 'r', acceptedAt: 1,
    } })).toThrow(/accepted reports/u)
    expect(() => teamThreadSnapshotSchema.parse({ ...active, phase: 'settled' })).toThrow(/require an accepted report/u)
    expect(() => teamThreadSnapshotSchema.parse({
      ...active,
      phase: 'reporting',
      pendingMessage: {
        kind: 'report', contentSha256: digest('x'), preparedAt: 1,
        report: { status: 'failed', summary: 'x', evidence: [], submittedAt: 1 },
      },
      report: { status: 'failed', summary: 'x', evidence: [], submittedAt: 1, messageId: 'r', acceptedAt: 1 },
    })).toThrow(/exactly one/u)

    const unsettled = prepareTeamMessage(active, {
      kind: 'report',
      contentSha256: digest('pending'),
      preparedAt: 130,
      report: { status: 'failed', summary: 'pending', evidence: [], submittedAt: 130 },
    }, 130)
    expect(() => settleTeamThread(unsettled, 140)).toThrow(/settlement requires/u)
  })

  it('rejects forged audit deltas and child attribution collisions', () => {
    const first = prepared()
    const active = started()
    expect(() => assertTeamAuditTransition(undefined, record('start', {
      ...active,
      revision: 1,
    }))).toThrow(/must begin/u)
    expect(() => assertTeamAuditTransition(undefined, { ...record('prepare', first), time: 999 })).toThrow(/audit time/u)
    for (const [name, forged] of [
      ['identity', { ...active, taskId: 'other' }],
      ['runRevisionAtClaim', { ...active, runRevisionAtClaim: 99 }],
      ['revision', { ...active, revision: 4 }],
      ['updatedAt', { ...active, updatedAt: 99 }],
      ['child', { ...active, revision: 3, updatedAt: 120, childSessionId: 'changed' }],
      ['messages', {
        ...active,
        revision: 3,
        updatedAt: 120,
        messages: [{ ...active.messages[0]!, messageId: 'rewritten' }],
      }],
    ] as const) {
      expect(() => assertTeamAuditTransition(
        name === 'identity' || name === 'runRevisionAtClaim' ? first : active,
        record(name === 'identity' || name === 'runRevisionAtClaim' ? 'start' : 'followup-accepted', forged),
      )).toThrow()
    }
    const same = { ...active, revision: 3, updatedAt: 120 }
    expect(() => assertTeamAuditTransition(active, record('prepare', same))).toThrow(/cannot produce|cannot follow/u)
    expect(() => assertTeamAuditTransition(active, record('settle', { ...same, phase: 'settled' } as TeamThreadSnapshot)))
      .toThrow()

    const failedWithoutReason = { ...failTeamStart(first, 'x', 110) } as { reason?: string }
    delete failedWithoutReason.reason
    const pendingFollowup = prepareTeamMessage(active, {
      kind: 'followup', contentSha256: digest('x'), preparedAt: 120,
    }, 120)
    const acceptedFollowup = acceptTeamMessage(pendingFollowup, 'next', 130)
    const interrupted = interruptTeamThread(active, 'pause', 120)
    const pendingReport = prepareTeamMessage(active, {
      kind: 'report', contentSha256: digest('r'), preparedAt: 120,
      report: { status: 'failed', summary: 'x', evidence: [], submittedAt: 120 },
    }, 120)
    const acceptedReport = acceptTeamMessage(pendingReport, 'report', 130)
    const settled = settleTeamThread(acceptedReport, 140)
    const forged = [
      ['start', active, { ...active, revision: 3, updatedAt: 120 }],
      ['start-failed', first, failedWithoutReason],
      ['followup-prepare', first, { ...pendingFollowup, revision: 2 }],
      ['followup-accepted', active, { ...acceptedFollowup, revision: 3 }],
      ['followup-failed', active, { ...active, revision: 3, updatedAt: 120, lastError: 'x' }],
      ['interrupt', interrupted, { ...interrupted, revision: 4, updatedAt: 130 }],
      ['report-prepare', active, { ...acceptedReport, revision: 3 }],
      ['report-accepted', acceptedReport, { ...acceptedReport, revision: 5, updatedAt: 140 }],
      ['report-failed', active, { ...active, revision: 3, updatedAt: 120, lastError: 'x' }],
      ['settle', active, { ...settled, revision: 3, updatedAt: 120 }],
      ['attention', settled, { ...settled, revision: 6, updatedAt: 150, phase: 'needs-attention', reason: 'x' }],
      ['attention', first, { ...first, revision: 2, updatedAt: 150, phase: 'needs-attention', reason: 'x' }],
    ] as const
    for (const [operation, previous, next] of forged) {
      expect(() => assertTeamAuditTransition(
        previous as TeamThreadSnapshot,
        record(operation, next as TeamThreadSnapshot),
      )).toThrow()
    }

    const otherFirst = prepared('test')
    const otherActive = acceptTeamStart(otherFirst, 'child-build', 'initial-test', 110)
    expect(() => foldTeamAudit([
      record('prepare', first),
      record('start', active),
      record('prepare', otherFirst),
      record('start', otherActive),
    ])).toThrow(/more than one/u)
  })

  it('validates audit and orphan records at the durable boundary', () => {
    const first = prepared()
    expect(teamAuditRecordSchema.parse(record('prepare', first))).toEqual(record('prepare', first))
    expect(() => teamAuditRecordSchema.parse({ ...record('prepare', first), extra: true })).toThrow()
    const orphan = {
      version: TEAM_STATE_VERSION,
      parentSessionId: 'parent',
      runId: 'run',
      generation: 1,
      childSessionId: 'child',
      observedAt: 1,
      reason: 'unattributed',
      label: 'label',
      initialMessageId: 'message',
      parentId: 'parent',
      depth: 1,
    }
    expect(teamOrphanRecordSchema.parse(orphan)).toEqual(orphan)
    expect(() => teamOrphanRecordSchema.parse({ ...orphan, depth: 0 })).toThrow()
  })
})
