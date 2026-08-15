/** Durable Autopilot run, task-graph, evidence, and audit vocabulary. */
import { z } from 'zod'

/** Current persisted run format. A mismatch fails at the DSH storage boundary. */
export const RUN_STATE_VERSION = 10 as const

/** Maximum consecutive plan-hardening attempts before human attention is required. */
export const MAX_PLAN_REVIEW_ATTEMPTS = 5

/** Automatic final-report turns permitted before the durable outbox stops retrying. */
export const MAX_COMPLETION_DELIVERY_ATTEMPTS = 3

/** Version of the completion-critical deployment policy stored with a run. */
export const VERIFICATION_POLICY_VERSION = 1 as const

/** Stable task identifiers accepted in model tool input and durable state. */
export const TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

/** A run's durable lifecycle. Live activation is deliberately not persisted. */
export type RunPhase =
  | 'running'
  | 'verifying'
  | 'finalizing'
  | 'paused'
  | 'needs-attention'
  | 'exhausted'
  | 'revoked'
  | 'completed'

/** One task's lifecycle inside the durable dependency graph. */
export type RunTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'failed' | 'completed'

/** One auditable execution attempt, including crash and pause interruption. */
export interface RunTaskAttempt {
  readonly attempt: number
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  readonly outcome: 'in_progress' | 'completed' | 'blocked' | 'failed' | 'interrupted'
  readonly evidence: readonly RunEvidence[]
  readonly reason?: string | undefined
}

/** Inspectable evidence attached to a task or completion candidate. */
export interface RunEvidence {
  readonly kind: 'file' | 'command' | 'test' | 'url' | 'note' | 'subagent'
  readonly ref: string
  readonly summary: string
}

