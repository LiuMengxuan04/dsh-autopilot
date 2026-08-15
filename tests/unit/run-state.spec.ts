import { describe, expect, it } from 'vitest'
import {
  addRunTasks,
  autopilotFlowSchema,
  createRunPlan,
  interruptRunTasks,
  isRunPlanComplete,
  readyRunTasks,
  reorderRunTasks,
  replaceRunPlan,
  MAX_COMPLETION_DELIVERY_ATTEMPTS,
  RUN_STATE_VERSION,
  runAuditRecordSchema,
  runEvidenceSchema,
  runPlanSchema,
  runSnapshotSchema,
  RunStateError,
  updateRunTask,
  validateTaskGraph,
  VERIFICATION_POLICY_VERSION,
} from '../../src/run-state.ts'
import type {
  PlannedTaskInput,
  RunEvidence,
  RunPlan,
  RunTask,
} from '../../src/run-state.ts'

const evidence: RunEvidence = Object.freeze({
  kind: 'test',
  ref: 'pnpm test',
  summary: 'all focused tests passed',
})

function planned(id: string, dependencies: readonly string[] = []): PlannedTaskInput {
  return {
    id,
    title: ` ${id} title `,
    description: ` ${id} description `,
    acceptanceCriteria: [` ${id} accepted `],
    dependencies,
  }
}

function byId(plan: RunPlan, id: string): RunTask {
  const task = plan.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new Error(`missing fixture task ${id}`)
  return task
}

function canonicalFlow(
  stage: 'interview' | 'planning' | 'plan-review' | 'execution' | 'code-review' | 'qa' | 'completed',
  updatedAt = 20,
  planRevision = 1,
) {
  const interview = {
    summary: 'The objective is understood.',
    decisions: ['Use the durable plan.'],
    openQuestions: [],
    recordedAt: 10,
  }
  if (stage === 'interview') return { revision: 1, stage, cycle: 1, planReviewAttempts: 0, updatedAt }
  if (stage === 'planning' || stage === 'plan-review') {
    return { revision: 2, stage, cycle: 1, planReviewAttempts: 0, updatedAt, interview }
  }
  return {
    revision: 4,
    stage,
    cycle: 1,
    planReviewAttempts: 1,
    updatedAt,
    interview,
    planReview: {
      cycle: 1,
      planRevision,
      passed: true,
      reviewers: [
        { role: 'metis' as const, verdict: 'advice' as const, summary: 'requirements pass', findings: [], recommendations: [] },
        { role: 'momus' as const, verdict: 'advice' as const, summary: 'plan passes', findings: [], recommendations: [] },
        { role: 'oracle' as const, verdict: 'advice' as const, summary: 'architecture passes', findings: [], recommendations: [] },
      ],
      recordedAt: 20,
    },
  }
}

