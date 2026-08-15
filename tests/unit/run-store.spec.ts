import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DurableRunStore,
  foldRunAudit,
  runAuditKey,
  RunStoreError,
} from '../../src/run-store.ts'
import {
  MAX_COMPLETION_DELIVERY_ATTEMPTS,
  RUN_STATE_VERSION,
  VERIFICATION_POLICY_VERSION,
} from '../../src/run-state.ts'
import type {
  DynamicExtensionVersion,
  RunAuditRecord,
  RunOperation,
  RunPlan,
  RunSnapshot,
  VerificationBaseline,
  VerificationRecord,
  VerificationPolicy,
} from '../../src/run-state.ts'
import { createStorageHarness } from '../helpers.ts'

const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const grantedAt = overrides.grantedAt ?? 100
  const updatedAt = overrides.updatedAt ?? grantedAt
  return {
    version: RUN_STATE_VERSION,
    runId: 'run-1',
    generation: 1,
    revision: 1,
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'running',
    autoResume: true,
    grantedAt,
    updatedAt,
    expiresAt: 1100,
    remainingActiveMs: 1000,
    maxActiveMs: 1000,
    selfModification: 'host-only',
    budgets: {
      maxVerificationAttempts: 3,
      maxDynamicPackages: 8,
      maxSubagents: 32,
      maxConcurrentSubagents: 4,
      maxTasks: 256,
      maxTaskAttempts: 2048,
      maxEvidenceItems: 4096,
      maxSnapshotBytes: 524_288,
      maxAuditRecords: 8192,
      maxAuditBytes: 268_435_456,
      maxDynamicSourceChars: 262_144,
    },
    usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 0 },
    dynamicExtensions: [],
    flow: { revision: 1, stage: 'interview', cycle: 1, planReviewAttempts: 0, updatedAt: grantedAt },
    verificationHistory: [],
    completionReported: false,
    ...overrides,
  }
}

function record(operation: RunOperation, value: RunSnapshot): RunAuditRecord {
  return { version: RUN_STATE_VERSION, operation, time: value.updatedAt, snapshot: value }
}

function mutate(current: RunSnapshot, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return snapshot({
    ...current,
    revision: current.revision + 1,
    updatedAt: current.updatedAt + 1,
    ...overrides,
  })
}

function twoRecordAuditLimit(): number {
  let limit = 999_999
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const first = snapshot({ budgets: { ...snapshot().budgets, maxAuditBytes: limit } })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    const firstBytes = Buffer.byteLength(JSON.stringify(record('start', first)), 'utf8')
    const secondBytes = Buffer.byteLength(JSON.stringify(record('pause', paused)), 'utf8')
    limit = firstBytes + Math.floor(secondBytes / 2)
  }
  return limit
}

function threeRecordAuditLimit(): number {
  let limit = 999_999
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const first = snapshot({ budgets: { ...snapshot().budgets, maxAuditBytes: limit } })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    const firstBytes = Buffer.byteLength(JSON.stringify(record('start', first)), 'utf8')
    const secondBytes = Buffer.byteLength(JSON.stringify(record('pause', paused)), 'utf8')
    limit = firstBytes + secondBytes + Math.floor(secondBytes / 2)
  }
  return limit
}

function verificationPolicy(): VerificationPolicy {
  return {
    version: VERIFICATION_POLICY_VERSION,
    frozenAt: 100,
    sha256: 'a'.repeat(64),
    minimumEvidenceItems: 1,
    maxOutputChars: 4000,
    fixedChecks: [{ name: 'tests', commandSha256: 'b'.repeat(64), timeoutMs: 120_000 }],
    autoDiscoverChecks: false,
    projectChecks: [],
    maxProjectChecks: 8,
    projectCheckTimeoutMs: 600_000,
    reviewers: [{
      role: 'requirements',
      descriptionSha256: 'c'.repeat(64),
      primary: { subagentProvider: 'spawn' },
      fallbacks: [],
    }],
  }
}

function verificationBaseline(): VerificationBaseline {
  return {
    kind: 'reviewer-only',
    frozenAt: 100,
    manifests: [],
    checks: [],
    reason: 'no-supported-project',
  }
}

function verificationRecord(): VerificationRecord {
  return {
    attempt: 1,
    startedAt: 100,
    finishedAt: 101,
    verdict: 'pass',
    summary: 'verified',
    findings: [],
    checks: [],
    reviewers: [],
  }
}

function dynamicExtension(): DynamicExtensionVersion {
  return {
    logicalId: 'extension',
    version: 1,
    name: 'extension',
    purpose: 'test durable initial-state validation',
    hostCode: 'export default {}',
    sourceSha256: 'd'.repeat(64),
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
  }
}