/** One task in the durable dependency graph. */
export interface RunTask {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly acceptanceCriteria: readonly string[]
  readonly dependencies: readonly string[]
  readonly status: RunTaskStatus
  readonly attempts: number
  readonly attemptHistory: readonly RunTaskAttempt[]
  readonly evidence: readonly RunEvidence[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly reason?: string | undefined
}

/** Intent class that selects a bounded workflow without changing authority. */
export type RunIntent =
  | 'implementation'
  | 'investigation'
  | 'repair'
  | 'performance'
  | 'delivery'
  | 'planning'

/** Human-readable plan and executable dependency graph. */
export interface RunPlan {
  readonly revision: number
  readonly intent: RunIntent
  readonly acceptanceCriteria: readonly string[]
  readonly tasks: readonly RunTask[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Canonical autonomous-development stage persisted independently from lease activation. */
export type AutopilotFlowStage =
  | 'interview'
  | 'planning'
  | 'plan-review'
  | 'execution'
  | 'code-review'
  | 'qa'
  | 'completed'

/** Human/model interview artifact required before the first executable plan. */
export interface AutopilotInterviewArtifact {
  readonly summary: string
  readonly decisions: readonly string[]
  readonly openQuestions: readonly string[]
  readonly recordedAt: number
}

/** One independent pre-execution plan-hardening verdict. */
export interface AutopilotPlanReviewVerdict {
  readonly role: 'metis' | 'momus' | 'oracle'
  readonly verdict: 'advice' | 'concern' | 'blocked' | 'error'
  readonly summary: string
  readonly findings: readonly string[]
  readonly recommendations: readonly string[]
  readonly childSessionId?: string | undefined
}

/** Immutable plan-review receipt bound to one exact plan revision. */
export interface AutopilotPlanReviewArtifact {
  readonly cycle: number
  readonly planRevision: number
  readonly passed: boolean
  readonly reviewers: readonly AutopilotPlanReviewVerdict[]
  readonly recordedAt: number
}

/** Durable canonical-flow cursor and its latest stage artifacts. */
export interface AutopilotFlowState {
  readonly revision: number
  readonly stage: AutopilotFlowStage
  readonly cycle: number
  readonly planReviewAttempts: number
  readonly updatedAt: number
  readonly interview?: AutopilotInterviewArtifact | undefined
  readonly planReview?: AutopilotPlanReviewArtifact | undefined
}

/** Materialized ceilings that retain the meaning of the original authorization. */
export interface RunBudgets {
  readonly maxVerificationAttempts: number
  readonly maxDynamicPackages: number
  readonly maxSubagents: number
  readonly maxConcurrentSubagents: number
  /** Maximum tasks retained in the durable graph. */
  readonly maxTasks: number
  /** Maximum aggregate task-attempt records retained by the run. */
  readonly maxTaskAttempts: number
  /** Maximum aggregate evidence records retained by tasks and attempts. */
  readonly maxEvidenceItems: number
  /** Maximum UTF-8 bytes in one complete durable snapshot. */
  readonly maxSnapshotBytes: number
  /** Maximum immutable audit revisions in one run generation. */
  readonly maxAuditRecords: number
  /** Maximum aggregate UTF-8 bytes across one run's audit records. */
  readonly maxAuditBytes: number
  /** Maximum aggregate characters retained as dynamic Host source. */
  readonly maxDynamicSourceChars: number
}

/** Run-lifetime usage. Resuming a process never resets these counters. */
export interface RunUsage {
  readonly verificationAttempts: number
  readonly dynamicPackages: number
  readonly subagentsStarted: number
}

/** One durable Host-only Cordis extension version owned by an Autopilot run. */
export interface DynamicExtensionVersion {
  readonly logicalId: string
  readonly version: number
  readonly name: string
  readonly purpose: string
  readonly hostCode: string
  readonly sourceSha256: string
  readonly status: 'applying' | 'active' | 'superseded' | 'failed' | 'removing' | 'removed'
  readonly createdAt: number
  readonly updatedAt: number
  readonly reason?: string | undefined
}

/** Candidate submitted to the independent completion gate. */
export interface VerificationCandidate {
  readonly summary: string
  readonly evidence: readonly string[]
  readonly submittedAt: number
}

/** One exact supported root manifest used to select project checks. */
export interface VerificationBaselineManifest {
  readonly name: 'package.json' | 'pyproject.toml' | 'Cargo.toml' | 'go.mod'
  readonly sha256: string
}

/** One finite project check frozen before the run's first model step. */
export interface VerificationBaselineCheck {
  readonly id:
    | 'js:check'
    | 'js:typecheck'
    | 'js:lint'
    | 'js:test'
    | 'js:build'
    | 'python:pytest'
    | 'python:ruff'
    | 'python:mypy'
    | 'rust:check'
    | 'rust:test'
    | 'go:vet'
    | 'go:test'
  readonly label: string
  readonly cwd: string
  readonly argv: readonly [string, ...string[]]
  readonly command: string
  readonly manifest: VerificationBaselineManifest['name']
}

/** One deployment-fixed check with its command retained only as a digest. */
export interface VerificationPolicyFixedCheck {
  readonly name: string
  readonly commandSha256: string
  readonly timeoutMs: number
}

/** Effective fresh-reviewer route selected by deployment configuration. */
export interface VerificationPolicyRoute {
  readonly subagentProvider: string
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** One required reviewer lane and its ordered infrastructure fallbacks. */
export interface VerificationPolicyReviewer {
  readonly role: string
  readonly descriptionSha256: string
  readonly primary: VerificationPolicyRoute
  readonly fallbacks: readonly VerificationPolicyRoute[]
}

/**
 * Completion-critical deployment policy frozen before the first model step.
 *
 * Arbitrary fixed-check commands and reviewer instructions are represented by
 * SHA-256 digests so credentials or deployment prose cannot enter the sidecar.
 * A resumed process must supply configuration that materializes identically.
 */
export interface VerificationPolicy {
  readonly version: typeof VERIFICATION_POLICY_VERSION
  readonly frozenAt: number
  readonly sha256: string
  /** Exact Agent workspace used by deployment-fixed checks, when available. */
  readonly workspace?: string | undefined
  readonly minimumEvidenceItems: number
  readonly maxOutputChars: number
  readonly fixedChecks: readonly VerificationPolicyFixedCheck[]
  readonly autoDiscoverChecks: boolean
  readonly projectChecks: readonly VerificationBaselineCheck['id'][]
  readonly maxProjectChecks: number
  readonly projectCheckTimeoutMs: number
  readonly reviewers: readonly VerificationPolicyReviewer[]
}

/** Durable project-verification decision frozen independently of model output. */
export type VerificationBaseline = {
  readonly kind: 'project'
  readonly workspace: string
  readonly frozenAt: number
  readonly manifests: readonly VerificationBaselineManifest[]
  readonly checks: readonly VerificationBaselineCheck[]
} | {
  readonly kind: 'reviewer-only'
  readonly frozenAt: number
  readonly manifests: readonly VerificationBaselineManifest[]
  readonly checks: readonly VerificationBaselineCheck[]
  readonly reason:
    | 'project-check-discovery-disabled'
    | 'no-agent-workspace'
    | 'no-supported-project'
    | 'no-supported-project-checks'
}

/** Bounded verification outcome retained in the run snapshot. */
export interface VerificationRecord {
  readonly attempt: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly verdict: 'pass' | 'fail' | 'inconclusive' | 'error'
  readonly summary: string
  readonly findings: readonly string[]
  readonly checks: readonly {
    readonly name: string
    readonly passed: boolean
    readonly summary: string
  }[]
  readonly reviewers: readonly {
    readonly role: string
    readonly verdict: 'pass' | 'fail' | 'inconclusive' | 'error'
    readonly summary: string
    readonly findings: readonly string[]
    readonly childSessionId?: string | undefined
  }[]
}

/** One complete durable post-mutation run snapshot. */
export interface RunSnapshot {
  readonly version: typeof RUN_STATE_VERSION
  readonly runId: string
  readonly generation: number
  readonly revision: number
  readonly sessionId: string
  readonly goalId: string
  readonly phase: RunPhase
  /** Whether the authorizing human opted this run into crash-only cold recovery. */
  readonly autoResume: boolean
  readonly grantedAt: number
  readonly updatedAt: number
  readonly expiresAt?: number | undefined
  readonly remainingActiveMs: number
  readonly maxActiveMs: number
  readonly selfModification: 'off' | 'host-only' | 'client-approved'
  readonly budgets: RunBudgets
  readonly usage: RunUsage
  readonly dynamicExtensions: readonly DynamicExtensionVersion[]
  /** Deployment verifier policy frozen before the first Autopilot model step. */
  readonly verificationPolicy?: VerificationPolicy | undefined
  /** Project checks and manifest bytes frozen before the first Autopilot model step. */
  readonly verificationBaseline?: VerificationBaseline | undefined
  /** Canonical interview, planning, execution, review, and QA stage cursor. */
  readonly flow: AutopilotFlowState
  readonly plan?: RunPlan | undefined
  readonly candidate?: VerificationCandidate | undefined
  /** Passing record reserved before the Goal and sidecar completion writes. */
  readonly finalization?: VerificationRecord | undefined
  readonly verificationHistory: readonly VerificationRecord[]
  /** Whether the host has durably observed one completion-notice delivery. */
  readonly completionReported: boolean
  /** Failed final-report turns recorded before host acknowledgement. */
  readonly completionDeliveryAttempts?: number | undefined
  /** Whether automatic final-report delivery reached its durable retry ceiling. */
  readonly completionDeliveryExhausted?: boolean | undefined
  /** Whether the Host durably exposed the terminal delivery failure. */
  readonly completionDeliveryExhaustionNotified?: boolean | undefined
  readonly reason?: string | undefined
}

/** Durable operation names carried by the append-only audit table. */
export type RunOperation =
  | 'start'
  | 'pause'
  | 'resume'
  | 'revoke'
  | 'expire'
  | 'needs-attention'
  | 'plan'
  | 'task'
  | 'task-interrupt'
  | 'subagent'
  | 'dynamic-package'
  | 'dynamic-apply'
  | 'dynamic-settle'
  | 'dynamic-remove-begin'
  | 'dynamic-remove-settle'
  | 'verification-policy'
  | 'verification-baseline'
  | 'flow'
  | 'verification-start'
  | 'verification-fail'
  | 'finalization-start'
  | 'finalization-complete'
  | 'completion-delivery-failed'
  | 'completion-delivery-exhaustion-notified'
  | 'completion-reported'
  | 'verification-error'

/** One append-only, whole-snapshot audit record. */
export interface RunAuditRecord {
  readonly version: typeof RUN_STATE_VERSION
  readonly operation: RunOperation
  readonly time: number
  readonly snapshot: RunSnapshot
}

/** Stable task-graph failures returned to model tools. */
export type RunStateErrorCode =
  | 'RUN_PLAN_INVALID'
  | 'RUN_PLAN_LOCKED'
  | 'RUN_TASK_NOT_FOUND'
  | 'RUN_TASK_INVALID_TRANSITION'
  | 'RUN_TASK_DEPENDENCY_BLOCKED'

/** Rejected task-graph mutation. */
export class RunStateError extends Error {
  /** Stable failure category. */
  readonly code: RunStateErrorCode

  /**
   * @param message - Actionable failure detail.
   * @param code - Stable failure category.
   */
  constructor(message: string, code: RunStateErrorCode) {
    super(message)
    this.name = 'RunStateError'
    this.code = code
  }
}

const nonEmpty = z.string().trim().min(1)
const safeTime = z.number().int().nonnegative()
const positiveInteger = z.number().int().positive()
const nonNegativeInteger = z.number().int().nonnegative()

/** Runtime schema for one evidence reference. */
export const runEvidenceSchema: z.ZodType<RunEvidence> = z.object({
  kind: z.enum(['file', 'command', 'test', 'url', 'note', 'subagent']),
  ref: nonEmpty,
  summary: nonEmpty,
})

/** Runtime schema for one task. */
export const runTaskSchema: z.ZodType<RunTask> = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  title: nonEmpty,
  description: nonEmpty,
  acceptanceCriteria: z.array(nonEmpty).min(1),
  dependencies: z.array(z.string().regex(TASK_ID_PATTERN)),
  status: z.enum(['pending', 'in_progress', 'blocked', 'failed', 'completed']),
  attempts: nonNegativeInteger,
  attemptHistory: z.array(z.object({
    attempt: positiveInteger,
    startedAt: safeTime,
    finishedAt: safeTime.optional(),
    outcome: z.enum(['in_progress', 'completed', 'blocked', 'failed', 'interrupted']),
    evidence: z.array(runEvidenceSchema),
    reason: nonEmpty.optional(),
  })),
  evidence: z.array(runEvidenceSchema),
  createdAt: safeTime,
  updatedAt: safeTime,
  reason: nonEmpty.optional(),
})

/** Runtime schema for the task graph. */
export const runPlanSchema: z.ZodType<RunPlan> = z.object({
  revision: positiveInteger,
  intent: z.enum(['implementation', 'investigation', 'repair', 'performance', 'delivery', 'planning']),
  acceptanceCriteria: z.array(nonEmpty).min(1),
  tasks: z.array(runTaskSchema).min(1),
  createdAt: safeTime,
  updatedAt: safeTime,
})

const flowReviewVerdictSchema: z.ZodType<AutopilotPlanReviewVerdict> = z.object({
  role: z.enum(['metis', 'momus', 'oracle']),
  verdict: z.enum(['advice', 'concern', 'blocked', 'error']),
  summary: nonEmpty,
  findings: z.array(nonEmpty),
  recommendations: z.array(nonEmpty),
  childSessionId: nonEmpty.optional(),
})

/** Runtime schema for the canonical autonomous-development stage cursor. */
export const autopilotFlowSchema: z.ZodType<AutopilotFlowState> = z.object({
  revision: positiveInteger,
  stage: z.enum(['interview', 'planning', 'plan-review', 'execution', 'code-review', 'qa', 'completed']),
  cycle: positiveInteger,
  planReviewAttempts: nonNegativeInteger.max(MAX_PLAN_REVIEW_ATTEMPTS),
  updatedAt: safeTime,
  interview: z.object({
    summary: nonEmpty,
    decisions: z.array(nonEmpty).min(1),
    openQuestions: z.array(nonEmpty),
    recordedAt: safeTime,
  }).optional(),
  planReview: z.object({
    cycle: positiveInteger,
    planRevision: positiveInteger,
    passed: z.boolean(),
    reviewers: z.array(flowReviewVerdictSchema).length(3),
    recordedAt: safeTime,
  }).optional(),
}).superRefine((flow, ctx) => {
  if (flow.stage !== 'interview' && flow.interview === undefined) {
    ctx.addIssue({ code: 'custom', message: 'canonical flow requires an interview artifact after interview' })
  }
  if (['execution', 'code-review', 'qa', 'completed'].includes(flow.stage)
    && flow.planReview?.passed !== true) {
    ctx.addIssue({ code: 'custom', message: `${flow.stage} requires a passing plan-review artifact` })
  }
  if (flow.planReview !== undefined) {
    const expected = ['metis', 'momus', 'oracle']
    if (flow.planReview.reviewers.some((reviewer, index) => reviewer.role !== expected[index])) {
      ctx.addIssue({ code: 'custom', message: 'plan reviewers must be ordered metis, momus, oracle' })
    }
    if (flow.planReview.passed
      !== flow.planReview.reviewers.every(reviewer => reviewer.verdict === 'advice')) {
      ctx.addIssue({ code: 'custom', message: 'plan-review pass must match every reviewer verdict' })
    }
    if (flow.planReview.passed
      && ['execution', 'code-review', 'qa', 'completed'].includes(flow.stage)
      && flow.planReview.cycle !== flow.cycle) {
      ctx.addIssue({ code: 'custom', message: 'passing plan review must match the active canonical cycle' })
    }
    if (!flow.planReview.passed && flow.planReview.cycle > flow.cycle) {
      ctx.addIssue({ code: 'custom', message: 'failed plan review cannot follow the canonical cycle' })
    }
    if (flow.planReview.recordedAt > flow.updatedAt) {
      ctx.addIssue({ code: 'custom', message: 'plan review cannot be recorded after the canonical flow update' })
    }
  }
  if (flow.interview !== undefined && flow.interview.recordedAt > flow.updatedAt) {
    ctx.addIssue({ code: 'custom', message: 'interview cannot be recorded after the canonical flow update' })
  }
})

const verificationRecordSchema: z.ZodType<VerificationRecord> = z.object({
  attempt: positiveInteger,
  startedAt: safeTime,
  finishedAt: safeTime,
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']),
  summary: nonEmpty,
  findings: z.array(nonEmpty),
  checks: z.array(z.object({ name: nonEmpty, passed: z.boolean(), summary: nonEmpty })),
  reviewers: z.array(z.object({
    role: nonEmpty,
    verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']),
    summary: nonEmpty,
    findings: z.array(nonEmpty),
    childSessionId: nonEmpty.optional(),
  })),
})

const dynamicExtensionVersionSchema: z.ZodType<DynamicExtensionVersion> = z.object({
  logicalId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  version: positiveInteger,
  name: nonEmpty,
  purpose: nonEmpty,
  hostCode: nonEmpty,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['applying', 'active', 'superseded', 'failed', 'removing', 'removed']),
  createdAt: safeTime,
  updatedAt: safeTime,
  reason: nonEmpty.optional(),
})

const baselineManifestSchema: z.ZodType<VerificationBaselineManifest> = z.object({
  name: z.enum(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
})

const baselineCheckSchema: z.ZodType<VerificationBaselineCheck> = z.object({
  id: z.enum([
    'js:check',
    'js:typecheck',
    'js:lint',
    'js:test',
    'js:build',
    'python:pytest',
    'python:ruff',
    'python:mypy',
    'rust:check',
    'rust:test',
    'go:vet',
    'go:test',
  ]),
  label: nonEmpty,
  cwd: nonEmpty,
  argv: z.tuple([nonEmpty]).rest(nonEmpty),
  command: nonEmpty,
  manifest: z.enum(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']),
})

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

const verificationPolicyRouteSchema: z.ZodType<VerificationPolicyRoute> = z.object({
  subagentProvider: nonEmpty,
  provider: nonEmpty.optional(),
  model: nonEmpty.optional(),
})

const verificationPolicySchema: z.ZodType<VerificationPolicy> = z.object({
  version: z.literal(VERIFICATION_POLICY_VERSION),
  frozenAt: safeTime,
  sha256: sha256Schema,
  workspace: nonEmpty.optional(),
  minimumEvidenceItems: nonNegativeInteger,
  maxOutputChars: positiveInteger,
  fixedChecks: z.array(z.object({
    name: nonEmpty,
    commandSha256: sha256Schema,
    timeoutMs: positiveInteger,
  })),
  autoDiscoverChecks: z.boolean(),
  projectChecks: z.array(z.enum([
    'js:check',
    'js:typecheck',
    'js:lint',
    'js:test',
    'js:build',
    'python:pytest',
    'python:ruff',
    'python:mypy',
    'rust:check',
    'rust:test',
    'go:vet',
    'go:test',
  ])),
  maxProjectChecks: z.number().int().min(1).max(12),
  projectCheckTimeoutMs: positiveInteger,
  reviewers: z.array(z.object({
    role: nonEmpty,
    descriptionSha256: sha256Schema,
    primary: verificationPolicyRouteSchema,
    fallbacks: z.array(verificationPolicyRouteSchema),
  })).min(1),
}).superRefine((policy, ctx) => {
  if (new Set(policy.fixedChecks.map(check => check.name)).size !== policy.fixedChecks.length) {
    ctx.addIssue({ code: 'custom', message: 'verification policy fixed check names must be unique' })
  }
  if (new Set(policy.projectChecks).size !== policy.projectChecks.length) {
    ctx.addIssue({ code: 'custom', message: 'verification policy project checks must be unique' })
  }
  if (new Set(policy.reviewers.map(reviewer => reviewer.role)).size !== policy.reviewers.length) {
    ctx.addIssue({ code: 'custom', message: 'verification policy reviewer roles must be unique' })
  }
})

const BASELINE_CHECK_RECIPES = Object.freeze({
  'js:check': { manifest: 'package.json', script: 'check' },
  'js:typecheck': { manifest: 'package.json', script: 'typecheck' },
  'js:lint': { manifest: 'package.json', script: 'lint' },
  'js:test': { manifest: 'package.json', script: 'test' },
  'js:build': { manifest: 'package.json', script: 'build' },
  'python:pytest': { manifest: 'pyproject.toml', argv: ['python', '-m', 'pytest'] },
  'python:ruff': { manifest: 'pyproject.toml', argv: ['python', '-m', 'ruff', 'check', '.'] },
  'python:mypy': { manifest: 'pyproject.toml', argv: ['python', '-m', 'mypy', '.'] },
  'rust:check': { manifest: 'Cargo.toml', argv: ['cargo', 'check', '--all-targets'] },
  'rust:test': { manifest: 'Cargo.toml', argv: ['cargo', 'test', '--all-targets'] },
  'go:vet': { manifest: 'go.mod', argv: ['go', 'vet', './...'] },
  'go:test': { manifest: 'go.mod', argv: ['go', 'test', './...'] },
} as const)

const JAVASCRIPT_BASELINE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])

const verificationBaselineSchema: z.ZodType<VerificationBaseline> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    workspace: nonEmpty,
    frozenAt: safeTime,
    manifests: z.array(baselineManifestSchema).min(1),
    checks: z.array(baselineCheckSchema).min(1),
  }),
  z.object({
    kind: z.literal('reviewer-only'),
    frozenAt: safeTime,
    manifests: z.array(baselineManifestSchema),
    checks: z.array(baselineCheckSchema).max(0),
    reason: z.enum([
      'project-check-discovery-disabled',
      'no-agent-workspace',
      'no-supported-project',
      'no-supported-project-checks',
    ]),
  }),
]).superRefine((baseline, ctx) => {
  const manifestNames = new Set(baseline.manifests.map(manifest => manifest.name))
  if (manifestNames.size !== baseline.manifests.length) {
    ctx.addIssue({ code: 'custom', message: 'verification baseline manifests must be unique' })
  }
  if (baseline.kind !== 'project') return
  const checkIds = new Set(baseline.checks.map(check => check.id))
  if (checkIds.size !== baseline.checks.length) {
    ctx.addIssue({ code: 'custom', message: 'verification baseline checks must be unique' })
  }
  for (const check of baseline.checks) {
    const recipe = BASELINE_CHECK_RECIPES[check.id]
    const expectedArgv = 'script' in recipe
      ? [check.argv[0], 'run', recipe.script]
      : recipe.argv
    if ('script' in recipe && !JAVASCRIPT_BASELINE_RUNNERS.has(check.argv[0])) {
      ctx.addIssue({ code: 'custom', message: `verification baseline check ${check.id} has an invalid runner` })
    }
    if (check.manifest !== recipe.manifest || !manifestNames.has(check.manifest)) {
      ctx.addIssue({ code: 'custom', message: `verification baseline check ${check.id} has no matching manifest` })
    }
    if (baseline.workspace !== check.cwd) {
      ctx.addIssue({ code: 'custom', message: `verification baseline check ${check.id} changed workspace` })
    }
    if (check.argv.length !== expectedArgv.length
      || check.argv.some((value, index) => value !== expectedArgv[index])
      || check.command !== check.argv.join(' ')) {
      ctx.addIssue({ code: 'custom', message: `verification baseline check ${check.id} changed its finite recipe` })
    }
  }
})