describe('run task graph construction', () => {
  it('normalizes and detaches an initial DAG with stable ready-task order', () => {
    const criteria = [' complete the feature ']
    const dependencies = ['prepare']
    const plan = createRunPlan(criteria, [
      {
        id: 'prepare',
        title: ' prepare title ',
        description: ' prepare description ',
        acceptanceCriteria: [' prepare accepted '],
      },
      planned('verify', dependencies),
    ], 100, 'investigation')
    criteria[0] = 'mutated'
    dependencies[0] = 'mutated'

    expect(plan).toMatchObject({
      revision: 1,
      intent: 'investigation',
      acceptanceCriteria: ['complete the feature'],
      createdAt: 100,
      updatedAt: 100,
    })
    expect(plan.tasks).toEqual([
      expect.objectContaining({
        id: 'prepare',
        title: 'prepare title',
        description: 'prepare description',
        acceptanceCriteria: ['prepare accepted'],
        dependencies: [],
        status: 'pending',
        attempts: 0,
        attemptHistory: [],
        evidence: [],
      }),
      expect.objectContaining({ id: 'verify', dependencies: ['prepare'] }),
    ])
    expect(readyRunTasks(plan).map(task => task.id)).toEqual(['prepare'])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.tasks)).toBe(true)
    expect(runPlanSchema.parse(plan)).toEqual(plan)
  })

  it.each([
    [[], [planned('one')], /plan acceptance criteria/],
    [['ok'], [], /at least one task/],
    [[''], [planned('one')], /plan acceptance criteria/],
    [['ok'], [{ ...planned('one'), acceptanceCriteria: [' '] }], /task one acceptance criteria/],
  ])('rejects incomplete plan input %#', (criteria, tasks, message) => {
    expect(() => createRunPlan(criteria, tasks, 1)).toThrow(message)
  })

  it('replaces only an unstarted plan and preserves its creation time', () => {
    const initial = createRunPlan(['old'], [planned('old')], 10)
    const replacement = replaceRunPlan(initial, ['new'], [planned('new')], 20, 'delivery')
    expect(replacement).toMatchObject({ revision: 2, intent: 'delivery', createdAt: 10, updatedAt: 20 })
    expect(replacement.tasks.map(task => task.id)).toEqual(['new'])
    expect(replaceRunPlan(undefined, ['first'], [planned('first')], 30)).toMatchObject({
      revision: 1,
      intent: 'implementation',
    })

    const started = updateRunTask(initial, 'old', 'start', 11)
    expect(() => replaceRunPlan(started, ['no'], [planned('replacement')], 12)).toThrow(
      expect.objectContaining({ code: 'RUN_PLAN_LOCKED' }),
    )
  })

  it('adds tasks that may depend on existing tasks and rejects empty or duplicate additions', () => {
    const initial = createRunPlan(['done'], [planned('build')], 10)
    const added = addRunTasks(initial, [
      planned('test', ['build']),
      {
        id: 'docs',
        title: 'docs title',
        description: 'docs description',
        acceptanceCriteria: ['docs accepted'],
      },
    ], 20)
    expect(added).toMatchObject({ revision: 2, createdAt: 10, updatedAt: 20 })
    expect(added.tasks.map(task => task.id)).toEqual(['build', 'test', 'docs'])
    expect(() => addRunTasks(initial, [], 20)).toThrow(expect.objectContaining({ code: 'RUN_PLAN_INVALID' }))
    expect(() => addRunTasks(initial, [planned('build')], 20)).toThrow(/duplicated/)
  })

  it('reorders the complete set without changing task objects', () => {
    const plan = createRunPlan(['done'], [planned('a'), planned('b')], 1)
    const reordered = reorderRunTasks(plan, ['b', 'a'], 2)
    expect(reordered).toMatchObject({ revision: 2, updatedAt: 2 })
    expect(reordered.tasks).toEqual([plan.tasks[1], plan.tasks[0]])
    expect(() => reorderRunTasks(plan, ['a'], 3)).toThrow(/every task id exactly once/)
    expect(() => reorderRunTasks(plan, ['a', 'a'], 3)).toThrow(/every task id exactly once/)
    expect(() => reorderRunTasks(plan, ['a', 'unknown'], 3)).toThrow(/every task id exactly once/)
  })
})