function plan(): RunPlan {
  return {
    revision: 1,
    intent: 'implementation',
    acceptanceCriteria: ['covered'],
    tasks: [{
      id: 'task',
      title: 'Cover durable history',
      description: 'Exercise initial-state invariants.',
      acceptanceCriteria: ['covered'],
      dependencies: [],
      status: 'pending',
      attempts: 0,
      attemptHistory: [],
      evidence: [],
      createdAt: 100,
      updatedAt: 100,
    }],
    createdAt: 100,
    updatedAt: 100,
  }
}

function canonicalRun(): {
  readonly first: RunSnapshot
  readonly execution: RunSnapshot
  readonly records: readonly RunAuditRecord[]
} {
  const first = snapshot()
  const interview = mutate(first, {
    flow: {
      revision: 2,
      stage: 'planning',
      cycle: 1,
      planReviewAttempts: 0,
      updatedAt: 101,
      interview: {
        summary: 'The objective is understood.',
        decisions: ['Use the durable plan.'],
        openQuestions: [],
        recordedAt: 101,
      },
    },
  })
  const planned = mutate(interview, { plan: plan() })
  const reviewing = mutate(planned, {
    flow: { ...interview.flow, revision: 3, stage: 'plan-review', updatedAt: planned.updatedAt + 1 },
  })
  const execution = mutate(reviewing, {
    flow: {
      ...reviewing.flow,
      revision: 4,
      stage: 'execution',
      updatedAt: reviewing.updatedAt + 1,
      planReview: {
        cycle: 1,
        planRevision: planned.plan!.revision,
        passed: true,
        reviewers: [
          { role: 'metis', verdict: 'advice', summary: 'requirements pass', findings: [], recommendations: [] },
          { role: 'momus', verdict: 'advice', summary: 'plan passes', findings: [], recommendations: [] },
          { role: 'oracle', verdict: 'advice', summary: 'architecture passes', findings: [], recommendations: [] },
        ],
        recordedAt: reviewing.updatedAt + 1,
      },
    },
  })
  return {
    first,
    execution,
    records: [
      record('start', first),
      record('flow', interview),
      record('plan', planned),
      record('flow', reviewing),
      record('flow', execution),
    ],
  }
}

async function openStore(root?: string): Promise<{
  readonly ctx: Context
  readonly root: string
  readonly store: DurableRunStore
}> {
  const storageRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-autopilot-store-'))
  roots.add(storageRoot)
  const { ctx } = await createStorageHarness(storageRoot)
  return { ctx, root: storageRoot, store: await DurableRunStore.open(ctx) }
}