/** Runtime schema validating a complete stored run. */
export const runSnapshotSchema: z.ZodType<RunSnapshot> = z.object({
  version: z.literal(RUN_STATE_VERSION),
  runId: nonEmpty,
  generation: positiveInteger,
  revision: positiveInteger,
  sessionId: nonEmpty,
  goalId: nonEmpty,
  phase: z.enum([
    'running',
    'verifying',
    'finalizing',
    'paused',
    'needs-attention',
    'exhausted',
    'revoked',
    'completed',
  ]),
  autoResume: z.boolean(),
  grantedAt: safeTime,
  updatedAt: safeTime,
  expiresAt: safeTime.optional(),
  remainingActiveMs: nonNegativeInteger,
  maxActiveMs: positiveInteger,
  selfModification: z.enum(['off', 'host-only', 'client-approved']),
  budgets: z.object({
    maxVerificationAttempts: positiveInteger,
    maxDynamicPackages: positiveInteger,
    maxSubagents: positiveInteger,
    maxConcurrentSubagents: positiveInteger,
    maxTasks: positiveInteger,
    maxTaskAttempts: positiveInteger,
    maxEvidenceItems: positiveInteger,
    maxSnapshotBytes: positiveInteger,
    maxAuditRecords: positiveInteger,
    maxAuditBytes: positiveInteger,
    maxDynamicSourceChars: positiveInteger,
  }),
  usage: z.object({
    verificationAttempts: nonNegativeInteger,
    dynamicPackages: nonNegativeInteger,
    subagentsStarted: nonNegativeInteger,
  }),
  dynamicExtensions: z.array(dynamicExtensionVersionSchema),
  verificationPolicy: verificationPolicySchema.optional(),
  verificationBaseline: verificationBaselineSchema.optional(),
  flow: autopilotFlowSchema,
  plan: runPlanSchema.optional(),
  candidate: z.object({
    summary: nonEmpty,
    evidence: z.array(nonEmpty),
    submittedAt: safeTime,
  }).optional(),
  finalization: verificationRecordSchema.optional(),
  verificationHistory: z.array(verificationRecordSchema),
  completionReported: z.boolean(),
  completionDeliveryAttempts: nonNegativeInteger.max(MAX_COMPLETION_DELIVERY_ATTEMPTS).optional(),
  completionDeliveryExhausted: z.boolean().optional(),
  completionDeliveryExhaustionNotified: z.boolean().optional(),
  reason: nonEmpty.optional(),
}).superRefine((snapshot, ctx) => {
  if (snapshot.flow.updatedAt < snapshot.grantedAt) {
    ctx.addIssue({ code: 'custom', message: 'canonical flow time cannot precede run authorization' })
  }
  if (snapshot.flow.stage === 'completed' && snapshot.phase !== 'completed') {
    ctx.addIssue({ code: 'custom', message: 'completed canonical flow requires a completed run' })
  }
  if (snapshot.phase === 'completed' && snapshot.flow.stage !== 'completed') {
    ctx.addIssue({ code: 'custom', message: 'completed run requires a completed canonical flow' })
  }
  if (snapshot.phase === 'finalizing' && snapshot.flow.stage !== 'qa') {
    ctx.addIssue({ code: 'custom', message: 'finalizing run requires canonical QA' })
  }
  if (snapshot.phase === 'verifying'
    && snapshot.flow.stage !== 'code-review' && snapshot.flow.stage !== 'qa') {
    ctx.addIssue({ code: 'custom', message: 'verifying run requires canonical code review or QA' })
  }
  if (snapshot.flow.planReview?.passed === false
    && snapshot.flow.planReview.cycle === snapshot.flow.cycle
    && snapshot.phase !== 'needs-attention') {
    ctx.addIssue({
      code: 'custom',
      message: 'an unadvanced failed plan review requires human attention',
    })
  }
  if (['execution', 'code-review', 'qa', 'completed'].includes(snapshot.flow.stage)
    && (snapshot.plan === undefined
      || snapshot.flow.planReview === undefined
      || snapshot.flow.planReview.planRevision > snapshot.plan.revision)) {
    ctx.addIssue({ code: 'custom', message: 'canonical execution must descend from the reviewed plan revision' })
  }
  if (snapshot.phase === 'finalizing') {
    if (snapshot.finalization?.verdict !== 'pass') {
      ctx.addIssue({ code: 'custom', message: 'finalizing requires a passing verification record' })
    }
  } else if (snapshot.finalization !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'only finalizing may carry a pending verification record' })
  }
  if (snapshot.completionReported && snapshot.phase !== 'completed') {
    ctx.addIssue({ code: 'custom', message: 'only completed runs may report completion' })
  }
  const deliveryAttempts = snapshot.completionDeliveryAttempts ?? 0
  const deliveryExhausted = snapshot.completionDeliveryExhausted ?? false
  const deliveryExhaustionNotified = snapshot.completionDeliveryExhaustionNotified ?? false
  if ((deliveryAttempts > 0 || deliveryExhausted) && snapshot.phase !== 'completed') {
    ctx.addIssue({ code: 'custom', message: 'only completed runs may record completion delivery failures' })
  }
  if (deliveryExhausted !== (deliveryAttempts === MAX_COMPLETION_DELIVERY_ATTEMPTS)) {
    ctx.addIssue({
      code: 'custom',
      message: 'completion delivery exhaustion must match the automatic retry ceiling',
    })
  }
  if (snapshot.completionReported && deliveryExhausted) {
    ctx.addIssue({ code: 'custom', message: 'an exhausted completion delivery cannot be reported' })
  }
  if (deliveryExhaustionNotified && !deliveryExhausted) {
    ctx.addIssue({ code: 'custom', message: 'only an exhausted completion delivery may expose a terminal notice' })
  }
})