describe('durable run schema', () => {
  it('validates the canonical flow artifacts, fixed reviewer order, and cycle accounting', () => {
    const passing = canonicalFlow('execution')
    expect(autopilotFlowSchema.parse(passing)).toEqual(passing)
    expect(() => autopilotFlowSchema.parse({
      ...passing,
      planReview: {
        ...passing.planReview,
        reviewers: [
          passing.planReview!.reviewers[1],
          passing.planReview!.reviewers[0],
          passing.planReview!.reviewers[2],
        ],
      },
    })).toThrow(/ordered metis, momus, oracle/)
    expect(() => autopilotFlowSchema.parse({
      ...passing,
      planReview: { ...passing.planReview, passed: false },
    })).toThrow(/pass must match/)
    expect(() => autopilotFlowSchema.parse({
      ...passing,
      cycle: 2,
    })).toThrow(/active canonical cycle/)
    expect(() => autopilotFlowSchema.parse({
      ...canonicalFlow('planning'),
      cycle: 1,
      planReview: {
        ...passing.planReview,
        cycle: 2,
        passed: false,
        reviewers: passing.planReview!.reviewers.map(reviewer => ({
          ...reviewer,
          verdict: reviewer.role === 'momus' ? 'concern' as const : reviewer.verdict,
        })),
      },
    })).toThrow(/cannot follow the canonical cycle/)
    expect(() => autopilotFlowSchema.parse({
      ...passing,
      updatedAt: 19,
    })).toThrow(/recorded after/)
    expect(() => autopilotFlowSchema.parse({
      ...canonicalFlow('planning'),
      updatedAt: 9,
    })).toThrow(/interview cannot be recorded after/u)
    expect(() => autopilotFlowSchema.parse({
      revision: 1,
      stage: 'execution',
      cycle: 1,
      planReviewAttempts: 0,
      updatedAt: 20,
    })).toThrow(/interview artifact|passing plan-review/)
  })

  it('requires explicit recovery authorization and accepts the fail-closed phase', () => {
    const snapshot = {
      version: RUN_STATE_VERSION,
      runId: 'run-1',
      generation: 1,
      revision: 2,
      sessionId: 'session-1',
      goalId: 'goal-1',
      phase: 'needs-attention' as const,
      autoResume: true,
      grantedAt: 10,
      updatedAt: 20,
      remainingActiveMs: 100,
      maxActiveMs: 100,
      selfModification: 'host-only' as const,
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
      flow: canonicalFlow('interview'),
      verificationHistory: [],
      completionReported: false,
      reason: 'reconcile this run',
    }
    expect(runSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    const exhaustedReview = {
      ...snapshot,
      flow: {
        ...canonicalFlow('planning'),
        planReviewAttempts: 5,
        planReview: {
          ...canonicalFlow('execution').planReview!,
          passed: false,
          reviewers: canonicalFlow('execution').planReview!.reviewers.map(reviewer => ({
            ...reviewer,
            verdict: reviewer.role === 'momus' ? 'concern' as const : reviewer.verdict,
          })),
        },
      },
    }
    expect(runSnapshotSchema.parse(exhaustedReview)).toEqual(exhaustedReview)
    expect(() => runSnapshotSchema.parse({ ...exhaustedReview, phase: 'running' })).toThrow(/human attention/)
    expect(runAuditRecordSchema.parse({
      version: RUN_STATE_VERSION,
      operation: 'needs-attention',
      time: snapshot.updatedAt,
      snapshot,
    })).toMatchObject({ operation: 'needs-attention', snapshot })
    expect(() => runSnapshotSchema.parse({ ...snapshot, autoResume: undefined })).toThrow()
    expect(() => runSnapshotSchema.parse({ ...snapshot, flow: undefined })).toThrow()
    expect(() => runSnapshotSchema.parse({ ...snapshot, version: RUN_STATE_VERSION - 1 })).toThrow()
  })

  it('requires a passing reservation for finalizing and confines delivery acknowledgement to completion', () => {
    const pass = {
      attempt: 1,
      startedAt: 10,
      finishedAt: 20,
      verdict: 'pass' as const,
      summary: 'verified',
      findings: [],
      checks: [{ name: 'tests', passed: true, summary: 'passed' }],
      reviewers: [],
    }
    const base = {
      version: RUN_STATE_VERSION,
      runId: 'run-1',
      generation: 1,
      revision: 2,
      sessionId: 'session-1',
      goalId: 'goal-1',
      phase: 'finalizing' as const,
      autoResume: true,
      grantedAt: 10,
      updatedAt: 20,
      remainingActiveMs: 100,
      maxActiveMs: 100,
      selfModification: 'host-only' as const,
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
      usage: { verificationAttempts: 1, dynamicPackages: 0, subagentsStarted: 0 },
      dynamicExtensions: [],
      flow: canonicalFlow('qa'),
      plan: createRunPlan(['verified'], [planned('work')], 10),
      finalization: pass,
      verificationHistory: [],
      completionReported: false,
    }
    expect(runSnapshotSchema.parse(base)).toEqual(base)
    expect(() => runSnapshotSchema.parse({
      ...base,
      flow: canonicalFlow('qa', 9),
    })).toThrow(/cannot precede run authorization/u)
    expect(() => runSnapshotSchema.parse({
      ...base,
      flow: canonicalFlow('execution'),
    })).toThrow(/finalizing run requires canonical QA/u)
    expect(() => runSnapshotSchema.parse({
      ...base,
      phase: 'verifying',
      flow: canonicalFlow('planning'),
      finalization: undefined,
    })).toThrow(/verifying run requires canonical code review or QA/u)
    expect(() => runSnapshotSchema.parse({
      ...base,
      phase: 'verifying',
      flow: canonicalFlow('code-review', 20, 2),
      finalization: undefined,
    })).toThrow(/must descend from the reviewed plan revision/u)
    expect(() => runSnapshotSchema.parse({ ...base, finalization: undefined })).toThrow(/passing/)
    expect(() => runSnapshotSchema.parse({
      ...base,
      finalization: { ...pass, verdict: 'fail' },
    })).toThrow(/passing/)
    expect(() => runSnapshotSchema.parse({ ...base, phase: 'running' })).toThrow(/only finalizing/)
    expect(() => runSnapshotSchema.parse({
      ...base,
      phase: 'running',
      finalization: undefined,
      completionReported: true,
    })).toThrow(/only completed/)
    expect(runSnapshotSchema.parse({
      ...base,
      phase: 'completed',
      flow: canonicalFlow('completed'),
      finalization: undefined,
      verificationHistory: [pass],
      completionReported: true,
    })).toMatchObject({ phase: 'completed', completionReported: true })
    const exhausted = {
      ...base,
      phase: 'completed' as const,
      flow: canonicalFlow('completed'),
      finalization: undefined,
      verificationHistory: [pass],
      completionDeliveryAttempts: MAX_COMPLETION_DELIVERY_ATTEMPTS,
      completionDeliveryExhausted: true,
      reason: 'final report retry ceiling reached',
    }
    expect(runAuditRecordSchema.parse({
      version: RUN_STATE_VERSION,
      operation: 'completion-delivery-failed',
      time: exhausted.updatedAt,
      snapshot: exhausted,
    })).toMatchObject({ operation: 'completion-delivery-failed', snapshot: exhausted })
    const notified = { ...exhausted, completionDeliveryExhaustionNotified: true }
    expect(runAuditRecordSchema.parse({
      version: RUN_STATE_VERSION,
      operation: 'completion-delivery-exhaustion-notified',
      time: notified.updatedAt,
      snapshot: notified,
    })).toMatchObject({ operation: 'completion-delivery-exhaustion-notified', snapshot: notified })
    expect(() => runSnapshotSchema.parse({
      ...base,
      completionDeliveryAttempts: 1,
    })).toThrow(/only completed/)
    expect(() => runSnapshotSchema.parse({
      ...exhausted,
      completionDeliveryExhausted: false,
    })).toThrow(/exhaustion must match/)
    expect(() => runSnapshotSchema.parse({
      ...exhausted,
      completionDeliveryAttempts: MAX_COMPLETION_DELIVERY_ATTEMPTS + 1,
    })).toThrow()
    expect(() => runSnapshotSchema.parse({
      ...exhausted,
      completionReported: true,
    })).toThrow(/cannot be reported/)
    expect(() => runSnapshotSchema.parse({
      ...base,
      phase: 'completed',
      flow: canonicalFlow('completed'),
      finalization: undefined,
      verificationHistory: [pass],
      completionDeliveryExhaustionNotified: true,
    })).toThrow(/only an exhausted/)
  })

  it('persists project and reviewer-only verification baselines in the versioned snapshot', () => {
    const base = {
      version: RUN_STATE_VERSION,
      runId: 'run-baseline',
      generation: 1,
      revision: 2,
      sessionId: 'session-baseline',
      goalId: 'goal-baseline',
      phase: 'running' as const,
      autoResume: false,
      grantedAt: 10,
      updatedAt: 20,
      remainingActiveMs: 100,
      maxActiveMs: 100,
      selfModification: 'off' as const,
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
      flow: canonicalFlow('interview'),
      verificationHistory: [],
      completionReported: false,
    }
    const project = {
      kind: 'project' as const,
      workspace: '/workspace',
      frozenAt: 15,
      manifests: [{ name: 'package.json' as const, sha256: 'a'.repeat(64) }],
      checks: [{
        id: 'js:test' as const,
        label: 'JavaScript tests',
        cwd: '/workspace',
        argv: ['npm', 'run', 'test'],
        command: 'npm run test',
        manifest: 'package.json' as const,
      }],
    }
    expect(runAuditRecordSchema.parse({
      version: RUN_STATE_VERSION,
      operation: 'verification-baseline',
      time: base.updatedAt,
      snapshot: { ...base, verificationBaseline: project },
    })).toMatchObject({ operation: 'verification-baseline' })
    expect(runSnapshotSchema.parse({
      ...base,
      verificationBaseline: {
        kind: 'reviewer-only',
        frozenAt: 15,
        manifests: [],
        checks: [],
        reason: 'no-supported-project',
      },
    })).toMatchObject({ verificationBaseline: { kind: 'reviewer-only' } })
    expect(() => runSnapshotSchema.parse({
      ...base,
      verificationBaseline: { ...project, manifests: [{ ...project.manifests[0], sha256: 'bad' }] },
    })).toThrow()
    expect(() => runSnapshotSchema.parse({
      ...base,
      verificationBaseline: {
        kind: 'reviewer-only',
        frozenAt: 15,
        manifests: [],
        checks: project.checks,
        reason: 'no-supported-project',
      },
    })).toThrow()

    const parseProject = (verificationBaseline: unknown) => runSnapshotSchema.parse({
      ...base,
      verificationBaseline,
    })
    expect(parseProject({
      kind: 'project',
      workspace: '/workspace',
      frozenAt: 15,
      manifests: [{ name: 'pyproject.toml', sha256: 'b'.repeat(64) }],
      checks: [{
        id: 'python:pytest',
        label: 'Python tests',
        cwd: '/workspace',
        argv: ['python', '-m', 'pytest'],
        command: 'python -m pytest',
        manifest: 'pyproject.toml',
      }],
    })).toMatchObject({ verificationBaseline: { kind: 'project' } })
    expect(() => parseProject({
      ...project,
      manifests: [...project.manifests, ...project.manifests],
    })).toThrow(/manifests must be unique/)
    expect(() => parseProject({
      ...project,
      checks: [...project.checks, ...project.checks],
    })).toThrow(/checks must be unique/)
    expect(() => parseProject({
      ...project,
      checks: [{ ...project.checks[0], argv: ['other', 'run', 'test'], command: 'other run test' }],
    })).toThrow(/invalid runner/)
    expect(() => parseProject({
      ...project,
      checks: [{ ...project.checks[0], manifest: 'go.mod' }],
    })).toThrow(/no matching manifest/)
    expect(() => parseProject({
      ...project,
      manifests: [{ name: 'go.mod', sha256: 'a'.repeat(64) }],
    })).toThrow(/no matching manifest/)
    expect(() => parseProject({
      ...project,
      checks: [{ ...project.checks[0], cwd: '/other' }],
    })).toThrow(/changed workspace/)
    expect(() => parseProject({
      ...project,
      checks: [{ ...project.checks[0], argv: ['npm', 'run'], command: 'npm run' }],
    })).toThrow(/changed its finite recipe/)
    expect(() => parseProject({
      ...project,
      checks: [{ ...project.checks[0], argv: ['npm', 'run', 'build'], command: 'npm run build' }],
    })).toThrow(/changed its finite recipe/)
    expect(() => parseProject({
      ...project,
      checks: [{ ...project.checks[0], command: 'npm run build' }],
    })).toThrow(/changed its finite recipe/)
  })

  it('validates a credential-free completion policy and rejects ambiguous lanes', () => {
    const base = {
      version: RUN_STATE_VERSION,
      runId: 'run-policy',
      generation: 1,
      revision: 2,
      sessionId: 'session-policy',
      goalId: 'goal-policy',
      phase: 'running' as const,
      autoResume: true,
      grantedAt: 10,
      updatedAt: 20,
      remainingActiveMs: 100,
      maxActiveMs: 100,
      selfModification: 'off' as const,
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
      flow: canonicalFlow('interview'),
      verificationHistory: [],
      completionReported: false,
    }
    const policy = {
      version: VERIFICATION_POLICY_VERSION,
      frozenAt: 15,
      sha256: 'a'.repeat(64),
      workspace: '/workspace',
      minimumEvidenceItems: 2,
      maxOutputChars: 4000,
      fixedChecks: [{ name: 'tests', commandSha256: 'b'.repeat(64), timeoutMs: 120_000 }],
      autoDiscoverChecks: true,
      projectChecks: ['js:test' as const],
      maxProjectChecks: 8,
      projectCheckTimeoutMs: 600_000,
      reviewers: [{
        role: 'requirements',
        descriptionSha256: 'c'.repeat(64),
        primary: { subagentProvider: 'spawn', provider: 'deepseek', model: 'reviewer' },
        fallbacks: [{ subagentProvider: 'spawn' }],
      }],
    }
    expect(runAuditRecordSchema.parse({
      version: RUN_STATE_VERSION,
      operation: 'verification-policy',
      time: base.updatedAt,
      snapshot: { ...base, verificationPolicy: policy },
    })).toMatchObject({ snapshot: { verificationPolicy: policy } })

    const parse = (verificationPolicy: unknown) => runSnapshotSchema.parse({
      ...base,
      verificationPolicy,
    })
    expect(() => parse({
      ...policy,
      fixedChecks: [...policy.fixedChecks, ...policy.fixedChecks],
    })).toThrow(/fixed check names must be unique/)
    expect(() => parse({
      ...policy,
      projectChecks: ['js:test', 'js:test'],
    })).toThrow(/project checks must be unique/)
    expect(() => parse({
      ...policy,
      reviewers: [...policy.reviewers, ...policy.reviewers],
    })).toThrow(/reviewer roles must be unique/)
  })
})

describe('run graph validation', () => {
  function graphTask(id: string, dependencies: readonly string[] = []): RunTask {
    return {
      id,
      title: 'title',
      description: 'description',
      acceptanceCriteria: ['accepted'],
      dependencies,
      status: 'pending',
      attempts: 0,
      attemptHistory: [],
      evidence: [],
      createdAt: 1,
      updatedAt: 1,
    }
  }

  it.each([
    [[graphTask('Bad')], /must match/],
    [[graphTask('a'), graphTask('a')], /duplicated/],
    [[{ ...graphTask('a'), title: ' ' }], /title and description/],
    [[{ ...graphTask('a'), description: '' }], /title and description/],
    [[graphTask('a', ['b', 'b']), graphTask('b')], /repeats a dependency/],
    [[graphTask('a', ['a'])], /cannot depend on itself/],
    [[graphTask('a', ['missing'])], /unknown task/],
    [[graphTask('a', ['b']), graphTask('b', ['c']), graphTask('c', ['a'])], /contains a cycle/],
  ])('rejects an invalid graph %#', (tasks, message) => {
    expect(() => validateTaskGraph(tasks)).toThrow(message)
  })

  it('accepts shared dependencies and already-visited nodes', () => {
    expect(() => validateTaskGraph([
      graphTask('root'),
      graphTask('left', ['root']),
      graphTask('right', ['root']),
      graphTask('leaf', ['left', 'right']),
    ])).not.toThrow()
  })
})

describe('run task transitions', () => {
  it('enforces dependencies and records attempts, evidence, blockers, and failures', () => {
    let plan = createRunPlan(['done'], [planned('build'), planned('test', ['build'])], 1)
    expect(() => updateRunTask(plan, 'test', 'start', 2)).toThrow(
      expect.objectContaining({ code: 'RUN_TASK_DEPENDENCY_BLOCKED' }),
    )

    plan = updateRunTask(plan, 'build', 'block', 2, { reason: ' waiting ' })
    expect(byId(plan, 'build')).toMatchObject({ status: 'blocked', reason: 'waiting', attempts: 0 })
    plan = updateRunTask(plan, 'build', 'reopen', 3)
    expect(byId(plan, 'build')).toMatchObject({ status: 'pending', attempts: 0 })
    expect(byId(plan, 'build')).not.toHaveProperty('reason')

    plan = updateRunTask(plan, 'build', 'start', 4)
    expect(byId(plan, 'build')).toMatchObject({
      status: 'in_progress',
      attempts: 1,
      attemptHistory: [{ attempt: 1, startedAt: 4, outcome: 'in_progress', evidence: [] }],
    })
    plan = updateRunTask(plan, 'build', 'fail', 5, { reason: 'compile failed' })
    expect(byId(plan, 'build')).toMatchObject({
      status: 'failed',
      reason: 'compile failed',
      attemptHistory: [{
        attempt: 1,
        startedAt: 4,
        finishedAt: 5,
        outcome: 'failed',
        evidence: [],
        reason: 'compile failed',
      }],
    })
    plan = updateRunTask(plan, 'build', 'reopen', 6)
    plan = updateRunTask(plan, 'build', 'start', 7)
    expect(byId(plan, 'build').attempts).toBe(2)

    expect(() => updateRunTask(plan, 'build', 'complete', 8)).toThrow(/evidence item/)
    expect(() => updateRunTask(plan, 'build', 'complete', 8, {
      evidence: [{ ...evidence, ref: '' }],
    })).toThrow()
    plan = updateRunTask(plan, 'build', 'complete', 8, { evidence: [evidence] })
    expect(byId(plan, 'build')).toMatchObject({
      status: 'completed',
      evidence: [evidence],
      attemptHistory: [
        expect.objectContaining({ attempt: 1, outcome: 'failed' }),
        {
          attempt: 2,
          startedAt: 7,
          finishedAt: 8,
          outcome: 'completed',
          evidence: [evidence],
        },
      ],
    })
    expect(byId(plan, 'build')).not.toHaveProperty('reason')
    expect(readyRunTasks(plan).map(task => task.id)).toEqual(['test'])

    plan = updateRunTask(plan, 'test', 'start', 9)
    plan = updateRunTask(plan, 'test', 'complete', 10, {
      evidence: [{ kind: 'file', ref: 'report.md', summary: 'review report' }],
    })
    expect(isRunPlanComplete(plan)).toBe(true)
    expect(plan.revision).toBe(10)
  })

  it('rejects missing tasks, empty reasons, and every illegal status transition', () => {
    const pending = createRunPlan(['done'], [planned('a')], 1)
    expect(() => updateRunTask(pending, 'missing', 'start', 2)).toThrow(
      expect.objectContaining({ code: 'RUN_TASK_NOT_FOUND' }),
    )
    expect(() => updateRunTask(pending, 'a', 'block', 2)).toThrow(/non-empty reason/)
    expect(() => updateRunTask(pending, 'a', 'fail', 2, { reason: ' ' })).toThrow(/non-empty reason/)
    expect(() => updateRunTask(pending, 'a', 'complete', 2, { evidence: [evidence] })).toThrow(
      expect.objectContaining({ code: 'RUN_TASK_INVALID_TRANSITION' }),
    )
    expect(() => updateRunTask(pending, 'a', 'reopen', 2)).toThrow(
      expect.objectContaining({ code: 'RUN_TASK_INVALID_TRANSITION' }),
    )

    const started = updateRunTask(pending, 'a', 'start', 2)
    expect(() => updateRunTask(started, 'a', 'start', 3)).toThrow(/cannot start/)
    const completed = updateRunTask(started, 'a', 'complete', 3, { evidence: [evidence] })
    expect(() => updateRunTask(completed, 'a', 'block', 4, { reason: 'late' })).toThrow(/cannot block/)
    expect(() => updateRunTask(completed, 'a', 'fail', 4, { reason: 'late' })).toThrow(/cannot fail/)
  })

  it('records an in-progress blocker against its active attempt', () => {
    let plan = createRunPlan(['done'], [planned('a')], 1)
    plan = updateRunTask(plan, 'a', 'start', 2)
    plan = updateRunTask(plan, 'a', 'block', 3, { reason: 'waiting for dependency' })
    expect(byId(plan, 'a')).toMatchObject({
      status: 'blocked',
      attemptHistory: [expect.objectContaining({
        outcome: 'blocked', finishedAt: 3, reason: 'waiting for dependency',
      })],
    })
  })

  it('distinguishes absent, empty, unfinished, and unevidenced plans', () => {
    const pending = createRunPlan(['done'], [planned('a')], 1)
    const started = updateRunTask(pending, 'a', 'start', 2)
    const fakeEmpty: RunPlan = { ...pending, tasks: [] }
    const fakeUnevidenced: RunPlan = {
      ...pending,
      tasks: [{ ...pending.tasks[0]!, status: 'completed', evidence: [] }],
    }
    expect(isRunPlanComplete(undefined)).toBe(false)
    expect(isRunPlanComplete(fakeEmpty)).toBe(false)
    expect(isRunPlanComplete(started)).toBe(false)
    expect(isRunPlanComplete(fakeUnevidenced)).toBe(false)
    expect(runEvidenceSchema.parse(evidence)).toEqual(evidence)
  })

  it('settles interrupted attempts as retryable or explicitly failed evidence', () => {
    let plan = createRunPlan(['done'], [planned('a'), planned('b')], 1)
    plan = updateRunTask(plan, 'a', 'start', 2)
    plan = updateRunTask(plan, 'b', 'start', 2)

    const retryable = interruptRunTasks(plan, 3, ' host process restarted ')
    expect(retryable.taskIds).toEqual(['a', 'b'])
    expect(retryable.plan).toMatchObject({ revision: plan.revision + 1, updatedAt: 3 })
    expect(retryable.plan.tasks).toEqual([
      expect.objectContaining({
        id: 'a',
        status: 'pending',
        attempts: 1,
        attemptHistory: [expect.objectContaining({
          attempt: 1,
          finishedAt: 3,
          outcome: 'interrupted',
          reason: 'host process restarted',
        })],
      }),
      expect.objectContaining({ id: 'b', status: 'pending' }),
    ])
    expect(retryable.plan.tasks[0]).not.toHaveProperty('reason')

    const restarted = updateRunTask(retryable.plan, 'a', 'start', 4)
    const terminal = interruptRunTasks(restarted, 5, 'authorization revoked', 'failed')
    expect(byId(terminal.plan, 'a')).toMatchObject({
      status: 'failed',
      attempts: 2,
      reason: 'authorization revoked',
      attemptHistory: [
        expect.objectContaining({ attempt: 1, outcome: 'interrupted' }),
        expect.objectContaining({ attempt: 2, outcome: 'interrupted', finishedAt: 5 }),
      ],
    })
    expect(interruptRunTasks(terminal.plan, 6, 'nothing active')).toEqual({
      plan: terminal.plan,
      taskIds: [],
    })
    expect(() => interruptRunTasks(plan, 3, ' ')).toThrow(/non-empty reason/)
  })

  it('rejects settlement when persisted in-progress state lacks its active attempt', () => {
    const plan = createRunPlan(['done'], [planned('a')], 1)
    const invalid: RunPlan = {
      ...plan,
      tasks: [{ ...plan.tasks[0]!, status: 'in_progress', attempts: 1, attemptHistory: [] }],
    }
    expect(() => updateRunTask(invalid, 'a', 'complete', 2, { evidence: [evidence] })).toThrow(
      /no active attempt/,
    )
  })

  it('exposes stable error identity and code', () => {
    const error = new RunStateError('bad plan', 'RUN_PLAN_INVALID')
    expect(error).toMatchObject({ name: 'RunStateError', message: 'bad plan', code: 'RUN_PLAN_INVALID' })
  })
})