describe('run audit folding', () => {
  it('rejects skipped, misattributed, and rewritten canonical flow mutations', () => {
    const { first, records } = canonicalRun()
    const interview = records[1]!.snapshot
    expect(() => foldRunAudit([
      record('start', first),
      record('plan', interview),
    ])).toThrow(/canonical flow interview->planning during plan/)
    expect(() => foldRunAudit([
      record('start', first),
      record('flow', {
        ...interview,
        flow: { ...interview.flow, revision: 3 },
      }),
    ])).toThrow(/non-monotonically/)
    expect(() => foldRunAudit([
      record('start', first),
      record('flow', interview),
      record('flow', mutate(interview, {
        flow: {
          ...interview.flow,
          revision: 3,
          stage: 'plan-review',
          interview: { ...interview.flow.interview!, summary: 'rewritten' },
        },
      })),
    ])).toThrow(/rewrote its canonical interview/)
    expect(() => foldRunAudit([
      record('start', first),
      record('pause', mutate(first, {
        flow: { ...first.flow, updatedAt: first.flow.updatedAt + 1 },
      })),
    ])).toThrow(/rewrote canonical flow without advancing/)
    expect(() => foldRunAudit([
      record('start', first),
      record('pause', interview),
    ])).toThrow(/changed canonical flow during pause/)
  })

  it('rejects terminal-only operations and disallowed phase transitions', () => {
    const first = snapshot()
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    const exhausted = mutate(paused, { phase: 'exhausted' })
    expect(() => foldRunAudit([
      record('start', first),
      record('pause', paused),
      record('expire', exhausted),
    ])).toThrow(/cannot transition paused to exhausted/)
  })

  it('sorts records and selects the latest generation per session', () => {
    const first = snapshot()
    const revoked = mutate(first, { phase: 'revoked' })
    const second = snapshot({
      sessionId: first.sessionId,
      runId: 'run-2',
      goalId: 'goal-2',
      generation: 2,
      grantedAt: 200,
      updatedAt: 200,
    })
    const other = snapshot({ sessionId: 'another-session', runId: 'other-run', goalId: 'other-goal' })
    const folded = foldRunAudit([
      record('start', second),
      record('revoke', revoked),
      record('start', other),
      record('start', first),
    ])

    expect(folded.current.get(first.sessionId)).toEqual(second)
    expect(folded.current.get(other.sessionId)).toEqual(other)
    expect(folded.history.map(item => [item.snapshot.sessionId, item.snapshot.generation, item.snapshot.revision])).toEqual([
      ['another-session', 1, 1],
      ['session-1', 1, 1],
      ['session-1', 1, 2],
      ['session-1', 2, 1],
    ])
    expect(Object.isFrozen(folded)).toBe(true)
    expect(Object.isFrozen(folded.history)).toBe(true)
    expect(foldRunAudit([]).current.size).toBe(0)
  })

  it.each([
    [[record('pause', snapshot())], /must begin with revision 1 and operation start/],
    [[record('start', snapshot({ revision: 2 }))], /must begin with revision 1 and operation start/],
    [[record('start', snapshot()), record('pause', snapshot({ revision: 3, updatedAt: 103 }))], /does not follow/],
    [[record('start', snapshot()), record('pause', snapshot({ revision: 2, generation: 2, updatedAt: 102 }))], /does not follow/],
    [[record('start', snapshot()), record('pause', snapshot({ revision: 2, goalId: 'changed', updatedAt: 102 }))], /changed immutable/],
    [[record('start', snapshot()), record('pause', snapshot({ revision: 2, grantedAt: 101, updatedAt: 102 }))], /changed immutable/],
    [[record('start', snapshot({ generation: 2 }))], /must begin at run generation 1/],
    [[
      record('start', snapshot()),
      record('revoke', snapshot({ revision: 2, phase: 'revoked', updatedAt: 102 })),
      record('start', snapshot({ runId: 'run-3', goalId: 'goal-3', generation: 3, grantedAt: 300, updatedAt: 300 })),
    ], /skipped run generation 2/],
    [[
      record('start', snapshot()),
      record('start', snapshot({ runId: 'run-2', goalId: 'goal-2', generation: 2, grantedAt: 200, updatedAt: 200 })),
    ], /before generation 1 became terminal/],
    [[
      record('start', snapshot({ runId: 'run-a' })),
      record('start', snapshot({ runId: 'run-b' })),
    ], /two run ids in generation 1/],
  ])('rejects corrupt audit history %#', (records, message) => {
    expect(() => foldRunAudit(records)).toThrow(message)
  })

  it('accepts completion as the other terminal phase before a new generation', () => {
    const { first, execution, records } = canonicalRun()
    const passing = {
      attempt: 1,
      startedAt: 100,
      finishedAt: 101,
      verdict: 'pass' as const,
      summary: 'verified',
      findings: [],
      checks: [],
      reviewers: [],
    }
    const verifying = mutate(execution, {
      phase: 'verifying',
      flow: { ...execution.flow, revision: 5, stage: 'code-review' },
      usage: { ...execution.usage, verificationAttempts: 1 },
      candidate: { summary: 'candidate', evidence: ['tests'], submittedAt: 101 },
    })
    const finalizing = mutate(verifying, {
      phase: 'finalizing',
      flow: { ...verifying.flow, revision: 6, stage: 'qa' },
      candidate: undefined,
      finalization: passing,
    })
    const completed = mutate(finalizing, {
      phase: 'completed',
      flow: { ...finalizing.flow, revision: 7, stage: 'completed' },
      finalization: undefined,
      verificationHistory: [passing],
    })
    const second = snapshot({
      runId: 'run-2',
      goalId: 'goal-2',
      generation: 2,
      grantedAt: 200,
      updatedAt: 200,
    })
    expect(foldRunAudit([
      ...records,
      record('verification-start', verifying),
      record('finalization-start', finalizing),
      record('finalization-complete', completed),
      record('start', second),
    ]).current.get(first.sessionId)).toEqual(second)
  })

  it('records bounded completion-delivery failures without reopening the completed run', () => {
    const { first, execution, records } = canonicalRun()
    const verifying = mutate(execution, {
      phase: 'verifying',
      flow: { ...execution.flow, revision: 5, stage: 'code-review' },
      usage: { ...execution.usage, verificationAttempts: 1 },
      candidate: { summary: 'candidate', evidence: ['tests'], submittedAt: 101 },
    })
    const finalizing = mutate(verifying, {
      phase: 'finalizing',
      flow: { ...verifying.flow, revision: 6, stage: 'qa' },
      candidate: undefined,
      finalization: verificationRecord(),
    })
    const completed = mutate(finalizing, {
      phase: 'completed',
      flow: { ...finalizing.flow, revision: 7, stage: 'completed' },
      finalization: undefined,
      verificationHistory: [verificationRecord()],
      completionDeliveryAttempts: 0,
      completionDeliveryExhausted: false,
    })
    const firstFailure = mutate(completed, {
      completionDeliveryAttempts: 1,
      reason: 'max-tokens',
    })
    const secondFailure = mutate(firstFailure, {
      completionDeliveryAttempts: 2,
      reason: 'aborted',
    })
    const exhausted = mutate(secondFailure, {
      completionDeliveryAttempts: MAX_COMPLETION_DELIVERY_ATTEMPTS,
      completionDeliveryExhausted: true,
      reason: 'no assistant report',
    })
    const notified = mutate(exhausted, { completionDeliveryExhaustionNotified: true })
    const prefix = [
      ...records,
      record('verification-start', verifying),
      record('finalization-start', finalizing),
      record('finalization-complete', completed),
    ] as const
    expect(foldRunAudit([
      ...prefix,
      record('completion-delivery-failed', firstFailure),
      record('completion-delivery-failed', secondFailure),
      record('completion-delivery-failed', exhausted),
      record('completion-delivery-exhaustion-notified', notified),
    ]).current.get(first.sessionId)).toEqual(notified)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-reported', mutate(completed, { completionDeliveryAttempts: 1 })),
    ])).toThrow(/changed completion delivery state outside/)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-delivery-failed', mutate(completed, { reason: 'did not increment' })),
    ])).toThrow(/invalid completion delivery failure/)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-delivery-failed', mutate(completed, { completionDeliveryAttempts: 1 })),
    ])).toThrow(/invalid completion delivery failure/)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-delivery-exhaustion-notified', mutate(completed, {
        completionDeliveryExhaustionNotified: true,
      })),
    ])).toThrow(/only an exhausted|invalid completion exhaustion notice/)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-delivery-failed', firstFailure),
      record('completion-delivery-failed', secondFailure),
      record('completion-delivery-failed', exhausted),
      record('completion-delivery-exhaustion-notified', mutate(exhausted, {})),
    ])).toThrow(/invalid completion exhaustion notice/)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-reported', mutate(completed, { completionDeliveryExhaustionNotified: true })),
    ])).toThrow(/only an exhausted|changed completion delivery state outside/)
    expect(() => foldRunAudit([
      ...prefix,
      record('pause', mutate(completed, { reason: 'late pause' })),
    ])).toThrow(/permits only completion delivery updates/)

    const reported = mutate(firstFailure, { completionReported: true, reason: undefined })
    expect(foldRunAudit([
      ...prefix,
      record('completion-delivery-failed', firstFailure),
      record('completion-reported', reported),
    ]).current.get(first.sessionId)).toEqual(reported)
    expect(() => foldRunAudit([
      ...prefix,
      record('completion-reported', mutate(completed, { completionReported: true })),
      record('completion-delivery-failed', mutate(
        mutate(completed, { completionReported: true }),
        { completionDeliveryAttempts: 1, reason: 'late failure' },
      )),
    ])).toThrow(/invalid completion delivery failure/)
  })

  it('rejects records that fail the durable zod schema before folding', () => {
    const invalid = record('start', { ...snapshot(), version: 99 as never })
    expect(() => foldRunAudit([invalid])).toThrow()
  })

  it.each([
    [snapshot({ remainingActiveMs: 1001 }), /remaining active time exceeds/],
    [snapshot({ expiresAt: 1101 }), /expiry exceeds/],
    [snapshot({ budgets: { ...snapshot().budgets, maxConcurrentSubagents: 33 } }), /concurrent subagent/],
    [snapshot({ usage: { verificationAttempts: 4, dynamicPackages: 0, subagentsStarted: 0 } }), /usage exceeds/],
    [snapshot({ usage: { verificationAttempts: 0, dynamicPackages: 9, subagentsStarted: 0 } }), /usage exceeds/],
    [snapshot({ usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 33 } }), /usage exceeds/],
  ])('rejects individually-invalid materialized limits %#', (invalid, message) => {
    expect(() => foldRunAudit([record('start', invalid)])).toThrow(message)
  })

  it('rejects every materialized durable-content ceiling before folding', () => {
    const basePlan = plan()
    const baseTask = basePlan.tasks[0]!
    const attempt = {
      attempt: 1,
      startedAt: 100,
      finishedAt: 101,
      outcome: 'completed' as const,
      evidence: [{ kind: 'test' as const, ref: 'pnpm test', summary: 'passed' }],
    }
    const evidence = { kind: 'file' as const, ref: 'artifact.txt', summary: 'created' }
    const invalid = [
      snapshot({
        budgets: { ...snapshot().budgets, maxTasks: 1 },
        plan: { ...basePlan, tasks: [baseTask, { ...baseTask, id: 'second' }] },
      }),
      snapshot({
        budgets: { ...snapshot().budgets, maxTaskAttempts: 1 },
        plan: { ...basePlan, tasks: [{ ...baseTask, attemptHistory: [attempt, { ...attempt, attempt: 2 }] }] },
      }),
      snapshot({
        budgets: { ...snapshot().budgets, maxEvidenceItems: 1 },
        plan: { ...basePlan, tasks: [{ ...baseTask, evidence: [evidence], attemptHistory: [attempt] }] },
      }),
      snapshot({
        budgets: { ...snapshot().budgets, maxDynamicSourceChars: 1 },
        dynamicExtensions: [dynamicExtension()],
      }),
      snapshot({ budgets: { ...snapshot().budgets, maxSnapshotBytes: 1 } }),
    ]
    const messages = [
      /task graph/,
      /task-attempt history/,
      /task evidence/,
      /dynamic Host source/,
      /snapshot bytes/,
    ]
    for (const [index, value] of invalid.entries()) {
      expect(() => foldRunAudit([record('start', value!)])).toThrow(messages[index])
    }

    const first = snapshot({ budgets: { ...snapshot().budgets, maxAuditRecords: 1 } })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    expect(() => foldRunAudit([record('start', first), record('pause', paused)]))
      .toThrow(/audit record count/)
  })

  it('rejects aggregate audit bytes across otherwise-valid revisions', () => {
    const limit = twoRecordAuditLimit()
    const first = snapshot({ budgets: { ...snapshot().budgets, maxAuditBytes: limit } })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    expect(() => foldRunAudit([record('start', first), record('pause', paused)]))
      .toThrow(/audit bytes/)
  })

  it.each([
    snapshot({ phase: 'paused', expiresAt: undefined }),
    snapshot({ usage: { verificationAttempts: 1, dynamicPackages: 0, subagentsStarted: 0 } }),
    snapshot({ usage: { verificationAttempts: 0, dynamicPackages: 1, subagentsStarted: 0 } }),
    snapshot({ usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 1 } }),
    snapshot({ dynamicExtensions: [dynamicExtension()] }),
    snapshot({ verificationHistory: [verificationRecord()] }),
    snapshot({ plan: plan() }),
    snapshot({ candidate: { summary: 'candidate', evidence: ['test'], submittedAt: 100 } }),
    snapshot({ verificationPolicy: verificationPolicy() }),
    snapshot({ verificationBaseline: verificationBaseline() }),
    snapshot({ reason: 'tampered' }),
  ])('rejects a tampered initial authorization snapshot %#', invalid => {
    expect(() => foldRunAudit([record('start', invalid)])).toThrow(/invalid initial authorization/)
  })

  it.each([
    ['goalId', 'other-goal'],
    ['grantedAt', 101],
  ] as const)('rejects each rewritten immutable run identity field %#', (field, value) => {
    const first = snapshot()
    const next = mutate(first, {
      [field]: value,
      ...(field === 'grantedAt' ? { flow: { ...first.flow, updatedAt: value as number } } : {}),
    } as Partial<RunSnapshot>)
    expect(() => foldRunAudit([record('start', first), record('plan', next)]))
      .toThrow(/changed immutable identity/)
  })

  it.each([
    { autoResume: false },
    { selfModification: 'off' as const },
    { budgets: { ...snapshot().budgets, maxSubagents: 31 } },
  ])('rejects each rewritten authorization policy field %#', overrides => {
    const first = snapshot()
    expect(() => foldRunAudit([
      record('start', first),
      record('plan', mutate(first, overrides)),
    ])).toThrow(/immutable authorization policy/)
  })

  it('rejects tampered timing, baseline, usage, and lifecycle revisions', () => {
    const first = snapshot()
    const baseline = mutate(first, { verificationBaseline: verificationBaseline() })
    expect(() => foldRunAudit([
      record('start', first),
      record('verification-baseline', baseline),
      record('plan', mutate(baseline, {
        verificationBaseline: { ...verificationBaseline(), frozenAt: 101 },
      })),
    ])).toThrow(/rewrote its frozen verification baseline/)
    expect(() => foldRunAudit([
      record('start', first),
      record('plan', mutate(first, { updatedAt: 99, expiresAt: 1099 })),
    ])).toThrow(/updatedAt backwards/)
    expect(() => foldRunAudit([
      record('start', first),
      record('plan', mutate(first, { maxActiveMs: 999, remainingActiveMs: 999, expiresAt: 1099 })),
    ])).toThrow(/maxActiveMs/)
    expect(() => foldRunAudit([
      record('start', first),
      record('plan', mutate(first, { maxActiveMs: 1001 })),
    ])).toThrow(/maxActiveMs/)
    const shorter = snapshot({ remainingActiveMs: 900, expiresAt: 1000 })
    expect(() => foldRunAudit([
      record('start', shorter),
      record('plan', mutate(shorter, { remainingActiveMs: 950, expiresAt: 1051 })),
    ])).toThrow(/increased remaining active time/)
    expect(() => foldRunAudit([
      record('start', shorter),
      record('resume', mutate(shorter, {
        maxActiveMs: 1100,
        remainingActiveMs: 1051,
        expiresAt: 1152,
      })),
    ])).toThrow(/increased remaining active time/)

    const canonical = canonicalRun()
    const verifying = mutate(canonical.execution, {
      phase: 'verifying',
      flow: { ...canonical.execution.flow, revision: 5, stage: 'code-review' },
      usage: { verificationAttempts: 1, dynamicPackages: 0, subagentsStarted: 0 },
      candidate: { summary: 'candidate', evidence: ['test'], submittedAt: 101 },
    })
    expect(() => foldRunAudit([
      ...canonical.records,
      record('verification-start', verifying),
      record('verification-fail', mutate(verifying, {
        phase: 'running',
        candidate: undefined,
        usage: { verificationAttempts: 0, dynamicPackages: 0, subagentsStarted: 0 },
      })),
    ])).toThrow(/usage verificationAttempts decreased/)

    const finalizing = mutate(verifying, {
      phase: 'finalizing',
      flow: { ...verifying.flow, revision: 6, stage: 'qa' },
      candidate: undefined,
      finalization: verificationRecord(),
    })
    const completed = mutate(finalizing, {
      phase: 'completed',
      flow: { ...finalizing.flow, revision: 7, stage: 'completed' },
      finalization: undefined,
      verificationHistory: [verificationRecord()],
    })
    expect(() => foldRunAudit([
      ...canonical.records,
      record('verification-start', verifying),
      record('finalization-start', finalizing),
      record('finalization-complete', completed),
      record('completion-reported', mutate(completed, { verificationHistory: [] })),
    ])).toThrow(/rewrote verification history/)
    const reported = mutate(completed, { completionReported: true })
    expect(() => foldRunAudit([
      ...canonical.records,
      record('verification-start', verifying),
      record('finalization-start', finalizing),
      record('finalization-complete', completed),
      record('completion-reported', reported),
      record('completion-reported', mutate(reported, { completionReported: false })),
    ])).toThrow(/cleared its completion acknowledgement/)
  })

  it('rejects non-monotonic terminal and operation transitions', () => {
    const first = snapshot()
    const revoked = mutate(first, { phase: 'revoked', expiresAt: undefined })
    expect(() => foldRunAudit([
      record('start', first),
      record('revoke', revoked),
      record('revoke', mutate(revoked)),
    ])).toThrow(/revoked run/)

    const canonical = canonicalRun()
    const verifying = mutate(canonical.execution, {
      phase: 'verifying',
      flow: { ...canonical.execution.flow, revision: 5, stage: 'code-review' },
      usage: { verificationAttempts: 1, dynamicPackages: 0, subagentsStarted: 0 },
      candidate: { summary: 'candidate', evidence: ['test'], submittedAt: 101 },
    })
    const finalizing = mutate(verifying, {
      phase: 'finalizing',
      flow: { ...verifying.flow, revision: 6, stage: 'qa' },
      candidate: undefined,
      finalization: verificationRecord(),
    })
    const completed = mutate(finalizing, {
      phase: 'completed',
      flow: { ...finalizing.flow, revision: 7, stage: 'completed' },
      finalization: undefined,
      verificationHistory: [verificationRecord()],
    })
    expect(() => foldRunAudit([
      ...canonical.records,
      record('verification-start', verifying),
      record('finalization-start', finalizing),
      record('finalization-complete', completed),
      record('plan', mutate(completed, { phase: 'running' })),
    ])).toThrow(/completed run/)
    expect(() => foldRunAudit([
      ...canonical.records,
      record('finalization-start', mutate(canonical.execution, {
        phase: 'finalizing',
        flow: { ...canonical.execution.flow, revision: 5, stage: 'qa' },
        finalization: verificationRecord(),
      })),
    ])).toThrow(/canonical flow execution->qa/)
    expect(() => foldRunAudit([
      record('start', first),
      record('pause', mutate(first)),
    ])).toThrow(/operation pause/)
  })

  it('exposes stable storage error identity', () => {
    expect(new RunStoreError('corrupt')).toMatchObject({
      name: 'RunStoreError',
      code: 'AUTOPILOT_RUN_STORE_INVALID',
      message: 'corrupt',
    })
  })
})