/** Runtime schema validating one audit row from DSH storage-domain. */
export const runAuditRecordSchema: z.ZodType<RunAuditRecord> = z.object({
  version: z.literal(RUN_STATE_VERSION),
  operation: z.enum([
    'start',
    'pause',
    'resume',
    'revoke',
    'expire',
    'needs-attention',
    'plan',
    'task',
    'task-interrupt',
    'subagent',
    'dynamic-package',
    'dynamic-apply',
    'dynamic-settle',
    'dynamic-remove-begin',
    'dynamic-remove-settle',
    'verification-policy',
    'verification-baseline',
    'flow',
    'verification-start',
    'verification-fail',
    'finalization-start',
    'finalization-complete',
    'completion-delivery-failed',
    'completion-delivery-exhaustion-notified',
    'completion-reported',
    'verification-error',
  ]),
  time: safeTime,
  snapshot: runSnapshotSchema,
})

/** Model input for one planned task. */
export interface PlannedTaskInput {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly acceptanceCriteria: readonly string[]
  readonly dependencies?: readonly string[]
}

/** Build and validate an initial plan from model input. */
export function createRunPlan(
  acceptanceCriteria: readonly string[],
  input: readonly PlannedTaskInput[],
  now: number,
  intent: RunIntent = 'implementation',
): RunPlan {
  const criteria = normalizeNonEmptyList(acceptanceCriteria, 'plan acceptance criteria')
  if (input.length === 0) {
    throw new RunStateError('a run plan requires at least one task', 'RUN_PLAN_INVALID')
  }
  const tasks = input.map((task): RunTask => ({
    id: task.id,
    title: task.title.trim(),
    description: task.description.trim(),
    acceptanceCriteria: normalizeNonEmptyList(task.acceptanceCriteria, `task ${task.id} acceptance criteria`),
    dependencies: [...(task.dependencies ?? [])],
    status: 'pending',
    attempts: 0,
    attemptHistory: [],
    evidence: [],
    createdAt: now,
    updatedAt: now,
  }))
  validateTaskGraph(tasks)
  return Object.freeze({
    revision: 1,
    intent,
    acceptanceCriteria: criteria,
    tasks: Object.freeze(tasks.map(task => Object.freeze(task))),
    createdAt: now,
    updatedAt: now,
  })
}

/** Replace a plan only while every existing task remains pending. */
export function replaceRunPlan(
  current: RunPlan | undefined,
  acceptanceCriteria: readonly string[],
  input: readonly PlannedTaskInput[],
  now: number,
  intent: RunIntent = current?.intent ?? 'implementation',
): RunPlan {
  if (current !== undefined && current.tasks.some(task => task.status !== 'pending')) {
    throw new RunStateError(
      'a plan cannot be replaced after any task has started; add or update explicit tasks instead',
      'RUN_PLAN_LOCKED',
    )
  }
  const plan = createRunPlan(acceptanceCriteria, input, now, intent)
  return current === undefined ? plan : Object.freeze({
    ...plan,
    revision: current.revision + 1,
    createdAt: current.createdAt,
  })
}

/** Add pending tasks while preserving existing task state and graph order. */
export function addRunTasks(
  current: RunPlan,
  input: readonly PlannedTaskInput[],
  now: number,
): RunPlan {
  if (input.length === 0) throw new RunStateError('add requires at least one task', 'RUN_PLAN_INVALID')
  const added = input.map((task): RunTask => Object.freeze({
    id: task.id,
    title: task.title.trim(),
    description: task.description.trim(),
    acceptanceCriteria: normalizeNonEmptyList(task.acceptanceCriteria, `task ${task.id} acceptance criteria`),
    dependencies: Object.freeze([...(task.dependencies ?? [])]),
    status: 'pending',
    attempts: 0,
    attemptHistory: Object.freeze([]),
    evidence: Object.freeze([]),
    createdAt: now,
    updatedAt: now,
  }))
  const tasks = [...current.tasks, ...added]
  validateTaskGraph(tasks)
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    tasks: Object.freeze(tasks),
    updatedAt: now,
  })
}