describe('DurableRunStore', () => {
  it('permits one policy materialization and rejects replacement, removal, or empty policy operations', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    const policy = verificationPolicy()
    const frozen = mutate(first, { verificationPolicy: policy })
    await store.append('start', first)
    await expect(store.append('plan', frozen)).rejects.toThrow(/immutable verification policy/)
    await expect(store.append('verification-policy', frozen)).resolves.toEqual(frozen)
    await expect(store.append('verification-policy', mutate(frozen)))
      .rejects.toThrow(/did not materialize/)
    await expect(store.append('plan', mutate(frozen, {
      verificationPolicy: { ...policy, minimumEvidenceItems: 0 },
    }))).rejects.toThrow(/immutable verification policy/)
    await expect(store.append('plan', mutate(frozen, { verificationPolicy: undefined })))
      .rejects.toThrow(/immutable verification policy/)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('persists, reopens, filters immutable history, and encodes stable keys', async () => {
    const firstHarness = await openStore()
    const first = snapshot({ sessionId: '会话.with.dot', runId: 'run/one' })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined, remainingActiveMs: 900 })
    await firstHarness.store.append('start', first)
    await firstHarness.store.append('pause', paused)
    expect(firstHarness.store.get(first.sessionId)).toEqual(paused)
    expect(firstHarness.store.get('missing')).toBeUndefined()
    expect(firstHarness.store.history(first.sessionId)).toHaveLength(2)
    expect(firstHarness.store.history('missing')).toEqual([])
    expect(Object.isFrozen(firstHarness.store.history())).toBe(true)
    expect(firstHarness.store.currentRuns()).toEqual([paused])
    expect(Object.isFrozen(firstHarness.store.currentRuns())).toBe(true)
    expect(runAuditKey(first)).toMatch(/^[A-Za-z0-9_-]+\.000000000001\.[A-Za-z0-9_-]+\.000000000001$/u)
    await firstHarness.store.close()
    await firstHarness.ctx.fiber.dispose()

    const reopened = await openStore(firstHarness.root)
    expect(reopened.store.get(first.sessionId)).toEqual(paused)
    expect(reopened.store.history().map(item => item.operation)).toEqual(['start', 'pause'])
    await reopened.store.close()
    await reopened.ctx.fiber.dispose()
  })

  it('lists current runs in stable order and persists needs-attention as nonterminal', async () => {
    const { ctx, store } = await openStore()
    const later = snapshot({ sessionId: 'z-session', runId: 'z-run', goalId: 'z-goal' })
    const earlier = snapshot({ sessionId: 'a-session', runId: 'a-run', goalId: 'a-goal' })
    await store.append('start', later)
    await store.append('start', earlier)
    const attention = mutate(later, {
      phase: 'needs-attention',
      expiresAt: undefined,
      reason: 'reconcile durable sources',
    })
    await store.append('needs-attention', attention)

    expect(store.currentRuns().map(item => [item.sessionId, item.phase])).toEqual([
      ['a-session', 'running'],
      ['z-session', 'needs-attention'],
    ])
    await expect(store.append('start', snapshot({
      sessionId: later.sessionId,
      runId: 'replacement',
      goalId: 'replacement-goal',
      generation: 2,
    }))).rejects.toThrow(/needs-attention/)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('rejects stale, skipped, duplicate, and identity-changing appends', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    await expect(store.append('pause', mutate(first))).rejects.toThrow(/before start/)
    await expect(store.append('start', snapshot({ revision: 2 }))).rejects.toThrow(/revision 1/)
    await expect(store.append('start', snapshot({ generation: 2 }))).rejects.toThrow(/must be 1/)
    await store.append('start', first)
    await expect(store.append('start', snapshot({ runId: 'run-2', goalId: 'goal-2', generation: 2 })))
      .rejects.toThrow(/while generation 1 is running/)
    await expect(store.append('pause', mutate(first, { runId: 'stale' }))).rejects.toThrow(/stale run identity/)
    await expect(store.append('pause', mutate(first, { generation: 2 }))).rejects.toThrow(/stale run identity/)
    await expect(store.append('pause', mutate(first, { revision: 3 }))).rejects.toThrow(/revision 3 must follow 1/)
    await expect(store.append('pause', mutate(first, { goalId: 'changed' }))).rejects.toThrow(/immutable/)
    await expect(store.append('pause', mutate(first, {
      grantedAt: 101,
      flow: { ...first.flow, updatedAt: 101 },
    }))).rejects.toThrow(/immutable/)
    await expect(store.append('pause', { ...mutate(first), remainingActiveMs: -1 })).rejects.toThrow()

    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    const duplicateKey = runAuditKey(paused)
    const table = (store as unknown as {
      table: { put(key: string, value: RunAuditRecord): Promise<void> }
    }).table
    await table.put(duplicateKey, record('pause', paused))
    await expect(store.append('pause', paused)).rejects.toThrow(/already exists/)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('permits a new generation only after a terminal current run', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    const revoked = mutate(first, { phase: 'revoked', expiresAt: undefined })
    await store.append('start', first)
    await store.append('revoke', revoked)
    const second = snapshot({
      runId: 'run-2',
      goalId: 'goal-2',
      generation: 2,
      grantedAt: 200,
      updatedAt: 200,
    })
    await expect(store.append('start', second)).resolves.toEqual(second)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('serializes compare-and-set mutations so only one revision wins', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    await store.append('start', first)
    const left = mutate(first, { phase: 'paused', reason: 'left' })
    const right = mutate(first, { phase: 'paused', reason: 'right' })
    const results = await Promise.allSettled([
      store.append('pause', left),
      store.append('pause', right),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(store.history()).toHaveLength(2)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('accounts aggregate audit bytes only after a durable put succeeds', async () => {
    const { ctx, store } = await openStore()
    const limit = threeRecordAuditLimit()
    const first = snapshot({ budgets: { ...snapshot().budgets, maxAuditBytes: limit } })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    await store.append('start', first)
    const table = (store as unknown as {
      table: { put(key: string, value: RunAuditRecord): Promise<void> }
    }).table
    const put = vi.spyOn(table, 'put').mockRejectedValueOnce(new Error('durable write rejected'))
    await expect(store.append('pause', paused)).rejects.toThrow('durable write rejected')
    await expect(store.append('pause', paused)).resolves.toEqual(paused)
    expect(put).toHaveBeenCalledTimes(2)
    expect(store.history()).toHaveLength(2)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('rejects an append that would exceed the aggregate audit-byte budget', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot({
      budgets: { ...snapshot().budgets, maxAuditBytes: twoRecordAuditLimit() },
    })
    const paused = mutate(first, { phase: 'paused', expiresAt: undefined })
    await store.append('start', first)
    await expect(store.append('pause', paused)).rejects.toThrow(/audit bytes/)
    expect(store.history()).toHaveLength(1)
    await store.close()
    await ctx.fiber.dispose()
  })

  it('returns an explicit compare-and-set miss without appending', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    const next = mutate(first, { reason: 'baseline frozen' })
    await expect(store.appendIfCurrent('verification-baseline', first, next)).resolves.toBeUndefined()
    await store.append('start', first)
    for (const expected of [
      { ...first, sessionId: 'missing' },
      { ...first, runId: 'other' },
      { ...first, generation: 2 },
      { ...first, revision: 2 },
    ]) {
      await expect(store.appendIfCurrent('verification-baseline', expected, next)).resolves.toBeUndefined()
    }
    await expect(store.appendIfCurrent('verification-baseline', first, {
      ...next,
      remainingActiveMs: -1,
    })).rejects.toThrow()
    await expect(store.appendIfCurrent('verification-baseline', first, next)).resolves.toEqual(next)
    expect(store.history().map(record => record.operation)).toEqual(['start', 'verification-baseline'])
    await store.close()
    await ctx.fiber.dispose()
  })

  it('reduces the serialized current snapshot or deliberately makes no change', async () => {
    const { ctx, store } = await openStore()
    const first = snapshot()
    await expect(store.reduceCurrent('missing', current => {
      expect(current).toBeUndefined()
      return undefined
    })).resolves.toBeUndefined()
    await store.append('start', first)
    await expect(store.reduceCurrent(first.sessionId, current => {
      expect(current).toEqual(first)
      return { operation: 'pause', snapshot: mutate(current!, { phase: 'paused', expiresAt: undefined }) }
    })).resolves.toMatchObject({ phase: 'paused', revision: 2 })
    await expect(store.reduceCurrent(first.sessionId, () => {
      throw new Error('reducer failure')
    })).rejects.toThrow('reducer failure')
    expect(store.history().map(item => item.operation)).toEqual(['start', 'pause'])
    await store.close()
    await ctx.fiber.dispose()
  })

  it('closes an opened domain when rebuilding stored history fails', async () => {
    const close = vi.fn(async () => {})
    const invalid = record('pause', snapshot())
    const ctx = {
      storageDomain: {
        open: vi.fn(async () => ({
          table: () => ({ entries: () => [['bad', invalid]] }),
          close,
        })),
      },
    } as unknown as Context
    await expect(DurableRunStore.open(ctx)).rejects.toThrow(/must begin/)
    expect(close).toHaveBeenCalledOnce()
  })
})