/** Reorder the complete task list without changing dependencies or task state. */
export function reorderRunTasks(current: RunPlan, order: readonly string[], now: number): RunPlan {
  const currentIds = current.tasks.map(task => task.id)
  if (order.length !== currentIds.length || new Set(order).size !== currentIds.length
    || currentIds.some(id => !order.includes(id))) {
    throw new RunStateError('task order must contain every task id exactly once', 'RUN_PLAN_INVALID')
  }
  const byId = new Map(current.tasks.map(task => [task.id, task]))
  const tasks = order.map(id => {
    const task = byId.get(id)
    /* v8 ignore next -- the exact-set validation above proves every ordered id exists. */
    if (task === undefined) throw new RunStateError(`unknown task ${id}`, 'RUN_TASK_NOT_FOUND')
    return task
  })
  return Object.freeze({ ...current, revision: current.revision + 1, tasks: Object.freeze(tasks), updatedAt: now })
}

/** Supported model-owned task transition. */
export type RunTaskAction = 'start' | 'complete' | 'block' | 'fail' | 'reopen'

/** Apply one validated task transition. */
export function updateRunTask(
  current: RunPlan,
  taskId: string,
  action: RunTaskAction,
  now: number,
  options: { readonly evidence?: readonly RunEvidence[]; readonly reason?: string } = {},
): RunPlan {
  const taskIndex = current.tasks.findIndex(task => task.id === taskId)
  if (taskIndex < 0) throw new RunStateError(`task "${taskId}" does not exist`, 'RUN_TASK_NOT_FOUND')
  const task = current.tasks[taskIndex]
  /* v8 ignore next -- findIndex proved the task exists. */
  if (task === undefined) throw new RunStateError(`task "${taskId}" does not exist`, 'RUN_TASK_NOT_FOUND')
  const byId = new Map(current.tasks.map(candidate => [candidate.id, candidate]))
  let next: RunTask
  switch (action) {
    case 'start': {
      if (task.status !== 'pending') throw taskTransitionError(task, action)
      const blocked = task.dependencies.filter(id => byId.get(id)?.status !== 'completed')
      if (blocked.length > 0) {
        throw new RunStateError(
          `task "${taskId}" is waiting for completed dependencies: ${blocked.join(', ')}`,
          'RUN_TASK_DEPENDENCY_BLOCKED',
        )
      }
      const attempt = task.attempts + 1
      next = {
        ...task,
        status: 'in_progress',
        attempts: attempt,
        attemptHistory: Object.freeze([
          ...task.attemptHistory,
          Object.freeze({ attempt, startedAt: now, outcome: 'in_progress' as const, evidence: Object.freeze([]) }),
        ]),
        updatedAt: now,
      }
      break
    }
    case 'complete': {
      if (task.status !== 'in_progress') throw taskTransitionError(task, action)
      const evidence = options.evidence ?? []
      if (evidence.length === 0) {
        throw new RunStateError('completing a task requires at least one evidence item', 'RUN_PLAN_INVALID')
      }
      for (const item of evidence) runEvidenceSchema.parse(item)
      next = {
        ...task,
        status: 'completed',
        evidence: Object.freeze([...evidence]),
        attemptHistory: settleTaskAttempt(task, 'completed', now, { evidence }),
        updatedAt: now,
      }
      delete (next as { reason?: string }).reason
      break
    }
    case 'block':
    case 'fail': {
      if (task.status !== 'pending' && task.status !== 'in_progress') throw taskTransitionError(task, action)
      const reason = options.reason?.trim()
      if (reason === undefined || reason.length === 0) {
        throw new RunStateError(`${action} requires a non-empty reason`, 'RUN_PLAN_INVALID')
      }
      next = {
        ...task,
        status: action === 'block' ? 'blocked' : 'failed',
        ...(task.status === 'in_progress'
          ? { attemptHistory: settleTaskAttempt(task, action === 'block' ? 'blocked' : 'failed', now, { reason }) }
          : {}),
        reason,
        updatedAt: now,
      }
      break
    }
    case 'reopen': {
      if (task.status !== 'blocked' && task.status !== 'failed') throw taskTransitionError(task, action)
      next = { ...task, status: 'pending', updatedAt: now }
      delete (next as { reason?: string }).reason
      break
    }
  }
  const tasks = [...current.tasks]
  tasks[taskIndex] = Object.freeze(next)
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    tasks: Object.freeze(tasks),
    updatedAt: now,
  })
}

/** Convert every interrupted in-progress attempt into an explicit retry or failure. */
export function interruptRunTasks(
  current: RunPlan,
  now: number,
  reason: string,
  disposition: 'pending' | 'failed' = 'pending',
): { readonly plan: RunPlan; readonly taskIds: readonly string[] } {
  const normalizedReason = reason.trim()
  if (normalizedReason.length === 0) {
    throw new RunStateError('task interruption requires a non-empty reason', 'RUN_PLAN_INVALID')
  }
  const taskIds: string[] = []
  const tasks = current.tasks.map(task => {
    if (task.status !== 'in_progress') return task
    taskIds.push(task.id)
    const interrupted: RunTask = {
      ...task,
      status: disposition,
      attemptHistory: settleTaskAttempt(task, 'interrupted', now, { reason: normalizedReason }),
      ...(disposition === 'failed' ? { reason: normalizedReason } : {}),
      updatedAt: now,
    }
    if (disposition === 'pending') delete (interrupted as { reason?: string }).reason
    return Object.freeze(interrupted)
  })
  if (taskIds.length === 0) return { plan: current, taskIds: Object.freeze([]) }
  return Object.freeze({
    plan: Object.freeze({
      ...current,
      revision: current.revision + 1,
      tasks: Object.freeze(tasks),
      updatedAt: now,
    }),
    taskIds: Object.freeze(taskIds),
  })
}

/** Settle the one active attempt retained by an in-progress task. */
function settleTaskAttempt(
  task: RunTask,
  outcome: Exclude<RunTaskAttempt['outcome'], 'in_progress'>,
  now: number,
  options: { readonly evidence?: readonly RunEvidence[]; readonly reason?: string },
): readonly RunTaskAttempt[] {
  const active = task.attemptHistory.at(-1)
  if (active === undefined || active.outcome !== 'in_progress' || active.attempt !== task.attempts) {
    throw new RunStateError(`task "${task.id}" has no active attempt to settle`, 'RUN_TASK_INVALID_TRANSITION')
  }
  const settled: RunTaskAttempt = Object.freeze({
    ...active,
    outcome,
    finishedAt: now,
    evidence: Object.freeze([...(options.evidence ?? [])]),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  return Object.freeze([...task.attemptHistory.slice(0, -1), settled])
}

/** Return dependency-ready pending tasks in plan order. */
export function readyRunTasks(plan: RunPlan): readonly RunTask[] {
  const byId = new Map(plan.tasks.map(task => [task.id, task]))
  return plan.tasks.filter(task => task.status === 'pending'
    && task.dependencies.every(id => byId.get(id)?.status === 'completed'))
}

/** Whether every acceptance-bearing task has independently recorded evidence. */
export function isRunPlanComplete(plan: RunPlan | undefined): boolean {
  return plan !== undefined && plan.tasks.length > 0
    && plan.tasks.every(task => task.status === 'completed' && task.evidence.length > 0)
}

/** Validate identity, dependency references, duplicate edges, and acyclicity. */
export function validateTaskGraph(tasks: readonly RunTask[]): void {
  const byId = new Map<string, RunTask>()
  for (const task of tasks) {
    if (!TASK_ID_PATTERN.test(task.id)) {
      throw new RunStateError(
        `task id "${task.id}" must match ${String(TASK_ID_PATTERN)}`,
        'RUN_PLAN_INVALID',
      )
    }
    if (byId.has(task.id)) throw new RunStateError(`task id "${task.id}" is duplicated`, 'RUN_PLAN_INVALID')
    if (task.title.trim().length === 0 || task.description.trim().length === 0) {
      throw new RunStateError(`task "${task.id}" requires a title and description`, 'RUN_PLAN_INVALID')
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new RunStateError(`task "${task.id}" repeats a dependency`, 'RUN_PLAN_INVALID')
    }
    byId.set(task.id, task)
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        throw new RunStateError(`task "${task.id}" cannot depend on itself`, 'RUN_PLAN_INVALID')
      }
      if (!byId.has(dependency)) {
        throw new RunStateError(
          `task "${task.id}" depends on unknown task "${dependency}"`,
          'RUN_PLAN_INVALID',
        )
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new RunStateError(`task graph contains a cycle at "${id}"`, 'RUN_PLAN_INVALID')
    if (visited.has(id)) return
    visiting.add(id)
    const task = byId.get(id)
    /* v8 ignore next -- only graph-owned ids enter the traversal. */
    if (task === undefined) throw new RunStateError(`unknown task "${id}"`, 'RUN_TASK_NOT_FOUND')
    for (const dependency of task.dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}

/** Normalize a required list without retaining mutable caller aliases. */
function normalizeNonEmptyList(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map(value => value.trim())
  if (normalized.length === 0 || normalized.some(value => value.length === 0)) {
    throw new RunStateError(`${label} must contain non-empty strings`, 'RUN_PLAN_INVALID')
  }
  return Object.freeze(normalized)
}

/** Build a consistent invalid-transition failure. */
function taskTransitionError(task: RunTask, action: RunTaskAction): RunStateError {
  return new RunStateError(
    `cannot ${action} task "${task.id}" while status is "${task.status}"`,
    'RUN_TASK_INVALID_TRANSITION',
  )
}
