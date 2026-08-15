/** Model-facing autonomy status, policy, and verifier tools. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { CordisDynamicPluginId } from '@deepseek-ai/dsh-cordis-host-runner'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workflow'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FORBIDDEN_DYNAMIC_SERVICES,
  DynamicExtensionController,
} from './dynamic-cordis.ts'
import {
  discoverProjectChecks,
  PROJECT_CHECK_IDS,
  validateProjectManifests,
} from './check-discovery.ts'
import type { ProjectCheckId } from './check-discovery.ts'
import { DEFAULT_REVIEWERS, runReviewerQuorum } from './evaluator.ts'
import type { ReviewerConfig, ReviewerOutcome, ReviewerRouteCandidate } from './evaluator.ts'
import { ManagedSubagentStarts } from './managed-subagents.ts'
import { completionMessage } from './recovery.ts'
import { registerRecoveryContribution } from './recovery-coordinator.ts'
import {
  DEFAULT_TASK_WORKER_TOOL_ALLOWLIST,
  delegateTaskBatch,
  delegationJson,
} from './orchestrator.ts'
import type { TaskRoute, TaskRouteCandidate, TaskRoutingPreference } from './orchestrator.ts'
import type {
  AutopilotPlanReviewVerdict,
  PlannedTaskInput,
  RunEvidence,
  RunTaskAction,
  VerificationBaseline,
  VerificationPolicy,
  VerificationPolicyRoute,
  VerificationRecord,
} from './run-state.ts'
import { VERIFICATION_POLICY_VERSION } from './run-state.ts'
import { AutonomyError } from './service.ts'
import type { AutonomyLeaseView } from './service.ts'
import {
  SPECIALIST_CATALOG,
  specialistCatalogJson,
} from './specialist-catalog.ts'
import {
  consultSpecialist,
  specialistConsultationJson,
} from './specialist-runner.ts'
import { apply as applyRalphTools } from './tool-ralph.ts'
import { apply as applyMissionTool } from './tool-mission.ts'
import { apply as applyTeamTools } from './tool-team.ts'
import { apply as applyWorkflowTools } from './tool-workflow.ts'

export const name = 'dsh-autopilot-tools'
export const inject = ['agents', 'autonomy', 'goals', 'shell', 'subagents', 'systemPrompt', 'tools']

/** Deployment-authored deterministic verification command. */
export interface VerifierCheckConfig {
  /** Stable check name reported to models and humans. */
  name: string
  /** Fixed shell command; models cannot alter it. */
  command: string
  /** Optional cooperative timeout. */
  timeoutMs?: number
}

/** Model tool and verifier configuration. */
export interface Config {
  /** Minimum number of non-empty evidence notes a candidate must submit. */
  minimumEvidenceItems?: number
  /** Maximum output characters retained from each verifier stream. */
  maxOutputChars?: number
  /** Optional deployment-fixed deterministic checks. */
  checks?: VerifierCheckConfig[]
  /** Discover finite repository-native check recipes from root manifests. */
  autoDiscoverChecks?: boolean
  /** Explicit finite project recipes; unavailable selections fail verification. */
  projectChecks?: ProjectCheckId[]
  /** Maximum automatically selected project recipes. */
  maxProjectChecks?: number
  /** Cooperative timeout applied to every discovered project recipe. */
  projectCheckTimeoutMs?: number
  /** Fresh read-only reviewer lanes required after deterministic checks. */
  reviewers?: ReviewerConfig[]
  /** Optional provider/model/persona routes for task-worker roles. */
  taskRoutes?: TaskRoute[]
  /** Preserve declared order or prefer the lowest deployment-authored costWeight. */
  taskRoutingPreference?: TaskRoutingPreference
  /** Exact global tools managed task workers may inherit. */
  taskWorkerToolAllowlist?: string[]
  /** Authority-bearing services generated Host code may not reference. */
  forbiddenDynamicServices?: string[]
}

interface ResolvedCheck {
  readonly name: string
  readonly command: string
  readonly timeoutMs: number
  readonly workdir?: string | undefined
}

interface ResolvedConfig {
  readonly minimumEvidenceItems: number
  readonly maxOutputChars: number
  readonly checks: readonly ResolvedCheck[]
  readonly autoDiscoverChecks: boolean
  readonly projectChecks: readonly ProjectCheckId[]
  readonly maxProjectChecks: number
  readonly projectCheckTimeoutMs: number
  readonly reviewers: readonly ReviewerConfig[]
  readonly taskRoutes: readonly TaskRoute[]
  readonly taskRoutingPreference: TaskRoutingPreference
  readonly taskWorkerToolAllowlist: readonly string[]
  readonly forbiddenDynamicServices: readonly string[]
}

interface DynamicCleanupDebt {
  readonly runId: string
  readonly reason: string
}

interface DynamicSurfaceState {
  readonly hostPackages: Map<Agent, Map<string, string>>
  readonly cleanupDebts: Map<Agent, DynamicCleanupDebt>
}

interface DynamicCleanupGate {
  readonly cleanup: (agent: Agent, view: AutonomyLeaseView) => Promise<void>
  readonly debt: (agent: Agent) => DynamicCleanupDebt | undefined
}

const SHARED_DYNAMIC_SURFACE_STATES = new WeakMap<Context, DynamicSurfaceState>()

export const Config = z.object({
  minimumEvidenceItems: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  maxOutputChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4000),
  checks: z.array(z.object({
    name: z.string(),
    command: z.string(),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(120_000),
  })).default([]),
  autoDiscoverChecks: z.boolean().default(true),
  projectChecks: z.array(z.union(PROJECT_CHECK_IDS)).default([]),
  maxProjectChecks: z.number().step(1).min(1).max(12).default(8),
  projectCheckTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(600_000),
  reviewers: z.array(z.object({
    role: z.string(),
    description: z.string(),
    subagentProvider: z.string().default(''),
    provider: z.string().default(''),
    model: z.string().default(''),
    fallbacks: z.array(z.object({
      subagentProvider: z.string().default(''),
      provider: z.string().default(''),
      model: z.string().default(''),
    })).default([]),
  })).min(1).default(DEFAULT_REVIEWERS.map(reviewer => ({
    role: reviewer.role,
    description: reviewer.description,
    subagentProvider: '',
    provider: '',
    model: '',
    fallbacks: [],
  }))),
  taskRoutes: z.array(z.object({
    role: z.string(),
    subagentProvider: z.string().default(''),
    provider: z.string().default(''),
    model: z.string().default(''),
    persona: z.string().default(''),
    costWeight: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    fallbacks: z.array(z.object({
      subagentProvider: z.string().default(''),
      provider: z.string().default(''),
      model: z.string().default(''),
      persona: z.string().default(''),
      costWeight: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    })).default([]),
  })).default([]),
  taskRoutingPreference: z.union(['declared', 'economy']).default('declared'),
  taskWorkerToolAllowlist: z.array(z.string()).default([...DEFAULT_TASK_WORKER_TOOL_ALLOWLIST]),
  forbiddenDynamicServices: z.array(z.string()).default([...DEFAULT_FORBIDDEN_DYNAMIC_SERVICES]),
}) as z<Config>

/** Resolve configuration and reject ambiguous verifier identity at load. */
function resolveConfig(config: Config): ResolvedConfig {
  const minimumEvidenceItems = config.minimumEvidenceItems ?? 1
  const maxOutputChars = config.maxOutputChars ?? 4000
  if (!Number.isSafeInteger(minimumEvidenceItems) || minimumEvidenceItems < 0) {
    throw new TypeError('minimumEvidenceItems must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new TypeError('maxOutputChars must be a positive safe integer')
  }
  const names = new Set<string>()
  const checks = (config.checks ?? []).map((check): ResolvedCheck => {
    const name = check.name.trim()
    const command = check.command.trim()
    const timeoutMs = check.timeoutMs ?? 120_000
    if (name.length === 0) throw new TypeError('verifier check name must not be empty')
    if (names.has(name)) throw new TypeError(`verifier check name "${name}" is duplicated`)
    names.add(name)
    if (command.length === 0) throw new TypeError(`verifier check "${name}" command must not be empty`)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError(`verifier check "${name}" timeoutMs must be a positive safe integer`)
    }
    return Object.freeze({ name, command, timeoutMs })
  })
  const normalizeReviewerCandidate = (
    candidate: ReviewerRouteCandidate,
    label: string,
    requireSelection: boolean,
  ): ReviewerRouteCandidate => {
    const subagentProvider = candidate.subagentProvider?.trim()
    const provider = candidate.provider?.trim()
    const model = candidate.model?.trim()
    if (requireSelection && [subagentProvider, provider, model]
      .every(value => value === undefined || value.length === 0)) {
      throw new TypeError(`${label} must select a subagent provider or model route`)
    }
    return Object.freeze({
      ...(subagentProvider === undefined || subagentProvider.length === 0 ? {} : { subagentProvider }),
      ...(provider === undefined || provider.length === 0 ? {} : { provider }),
      ...(model === undefined || model.length === 0 ? {} : { model }),
    })
  }
  const reviewerNames = new Set<string>()
  const reviewers = (config.reviewers ?? DEFAULT_REVIEWERS).map((reviewer): ReviewerConfig => {
    const role = reviewer.role.trim()
    const description = reviewer.description.trim()
    if (role.length === 0 || description.length === 0) {
      throw new TypeError('reviewer role and description must not be empty')
    }
    if (reviewerNames.has(role)) throw new TypeError(`reviewer role "${role}" is duplicated`)
    reviewerNames.add(role)
    const primary = normalizeReviewerCandidate(reviewer, `reviewer "${role}"`, false)
    const fallbacks = (reviewer.fallbacks ?? []).map((candidate, index) => normalizeReviewerCandidate(
      candidate,
      `reviewer "${role}" fallback ${index + 1}`,
      true,
    ))
    return Object.freeze({
      role,
      description,
      ...primary,
      ...(fallbacks.length === 0 ? {} : { fallbacks: Object.freeze(fallbacks) }),
    })
  })
  const normalizeTaskCandidate = (
    candidate: TaskRouteCandidate,
    label: string,
    requireSelection: boolean,
  ): TaskRouteCandidate => {
    const subagentProvider = candidate.subagentProvider?.trim()
    const provider = candidate.provider?.trim()
    const model = candidate.model?.trim()
    const persona = candidate.persona?.trim()
    const costWeight = candidate.costWeight
    if (costWeight !== undefined && (!Number.isSafeInteger(costWeight) || costWeight < 1)) {
      throw new TypeError(`${label} costWeight must be a positive safe integer`)
    }
    if (requireSelection && [subagentProvider, provider, model, persona]
      .every(value => value === undefined || value.length === 0)) {
      throw new TypeError(`${label} must select a subagent provider, model route, or persona`)
    }
    return Object.freeze({
      ...(subagentProvider === undefined || subagentProvider.length === 0 ? {} : { subagentProvider }),
      ...(provider === undefined || provider.length === 0 ? {} : { provider }),
      ...(model === undefined || model.length === 0 ? {} : { model }),
      ...(persona === undefined || persona.length === 0 ? {} : { persona }),
      ...(costWeight === undefined ? {} : { costWeight }),
    })
  }
  const routeNames = new Set<string>()
  const taskRoutes = (config.taskRoutes ?? []).map((route): TaskRoute => {
    const role = route.role.trim()
    if (role.length === 0) throw new TypeError('task route role must not be empty')
    if (routeNames.has(role)) throw new TypeError(`task route role "${role}" is duplicated`)
    routeNames.add(role)
    const primary = normalizeTaskCandidate(route, `task route "${role}"`, false)
    const fallbacks = (route.fallbacks ?? []).map((candidate, index) => normalizeTaskCandidate(
      candidate,
      `task route "${role}" fallback ${index + 1}`,
      true,
    ))
    return Object.freeze({
      role,
      ...primary,
      ...(fallbacks.length === 0 ? {} : { fallbacks: Object.freeze(fallbacks) }),
    })
  })
  const forbiddenDynamicServices = (config.forbiddenDynamicServices
    ?? DEFAULT_FORBIDDEN_DYNAMIC_SERVICES).map(service => service.trim())
  if (forbiddenDynamicServices.some(service => service.length === 0)
    || new Set(forbiddenDynamicServices).size !== forbiddenDynamicServices.length) {
    throw new TypeError('forbiddenDynamicServices must contain unique non-empty service names')
  }
  const taskWorkerToolAllowlist = (config.taskWorkerToolAllowlist
    ?? DEFAULT_TASK_WORKER_TOOL_ALLOWLIST).map(name => name.trim())
  if (taskWorkerToolAllowlist.some(name => name.length === 0)
    || new Set(taskWorkerToolAllowlist).size !== taskWorkerToolAllowlist.length) {
    throw new TypeError('taskWorkerToolAllowlist must contain unique non-empty tool names')
  }
  const projectChecks = [...(config.projectChecks ?? [])]
  if (projectChecks.some(check => !PROJECT_CHECK_IDS.includes(check))
    || new Set(projectChecks).size !== projectChecks.length) {
    throw new TypeError('projectChecks must contain unique supported recipe ids')
  }
  const maxProjectChecks = config.maxProjectChecks ?? 8
  if (!Number.isSafeInteger(maxProjectChecks) || maxProjectChecks < 1 || maxProjectChecks > 12) {
    throw new TypeError('maxProjectChecks must be an integer from 1 to 12')
  }
  const projectCheckTimeoutMs = config.projectCheckTimeoutMs ?? 600_000
  if (!Number.isSafeInteger(projectCheckTimeoutMs) || projectCheckTimeoutMs < 1) {
    throw new TypeError('projectCheckTimeoutMs must be a positive safe integer')
  }
  return Object.freeze({
    minimumEvidenceItems,
    maxOutputChars,
    checks: Object.freeze(checks),
    autoDiscoverChecks: config.autoDiscoverChecks ?? true,
    projectChecks: Object.freeze(projectChecks),
    maxProjectChecks,
    projectCheckTimeoutMs,
    reviewers: Object.freeze(reviewers),
    taskRoutes: Object.freeze(taskRoutes),
    taskRoutingPreference: config.taskRoutingPreference ?? 'declared',
    taskWorkerToolAllowlist: Object.freeze(taskWorkerToolAllowlist),
    forbiddenDynamicServices: Object.freeze(forbiddenDynamicServices),
  })
}

/** Compute a stable SHA-256 without retaining the hashed input. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Materialize one effective reviewer route, including the default transport. */
function verificationPolicyRoute(candidate: ReviewerRouteCandidate): VerificationPolicyRoute {
  return Object.freeze({
    subagentProvider: candidate.subagentProvider ?? 'spawn',
    ...(candidate.provider === undefined ? {} : { provider: candidate.provider }),
    ...(candidate.model === undefined ? {} : { model: candidate.model }),
  })
}

/** Build the credential-free durable description of every completion-critical setting. */
function materializeVerificationPolicy(config: ResolvedConfig, agent: Agent): VerificationPolicy {
  const workspace = agent.session.header.cwd
  const fixedChecks = Object.freeze(config.checks.map(check => Object.freeze({
    name: check.name,
    commandSha256: sha256(check.command),
    timeoutMs: check.timeoutMs,
  })))
  const reviewers = Object.freeze(config.reviewers.map(reviewer => Object.freeze({
    role: reviewer.role,
    descriptionSha256: sha256(reviewer.description),
    primary: verificationPolicyRoute(reviewer),
    fallbacks: Object.freeze((reviewer.fallbacks ?? []).map(verificationPolicyRoute)),
  })))
  const materialized = {
    version: VERIFICATION_POLICY_VERSION,
    workspace: workspace ?? null,
    minimumEvidenceItems: config.minimumEvidenceItems,
    maxOutputChars: config.maxOutputChars,
    fixedChecks,
    autoDiscoverChecks: config.autoDiscoverChecks,
    projectChecks: Object.freeze([...config.projectChecks]),
    maxProjectChecks: config.maxProjectChecks,
    projectCheckTimeoutMs: config.projectCheckTimeoutMs,
    reviewers,
  }
  return Object.freeze({
    version: materialized.version,
    frozenAt: Date.now(),
    sha256: sha256(JSON.stringify(materialized)),
    ...(workspace === undefined ? {} : { workspace }),
    minimumEvidenceItems: materialized.minimumEvidenceItems,
    maxOutputChars: materialized.maxOutputChars,
    fixedChecks,
    autoDiscoverChecks: materialized.autoDiscoverChecks,
    projectChecks: materialized.projectChecks,
    maxProjectChecks: materialized.maxProjectChecks,
    projectCheckTimeoutMs: materialized.projectCheckTimeoutMs,
    reviewers,
  })
}

/** Test whether an unknown value is an ordinary record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Convert a Goal view to its compare-and-set reference. */
function goalRef(goal: GoalView): { id: GoalView['id']; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

/** Require the Agent attached by the agent loop. */
function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Autopilot tools require an Agent-backed session')
  return exec.agent
}

/** Return a bounded tail without hiding whether truncation occurred. */
function outputPreview(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(-maxChars), truncated: true }
}

/** Render any canonical JSON tool value. */
function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Freeze and validate deployment verifier policy before model-controlled work proceeds. */
async function ensureVerificationPolicy(
  ctx: Context,
  config: ResolvedConfig,
  agent: Agent,
): Promise<VerificationPolicy> {
  const frozen = await ctx.autonomy.freezeVerificationPolicy(
    agent,
    materializeVerificationPolicy(config, agent),
  )
  /* v8 ignore next -- freezeVerificationPolicy always returns the committed policy. */
  if (frozen.verificationPolicy === undefined) throw new Error('verification policy was not frozen')
  return frozen.verificationPolicy
}

/** Discover and durably freeze project checks before model-controlled work proceeds. */
async function ensureVerificationBaseline(
  ctx: Context,
  config: ResolvedConfig,
  agent: Agent,
): Promise<VerificationBaseline> {
  const current = ctx.autonomy.get(agent)?.verificationBaseline
  if (current !== undefined) return current
  const workspace = agent.session.header.cwd
  const explicitlySelected = config.projectChecks.length > 0
  if ((!config.autoDiscoverChecks && !explicitlySelected) || workspace === undefined) {
    if (explicitlySelected) {
      throw new Error('explicit projectChecks require an Agent workspace')
    }
    const baseline: VerificationBaseline = Object.freeze({
      kind: 'reviewer-only',
      frozenAt: Date.now(),
      manifests: Object.freeze([]),
      checks: Object.freeze([]),
      reason: !config.autoDiscoverChecks && !explicitlySelected
        ? 'project-check-discovery-disabled'
        : 'no-agent-workspace',
    })
    const frozen = await ctx.autonomy.freezeVerificationBaseline(agent, baseline)
    return frozen.verificationBaseline!
  }
  const discovered = await discoverProjectChecks({
    workspace,
    ...(explicitlySelected ? { explicit: { checks: config.projectChecks } } : {}),
    maxChecks: config.maxProjectChecks,
  })
  if (discovered.kind === 'explicit' && discovered.unavailable.length > 0) {
    throw new Error(`explicit project checks are unavailable: ${discovered.unavailable.join(', ')}`)
  }
  if (discovered.kind === 'explicit' && discovered.omitted.length > 0) {
    throw new Error(`explicit project checks exceed maxProjectChecks: ${discovered.omitted.join(', ')}`)
  }
  const manifests = Object.freeze(discovered.manifests.map(manifest => Object.freeze({
    name: manifest.name,
    sha256: manifest.sha256,
  })))
  const baseline: VerificationBaseline = discovered.checks.length === 0
    ? Object.freeze({
      kind: 'reviewer-only',
      frozenAt: Date.now(),
      manifests,
      checks: Object.freeze([]),
      reason: discovered.kind === 'none'
        ? 'no-supported-project'
        : 'no-supported-project-checks',
    })
    : Object.freeze({
      kind: 'project',
      workspace: discovered.workspace,
      frozenAt: Date.now(),
      manifests,
      checks: Object.freeze(discovered.checks.map(check => Object.freeze({
        ...check,
        argv: Object.freeze([...check.argv]) as unknown as readonly [string, ...string[]],
      }))),
    })
  const frozen = await ctx.autonomy.freezeVerificationBaseline(agent, baseline)
  return frozen.verificationBaseline!
}

/** Resolve deployment-fixed checks plus the already frozen project recipes. */
function verifierChecks(
  config: ResolvedConfig,
  baseline: VerificationBaseline,
  policy: VerificationPolicy,
): readonly ResolvedCheck[] {
  return Object.freeze([
    ...config.checks.map(check => Object.freeze({
      ...check,
      ...(policy.workspace === undefined ? {} : { workdir: policy.workspace }),
    })),
    ...baseline.checks.map((check): ResolvedCheck => Object.freeze({
      name: `project/${check.id}`,
      command: check.command,
      timeoutMs: policy.projectCheckTimeoutMs,
      workdir: check.cwd,
    })),
  ])
}

/** Render baseline drift as a deterministic failed check, not verifier infrastructure loss. */
function baselineFailure(findings: readonly string[]): { [key: string]: JsonValue } {
  const detail = findings.join('; ')
  return {
    name: 'project/verification-baseline',
    passed: false,
    exitCode: null,
    timedOut: false,
    aborted: false,
    stdout: { text: '', truncated: false },
    stderr: { text: findings.join('\n'), truncated: false },
    failureSummary: `project/verification-baseline failed: ${detail}`,
  }
}

/** Render a bounded durable checkpoint directly into the next model request. */
function modelCheckpoint(goal: GoalView, lease: AutonomyLeaseView): string {
  const tasks = lease.plan?.tasks ?? []
  const taskCheckpoint = tasks.slice(0, 32).map(task => ({ id: task.id, status: task.status }))
  const latest = lease.verificationHistory.at(-1)
  const verificationCheckpoint = latest === undefined
    ? null
    : {
        attempt: latest.attempt,
        verdict: latest.verdict,
        summary: latest.summary.slice(0, 500),
        findings: latest.findings.slice(0, 5).map(finding => finding.slice(0, 500)),
      }
  return [
    `Objective checkpoint: ${JSON.stringify(goal.objective.slice(0, 2000))}.`,
    `Task checkpoint (${taskCheckpoint.length}/${tasks.length} shown): ${JSON.stringify(taskCheckpoint)}.`,
    `Latest verification checkpoint: ${JSON.stringify(verificationCheckpoint)}.`,
  ].join(' ')
}

/** Build a JSON-safe status snapshot. */
function statusValue(ctx: Context, agent: Agent): JsonValue {
  const goal = ctx.goals.get(agent)
  const lease = ctx.autonomy.get(agent)
  const visibleTools = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
  const hasEvery = (...names: readonly string[]): boolean => names.every(name => visibleTools.has(name))
  return {
    composition: {
      sessionSearch: hasEvery(
        'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
      ),
      skillCatalog: visibleTools.has('skill'),
      lspNavigation: visibleTools.has('lsp'),
      fileSearch: hasEvery('glob', 'grep'),
      webResearch: hasEvery('web_search', 'web_fetch'),
      interactiveTerminal: hasEvery('terminal_open', 'terminal_read', 'terminal_send', 'terminal_close'),
      backgroundJobs: hasEvery('job_output', 'job_list', 'job_kill'),
      imageAnalysis: visibleTools.has('read_image'),
    },
    goal: goal === undefined ? null : {
      id: String(goal.id),
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      activation: goal.activation,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
    },
    lease: lease === undefined ? null : {
      id: lease.id,
      generation: lease.generation,
      revision: lease.revision,
      goalId: String(lease.goalId),
      phase: lease.phase,
      activation: lease.activation,
      remainingActiveMs: lease.remainingActiveMs,
      verificationAttempts: lease.verificationAttempts,
      maxVerificationAttempts: lease.maxVerificationAttempts,
      dynamicPackages: lease.dynamicPackages,
      maxDynamicPackages: lease.maxDynamicPackages,
      subagentsStarted: lease.subagentsStarted,
      maxSubagents: lease.maxSubagents,
      maxConcurrentSubagents: lease.maxConcurrentSubagents,
      maxTasks: lease.maxTasks,
      maxTaskAttempts: lease.maxTaskAttempts,
      maxEvidenceItems: lease.maxEvidenceItems,
      maxSnapshotBytes: lease.maxSnapshotBytes,
      maxAuditRecords: lease.maxAuditRecords,
      maxAuditBytes: lease.maxAuditBytes,
      maxDynamicSourceChars: lease.maxDynamicSourceChars,
      selfModification: lease.selfModification,
      verificationPolicy: lease.verificationPolicy === undefined ? null : {
        version: lease.verificationPolicy.version,
        sha256: lease.verificationPolicy.sha256,
        minimumEvidenceItems: lease.verificationPolicy.minimumEvidenceItems,
        maxOutputChars: lease.verificationPolicy.maxOutputChars,
        fixedChecks: lease.verificationPolicy.fixedChecks.map(check => ({
          name: check.name,
          commandSha256: check.commandSha256,
          timeoutMs: check.timeoutMs,
        })),
        reviewerRoles: lease.verificationPolicy.reviewers.map(reviewer => reviewer.role),
        projectChecks: [...lease.verificationPolicy.projectChecks],
        projectCheckTimeoutMs: lease.verificationPolicy.projectCheckTimeoutMs,
      },
      verificationBaseline: lease.verificationBaseline === undefined ? null : {
        kind: lease.verificationBaseline.kind,
        frozenAt: lease.verificationBaseline.frozenAt,
        checks: lease.verificationBaseline.checks.map(check => `project/${check.id}`),
        manifests: lease.verificationBaseline.manifests.map(manifest => ({
          name: manifest.name,
          sha256: manifest.sha256,
        })),
        ...(lease.verificationBaseline.kind === 'reviewer-only'
          ? { reason: lease.verificationBaseline.reason }
          : { workspace: lease.verificationBaseline.workspace }),
      },
      flow: {
        revision: lease.flow.revision,
        stage: lease.flow.stage,
        cycle: lease.flow.cycle,
        planReviewAttempts: lease.flow.planReviewAttempts,
        interview: lease.flow.interview === undefined ? null : {
          summary: lease.flow.interview.summary,
          decisions: [...lease.flow.interview.decisions],
          openQuestions: [...lease.flow.interview.openQuestions],
          recordedAt: lease.flow.interview.recordedAt,
        },
        planReview: lease.flow.planReview === undefined ? null : {
          cycle: lease.flow.planReview.cycle,
          planRevision: lease.flow.planReview.planRevision,
          passed: lease.flow.planReview.passed,
          reviewers: lease.flow.planReview.reviewers.map(reviewer => ({
            role: reviewer.role,
            verdict: reviewer.verdict,
            summary: reviewer.summary,
            findings: [...reviewer.findings],
            recommendations: [...reviewer.recommendations],
            ...(reviewer.childSessionId === undefined ? {} : { childSessionId: reviewer.childSessionId }),
          })),
          recordedAt: lease.flow.planReview.recordedAt,
        },
      },
      dynamicExtensions: lease.dynamicExtensions.map(extension => ({
        logicalId: extension.logicalId,
        version: extension.version,
        name: extension.name,
        purpose: extension.purpose,
        sourceSha256: extension.sourceSha256,
        status: extension.status,
        ...(extension.reason === undefined ? {} : { reason: extension.reason }),
      })),
      plan: lease.plan === undefined ? null : {
        revision: lease.plan.revision,
        intent: lease.plan.intent,
        acceptanceCriteria: [...lease.plan.acceptanceCriteria],
        tasks: lease.plan.tasks.map(task => ({
          id: task.id,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [...task.acceptanceCriteria],
          dependencies: [...task.dependencies],
          status: task.status,
          attempts: task.attempts,
          evidence: task.evidence.map(item => ({ ...item })),
          ...(task.reason === undefined ? {} : { reason: task.reason }),
        })),
      },
      verificationHistory: lease.verificationHistory.map(record => ({
        attempt: record.attempt,
        verdict: record.verdict,
        summary: record.summary,
        findings: [...record.findings],
        reviewers: record.reviewers.map(reviewer => ({
          role: reviewer.role,
          verdict: reviewer.verdict,
          summary: reviewer.summary,
          findings: [...reviewer.findings],
          ...(reviewer.childSessionId === undefined ? {} : { childSessionId: reviewer.childSessionId }),
        })),
      })),
      ...(lease.reason === undefined ? {} : { reason: lease.reason }),
    },
  }
}

/** Describe one verifier outcome without exposing unbounded command output. */
function checkResult(
  check: ResolvedCheck,
  result: ShellRunResult,
  maxOutputChars: number,
): { [key: string]: JsonValue } {
  const stdout = outputPreview(result.stdout.text, maxOutputChars)
  const stderr = outputPreview(result.stderr.text, maxOutputChars)
  return {
    name: check.name,
    passed: result.exitCode === 0 && !result.timedOut && !result.aborted
      && result.sandbox?.runnerFailed !== true,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout,
    stderr,
    ...(result.sandbox === undefined ? {} : {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...(result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement }),
        ...(result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed }),
      },
    }),
  }
}

/** Reduce one detailed shell result to the bounded durable verification record. */
function durableCheck(value: { [key: string]: JsonValue }): VerificationRecord['checks'][number] {
  const name = String(value['name'])
  const passed = value['passed'] === true
  const exitCode = value['exitCode']
  const timedOut = value['timedOut'] === true
  const aborted = value['aborted'] === true
  const failureSummary = value['failureSummary']
  return Object.freeze({
    name,
    passed,
    summary: passed
      ? `${name} passed (exit ${String(exitCode)})`
      : typeof failureSummary === 'string'
        ? failureSummary
        : `${name} failed (exit ${String(exitCode)}, timedOut=${timedOut}, aborted=${aborted})`,
  })
}

/** Copy reviewer outcomes into the durable record without mutable aliases. */
function durableReviewers(
  outcomes: readonly ReviewerOutcome[],
): VerificationRecord['reviewers'] {
  return Object.freeze(outcomes.map(outcome => Object.freeze({
    role: outcome.role,
    verdict: outcome.verdict,
    summary: outcome.summary,
    findings: Object.freeze([...outcome.findings]),
    ...(outcome.childSessionId === undefined ? {} : { childSessionId: outcome.childSessionId }),
  })))
}

/** Aggregate deterministic checks and independent reviewer lanes conservatively. */
function verificationVerdict(
  checks: readonly VerificationRecord['checks'][number][],
  reviewers: readonly VerificationRecord['reviewers'][number][],
): VerificationRecord['verdict'] {
  if (checks.some(check => !check.passed)) return 'fail'
  if (reviewers.some(reviewer => reviewer.verdict === 'error')) return 'error'
  if (reviewers.some(reviewer => reviewer.verdict === 'fail')) return 'fail'
  if (reviewers.some(reviewer => reviewer.verdict === 'inconclusive')) return 'inconclusive'
  return 'pass'
}

/** Build the complete bounded record required by the durable completion gate. */
function verificationRecord(
  attempt: number,
  startedAt: number,
  candidateSummary: string,
  checks: readonly VerificationRecord['checks'][number][],
  reviewers: readonly VerificationRecord['reviewers'][number][],
): VerificationRecord {
  const verdict = verificationVerdict(checks, reviewers)
  const findings = [
    ...checks.filter(check => !check.passed).map(check => check.summary),
    ...reviewers.flatMap(reviewer => reviewer.findings),
  ]
  const summary = verdict === 'pass'
    ? `Independent verification passed: ${candidateSummary}`
    : verdict === 'error'
      ? 'Independent verification could not complete because a reviewer failed.'
      : `Independent verification returned ${verdict}; repair the recorded findings.`
  return Object.freeze({
    attempt,
    startedAt,
    finishedAt: Date.now(),
    verdict,
    summary,
    findings: Object.freeze(findings.length === 0 && verdict !== 'pass'
      ? ['Verification did not produce a conclusive passing result.']
      : findings),
    checks: Object.freeze([...checks]),
    reviewers: Object.freeze([...reviewers]),
  })
}

/** Copy model task input into the durable graph vocabulary. */
function plannedTasks(tasks: readonly {
  id: string
  title: string
  description: string
  acceptanceCriteria: readonly string[]
  dependencies?: readonly string[] | undefined
}[]): readonly PlannedTaskInput[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    ...(task.dependencies === undefined ? {} : { dependencies: task.dependencies }),
  }))
}

/** Normalize model evidence into detached durable values. */
function runEvidence(items: readonly {
  kind: RunEvidence['kind']
  ref: string
  summary: string
}[]): readonly RunEvidence[] {
  return items.map(item => ({ kind: item.kind, ref: item.ref, summary: item.summary }))
}

/** Convert durable reviewer rows to mutable canonical JSON arrays. */
function reviewerJson(reviewers: VerificationRecord['reviewers']): JsonValue[] {
  return reviewers.map(reviewer => ({
    role: reviewer.role,
    verdict: reviewer.verdict,
    summary: reviewer.summary,
    findings: [...reviewer.findings],
    ...(reviewer.childSessionId === undefined ? {} : { childSessionId: reviewer.childSessionId }),
  }))
}

/** Key one dynamic Package receipt. */
function packageKey(pluginId: string, packageId: string): string {
  return `${pluginId}\u0000${packageId}`
}

/** Return the exact live Goal/lease pair that currently carries Autopilot authority. */
function authorizedPair(ctx: Context, agent: Agent) {
  const lease = ctx.autonomy.get(agent)
  const goal = ctx.goals.get(agent)
  if (lease === undefined || goal === undefined || goal.id !== lease.goalId
    || lease.activation !== 'armed' || goal.activation !== 'armed'
    || (lease.phase !== 'running' && lease.phase !== 'verifying')
    || goal.phase !== 'active') return undefined
  return { lease, goal }
}

/** Refuse completion while any managed auxiliary ledger remains unresolved. */
function assertAuxiliaryQuiescent(ctx: Context, agent: Agent, lease: AutonomyLeaseView): void {
  const blockers: string[] = []
  for (const thread of ctx.get('autopilotTeam')?.listRun(String(agent.id), lease.id, lease.generation) ?? []) {
    if (thread.phase !== 'settled' && thread.phase !== 'failed') {
      blockers.push(`team:${thread.taskId}:${thread.phase}`)
    }
  }
  for (const loop of ctx.get('autopilotRalph')?.listRun(String(agent.id), lease.id, lease.generation) ?? []) {
    if (loop.phase !== 'completed' && loop.phase !== 'blocked' && loop.phase !== 'failed'
      && loop.phase !== 'cancelled') {
      blockers.push(`ralph:${loop.taskId}:${loop.phase}`)
    }
  }
  for (const workflow of ctx.get('autopilotWorkflows')?.listRun(
    String(agent.id), lease.id, lease.generation,
  ) ?? []) {
    if (workflow.phase !== 'completed' && workflow.phase !== 'partial-failure'
      && workflow.phase !== 'cancelled' && workflow.phase !== 'error') {
      blockers.push(`workflow:${workflow.workflowId}:${workflow.phase}`)
    }
  }
  for (const mission of ctx.get('autopilotMissions')?.listRun(
    String(agent.id), lease.id, lease.generation,
  ) ?? []) {
    if (mission.phase !== 'passed') blockers.push(`mission:${mission.missionId}:${mission.phase}`)
  }
  if (blockers.length > 0) {
    throw new Error(`autopilot_verify requires quiescent managed workers: ${blockers.join(', ')}`)
  }
}

/** Return the armed durable run whose native child starts require attribution. */
function activeAutopilotLease(ctx: Context, agent: Agent) {
  const lease = ctx.autonomy.get(agent)
  if (lease === undefined || lease.activation !== 'armed'
    || (lease.phase !== 'running' && lease.phase !== 'verifying')) return undefined
  return lease
}

/** Cancel model work and durably contain one native child that bypassed orchestration. */
function failUnmanagedSubagentStart(ctx: Context, agent: Agent, info: SubagentRunInfo): void {
  const lease = activeAutopilotLease(ctx, agent)
  if (lease === undefined) return
  const reason = `unmanaged subagent start ${JSON.stringify(String(info.runId))} published child `
    + `${JSON.stringify(String(info.id))} through provider ${JSON.stringify(info.provider)}`
  agent.cancel({ kind: 'hook', reason: 'dsh-autopilot unmanaged subagent start' }, { keepInbox: true })
  void ctx.autonomy.markNeedsAttention({
    runId: lease.id,
    generation: lease.generation,
    revision: lease.revision,
    sessionId: String(agent.id),
  }, reason).catch((error: unknown) => {
    ctx.logger.error(`dsh-autopilot: ${reason}; could not persist needs-attention: ${String(error)}`)
  })
}

/** Fail closed when native Goal state stops matching an armed durable run. */
function reconcileAuthorizedPair(ctx: Context, agent: Agent, source: string): Promise<void> | undefined {
  const lease = ctx.autonomy.get(agent)
  if (lease === undefined || lease.activation !== 'armed'
    || (lease.phase !== 'running' && lease.phase !== 'verifying')
    || authorizedPair(ctx, agent) !== undefined) return undefined
  const goal = ctx.goals.get(agent)
  const reason = `native Goal diverged from the armed Autopilot run (${source}; Goal ${goal?.phase ?? 'absent'}/${goal?.activation ?? 'absent'})`
  agent.cancel({ kind: 'hook', reason: 'dsh-autopilot Goal reconciliation' }, { keepInbox: true })
  return ctx.autonomy.markNeedsAttention({
    runId: lease.id,
    generation: lease.generation,
    revision: lease.revision,
    sessionId: String(agent.id),
  }, reason).catch((error: unknown) => {
    ctx.logger.error(`dsh-autopilot: failed to persist Goal reconciliation: ${String(error)}`)
  })
}

/** Identify native scheduling or child-control tools outside the durable task ledger. */
function isUnmanagedOrchestrationTool(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
    || name === 'workflow' || name === 'ralph' || name === 'schedule_create'
    || name === 'send_message' || name === 'interrupt_agent'
}

/** Build the monotonic autonomy guard. */
function guardExecution(
  ctx: Context,
  exec: ToolExecution,
): string | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const lease = ctx.autonomy.get(agent)
  if (lease === undefined || lease.activation !== 'armed'
    || (lease.phase !== 'running' && lease.phase !== 'verifying')) return undefined
  if (authorizedPair(ctx, agent) === undefined) {
    if (exec.name.startsWith('autopilot_') || exec.name === 'cordis_define'
      || exec.name === 'cordis_run' || exec.name === 'cordis_stop' || exec.name === 'cordis_undefine'
      || isUnmanagedOrchestrationTool(exec.name)
      || (exec.name === 'update_goal' && isRecord(exec.arguments)
        && (exec.arguments['action'] === 'complete' || exec.arguments['action'] === 'blocked'))) {
      return 'Autopilot is fail-closed because its native Goal is absent, disarmed, or no longer active.'
    }
    return undefined
  }

  if (lease.phase === 'verifying' && exec.name !== 'autopilot_verify') {
    return 'Autopilot verification is in progress; no additional tool may start until it settles.'
  }

  if (isUnmanagedOrchestrationTool(exec.name)) {
    return 'Autopilot requires managed delegation through autopilot_delegate so every worker is attributed to the durable task graph and budget.'
  }

  if (lease.selfModification === 'host-only'
    && (exec.name === 'cordis_define' || exec.name === 'cordis_run'
      || exec.name === 'cordis_stop' || exec.name === 'cordis_undefine')) {
    return 'This Host-only Autopilot run uses the durable autopilot_cordis_apply/remove lifecycle. '
      + 'Native Cordis mutation is unavailable until Autopilot pauses or ends.'
  }

  if (exec.name === 'update_goal' && isRecord(exec.arguments)
    && (exec.arguments['action'] === 'complete' || exec.arguments['action'] === 'blocked')) {
    return 'Autopilot completion and blocking are controller-owned. Call autopilot_verify or report the blocker through the task graph.'
  }

  if (exec.name === 'cordis_define') {
    if (lease.selfModification === 'off') return 'Autopilot policy disables dynamic Cordis definitions.'
    if (lease.dynamicPackages >= lease.maxDynamicPackages) {
      return `Autopilot dynamic Package budget exhausted (${lease.maxDynamicPackages}).`
    }
  }

  if (exec.name === 'cordis_run') {
    if (lease.selfModification === 'off') return 'Autopilot policy disables dynamic Cordis activation.'
  }
  return undefined
}

/** Return a canonical tool denial from the final atomic budget check. */
function autonomyDenial(message: string): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message,
      info: { name: 'AutonomyPolicyError', code: 'AUTONOMY_POLICY_DENIED' },
    },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

/** Register the managed Cordis surface only while the native Host runner exists. */
function applyDynamicSurface(
  ctx: Context,
  resolved: ResolvedConfig,
  publish: (
    controller: DynamicExtensionController | undefined,
    cleanup: DynamicCleanupGate | undefined,
  ) => void,
): void {
  const dynamicExtensions = new DynamicExtensionController(ctx, resolved.forbiddenDynamicServices)
  const shared = SHARED_DYNAMIC_SURFACE_STATES.get(ctx.root) ?? {
    hostPackages: new Map<Agent, Map<string, string>>(),
    cleanupDebts: new Map<Agent, DynamicCleanupDebt>(),
  }
  SHARED_DYNAMIC_SURFACE_STATES.set(ctx.root, shared)
  const { hostPackages, cleanupDebts } = shared
  const pendingDefinitions = new Map<Agent, number>()

  const cleanupNativePackages = async (agent: Agent, runId: string): Promise<void> => {
    const packages = hostPackages.get(agent)
    if (packages === undefined) return
    const pluginIds = new Set<string>()
    for (const [key, ownerRunId] of packages) {
      /* v8 ignore else -- a failed old-run cleanup blocks replacement, so this Agent map cannot mix run ids. */
      if (runId.length === 0 || ownerRunId === runId) {
        pluginIds.add(key.slice(0, key.indexOf('\u0000')))
      }
    }
    const failures: unknown[] = []
    for (const pluginId of pluginIds) {
      try {
        await ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(pluginId))
      } catch (error: unknown) {
        failures.push(error)
        continue
      }
      for (const [key, ownerRunId] of packages) {
        if (key.startsWith(`${pluginId}\u0000`) && (runId.length === 0 || ownerRunId === runId)) {
          packages.delete(key)
        }
      }
    }
    if (packages.size === 0) hostPackages.delete(agent)
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to retract ${failures.length} native Host Plugin contribution(s)`)
    }
  }

  const cleanupRun = async (
    agent: Agent,
    view: AutonomyLeaseView,
  ): Promise<void> => {
    const existingDebt = cleanupDebts.get(agent)
    const targetRunId = existingDebt?.runId ?? view.id
    const results = await Promise.allSettled([
      dynamicExtensions.cleanup(agent, targetRunId),
      cleanupNativePackages(agent, targetRunId),
    ])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length === 0) {
      if (cleanupDebts.get(agent)?.runId === targetRunId) cleanupDebts.delete(agent)
      return
    }
    const reason = `dynamic cleanup failed after ${view.phase}: ${failures.map(String).join('; ')}`
    cleanupDebts.set(agent, Object.freeze({ runId: targetRunId, reason }))
    const goal = ctx.goals.get(agent)
    if (goal?.id === view.goalId && goal.activation === 'armed') ctx.goals.disarm(agent)
    if (view.phase === 'needs-attention') throw new AggregateError(failures, reason)
    await ctx.autonomy.markNeedsAttention({
      runId: view.id,
      generation: view.generation,
      revision: view.revision,
      sessionId: String(agent.id),
    }, reason)
  }

  publish(dynamicExtensions, Object.freeze({
    cleanup: cleanupRun,
    debt: (agent: Agent) => cleanupDebts.get(agent),
  }))

  ctx.effect(() => async () => {
    const failures: unknown[] = []
    const agents = new Set<Agent>([
      ...ctx.agents.roots(),
      ...hostPackages.keys(),
      ...cleanupDebts.keys(),
    ])
    for (const agent of agents) {
      const view = ctx.autonomy.get(agent)
      if (view === undefined) continue
      try {
        await cleanupRun(agent, view)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    try {
      await dynamicExtensions.dispose()
    } catch (error: unknown) {
      failures.push(error)
    }
    for (const agent of hostPackages.keys()) {
      try {
        await cleanupNativePackages(agent, '')
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    pendingDefinitions.clear()
    publish(undefined, undefined)
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose dynamic Cordis surface')
  })

  ctx.on('tools/execute', async (
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    const agent = exec.agent
    if (agent === undefined || exec.name !== 'cordis_define') return next()
    const lease = ctx.autonomy.get(agent)
    if (lease === undefined || lease.activation !== 'armed' || lease.phase !== 'running') return next()
    const admittedRunId = lease.id
    const pending = pendingDefinitions.get(agent) ?? 0
    if (lease.dynamicPackages + pending >= lease.maxDynamicPackages) {
      return autonomyDenial(
        `Autopilot dynamic Package budget exhausted (${lease.maxDynamicPackages}).`,
      )
    }
    pendingDefinitions.set(agent, pending + 1)
    try {
      const result = await next()
      if (result.isError || !isRecord(result.value)) return result
      const pluginId = result.value['pluginId']
      const packageId = result.value['packageId']
      const hasClientHalf = result.value['hasClientHalf']
      if (typeof pluginId !== 'string' || typeof packageId !== 'string') return result
      const current = ctx.autonomy.get(agent)
      if (current === undefined || current.id !== admittedRunId
        || current.activation !== 'armed' || current.phase !== 'running') {
        await ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(pluginId))
        return autonomyDenial('The Autopilot run changed while cordis_define was executing; the definition was rolled back.')
      }
      try {
        await ctx.autonomy.recordDynamicPackage(agent)
      } catch (error: unknown) {
        await ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(pluginId))
        return autonomyDenial(
          `Dynamic Package accounting failed and the definition was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (hasClientHalf === false) {
        const packages = hostPackages.get(agent) ?? new Map<string, string>()
        packages.set(packageKey(pluginId, packageId), admittedRunId)
        hostPackages.set(agent, packages)
      }
      return result
    } finally {
      const admitted = pendingDefinitions.get(agent)!
      const remaining = admitted - 1
      if (remaining === 0) pendingDefinitions.delete(agent)
      else pendingDefinitions.set(agent, remaining)
    }
  })

  ctx.on('autonomy/changed', async ({ agent, view }) => {
    if ((view.phase === 'running' || view.phase === 'verifying') && !cleanupDebts.has(agent)) return
    await cleanupRun(agent, view)
  })

  ctx.on('agent/disposed', async ({ agent }) => {
    const lease = ctx.autonomy.get(agent)
    const runId = lease?.id ?? ''
    const results = await Promise.allSettled([
      dynamicExtensions.cleanup(agent, runId),
      cleanupNativePackages(agent, runId),
    ])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length > 0) {
      const reason = `Agent disposal left dynamic Host code active: ${failures.map(String).join('; ')}`
      if (lease !== undefined && lease.phase !== 'completed' && lease.phase !== 'revoked') {
        try {
          await ctx.autonomy.markNeedsAttention({
            runId: lease.id,
            generation: lease.generation,
            revision: lease.revision,
            sessionId: String(agent.id),
          }, reason)
        } catch (error: unknown) {
          ctx.logger.error(`dsh-autopilot: ${reason}; could not persist needs-attention: ${String(error)}`)
        }
      } else {
        ctx.logger.error(`dsh-autopilot: ${reason}`)
      }
    }
    pendingDefinitions.delete(agent)
  })

  ctx.tools.register(defineTool({
    name: 'autopilot_cordis_apply',
    description: 'Define, activate, inspect, audit, and recover one Host-only Cordis extension version. This never creates Client code or bypasses DSH approval.',
    parameters: {
      logicalId: {
        type: 'string',
        required: true,
        description: 'Stable lowercase logical identity used across immutable versions and process recovery.',
      },
      name: { type: 'string', required: true, description: 'Human-readable Package name.' },
      purpose: { type: 'string', required: true, description: 'Specific missing leaf capability this extension supplies.' },
      hostCode: {
        type: 'string',
        required: true,
        description: 'Plain JavaScript async-function body returning a Cordis Plugin. Dynamic tools must use harness.defineTool with output.schema and output.render.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const result = await dynamicExtensions.apply(agent, args, AbortSignal.any([
        exec.signal,
        ctx.autonomy.signal(agent),
      ]))
      return {
        runId: result.runId,
        logicalId: result.logicalId,
        version: result.version,
        status: result.status,
        pluginId: result.pluginId,
        packageId: result.packageId,
        pluginRunId: result.pluginRunId,
        sourceSha256: result.sourceSha256,
        handlers: [...result.handlers],
        recovered: result.recovered,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_cordis_remove',
    description: 'Stop and undefine one durable Host-only Autopilot extension while retaining its source audit.',
    parameters: {
      logicalId: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      await dynamicExtensions.remove(agent, args.logicalId, args.reason)
      return statusValue(ctx, agent)
    },
  }))
}

/** Register model-visible policy, status, completion, and Host-only Cordis accounting. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const managedSubagentStarts = new ManagedSubagentStarts()
  const startSubagent = managedSubagentStarts.bind(ctx.subagents)
  const startContinuable = managedSubagentStarts.bindContinuable(ctx.subagents)
  const managedSubagentListeners = new Map<Agent, () => void>()
  let dynamicExtensions: DynamicExtensionController | undefined
  let dynamicCleanup: DynamicCleanupGate | undefined
  const goalCreationRestrictions = new Map<Agent, () => void>()
  const goalReconciliations = new Map<Agent, Promise<void>>()

  const reconcileManagedSubagentListener = (agent: Agent): void => {
    const current = managedSubagentListeners.get(agent)
    if (activeAutopilotLease(ctx, agent) === undefined) {
      current?.()
      managedSubagentListeners.delete(agent)
      return
    }
    if (current !== undefined) return
    const dispose = agent.ctx.on('subagent/start', (info) => {
      if (managedSubagentStarts.owns(agent)) return
      failUnmanagedSubagentStart(ctx, agent, info)
    })
    managedSubagentListeners.set(agent, dispose)
  }

  const reconcilePair = (agent: Agent, source: string): Promise<void> | undefined => {
    const current = goalReconciliations.get(agent)
    if (current !== undefined) return current
    const task = reconcileAuthorizedPair(ctx, agent, source)
    if (task === undefined) return undefined
    goalReconciliations.set(agent, task)
    void task.finally(() => {
      if (goalReconciliations.get(agent) === task) goalReconciliations.delete(agent)
    })
    return task
  }

  ctx.inject(['dynamicCordisRunner'], (dynamicCtx) => {
    applyDynamicSurface(dynamicCtx, resolved, (controller, cleanup) => {
      dynamicExtensions = controller
      dynamicCleanup = cleanup
    })
  })
  ctx.inject(['autopilotTeam'], (teamCtx) => {
    applyTeamTools(teamCtx, { startContinuable })
    registerRecoveryContribution(teamCtx, 'tool-team')
  })
  ctx.inject(['autopilotRalph'], (ralphCtx) => {
    applyRalphTools(ralphCtx, { startSubagent })
    registerRecoveryContribution(ralphCtx, 'tool-ralph')
  })
  ctx.inject(['autopilotMissions'], (missionCtx) => {
    applyMissionTool(missionCtx, {
      routes: resolved.taskRoutes,
      routingPreference: resolved.taskRoutingPreference,
      toolAllowlist: resolved.taskWorkerToolAllowlist,
      startSubagent,
    })
    registerRecoveryContribution(missionCtx, 'tool-mission')
  })
  ctx.inject(['autopilotWorkflows'], (workflowCtx) => {
    applyWorkflowTools(workflowCtx, {
      startWorkflow: (request) => {
        const engine = workflowCtx.get('agentPresets')
          ?.serviceFor(request.parent, 'workflowEngine')
          ?? workflowCtx.get('workflowEngine')
        if (engine === undefined) {
          throw new Error('managed Workflow requires workflowEngine in the current Agent preset or Host')
        }
        return managedSubagentStarts.bindWorkflow(engine)(request)
      },
    })
    registerRecoveryContribution(workflowCtx, 'tool-workflow')
  })

  const reconcileGoalCreation = (agent: Agent): void => {
    const pair = authorizedPair(ctx, agent)
    const goal = pair?.goal
    const lease = pair?.lease
    const current = goalCreationRestrictions.get(agent)
    if (goal !== undefined && lease !== undefined && goal.id === lease.goalId
      && lease.activation === 'armed'
      && (lease.phase === 'running' || lease.phase === 'verifying')) {
      if (current === undefined && ctx.tools.get('create_goal') !== undefined) {
        goalCreationRestrictions.set(agent, agent.ctx.tools.restrict({ deny: ['create_goal'] }))
      }
      return
    }
    current?.()
    goalCreationRestrictions.delete(agent)
  }

  ctx.systemPrompt.context({
    name: 'dsh-autopilot:autopilot',
    order: 160,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const pair = authorizedPair(ctx, agent)
      if (pair === undefined) return ''
      const { lease, goal } = pair
      return [
        'Autopilot is authorized for the current Goal.',
        'The human command already created and armed this Goal; do not call create_goal. Read state with get_autopilot.',
        `Continue until the objective is independently verified; ${lease.remainingActiveMs} ms of active time remains.`,
        `Goal rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}.`,
        `Durable task plan: ${lease.plan === undefined ? 'not created' : `${lease.plan.tasks.filter(task => task.status === 'completed').length}/${lease.plan.tasks.length} complete`}.`,
        `Subagent budget: ${lease.subagentsStarted}/${lease.maxSubagents}; at most ${lease.maxConcurrentSubagents} in one batch.`,
        `Dynamic Cordis policy: ${lease.selfModification}; Packages: ${lease.dynamicPackages}/${lease.maxDynamicPackages}.`,
        `Verification baseline: ${lease.verificationBaseline === undefined
          ? 'preparing before this step'
          : lease.verificationBaseline.kind === 'project'
            ? `${lease.verificationBaseline.checks.length} frozen project check(s)`
            : `reviewer-only (${lease.verificationBaseline.reason})`}.`,
        `Canonical flow: ${lease.flow.stage} (cycle ${lease.flow.cycle}).`,
        modelCheckpoint(goal, lease),
        'Record the interview and run plan hardening with autopilot_flow. Create the durable plan with autopilot_plan between those stages; only then claim and settle tasks through autopilot_task or autopilot_delegate.',
        'Use a managed Team for a durable multi-message worker and managed Ralph only for a bounded fresh-context loop attached to one dependency-ready leaf task.',
        'Use a managed Workflow only for several dependency-ready tasks that fit a deployment-fixed fan-out profile; workflow scripts cannot be supplied in tool input.',
        'Use autopilot_mission to import and run a short workspace Markdown prompt queue sequentially; plan is a dry run and must pass canonical hardening before resume.',
        'Use autopilot_specialist for a budgeted, fresh-context, read-only planning or review consultation from the packaged specialist catalog.',
        'Do not call update_goal with action complete. Submit a concise summary and concrete evidence to autopilot_verify.',
        'A failed verifier result ends this turn and starts another Goal round with its findings.',
      ].join(' ')
    },
  })

  ctx.tools.guard((exec) => {
    const debt = exec.agent === undefined ? undefined : dynamicCleanup?.debt(exec.agent)
    return debt === undefined
      ? guardExecution(ctx, exec)
      : `Autopilot dynamic cleanup is still pending for run ${debt.runId}: ${debt.reason}`
  })

  ctx.on('autonomy/changed', ({ agent }) => {
    reconcileManagedSubagentListener(agent)
  })
  for (const agent of ctx.agents.roots()) reconcileManagedSubagentListener(agent)

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const debt = dynamicCleanup?.debt(agent)
    if (debt !== undefined) {
      const view = ctx.autonomy.get(agent)
      if (view === undefined) throw new Error(`dynamic cleanup debt has no owning Autopilot run: ${debt.reason}`)
      await dynamicCleanup?.cleanup(agent, view)
      const remaining = dynamicCleanup?.debt(agent)
      /* v8 ignore next -- this package's cleanup callback clears its debt on success and rejects otherwise. */
      if (remaining !== undefined) throw new Error(`dynamic cleanup remains pending: ${remaining.reason}`)
    }
    await reconcilePair(agent, 'agent/pre-step')
    reconcileGoalCreation(agent)
    reconcileManagedSubagentListener(agent)
    const controller = dynamicExtensions
    if (authorizedPair(ctx, agent) !== undefined) {
      await ensureVerificationPolicy(ctx, resolved, agent)
      await ensureVerificationBaseline(ctx, resolved, agent)
      if (controller !== undefined) await controller.ensureRehydrated(agent)
    }
    return next()
  })

  ctx.on('goal/changed', ({ agent, change }) => {
    void reconcilePair(agent, `goal/${change.operation}`)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    goalCreationRestrictions.get(agent)?.()
    goalCreationRestrictions.delete(agent)
    goalReconciliations.delete(agent)
    managedSubagentListeners.get(agent)?.()
    managedSubagentListeners.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of goalCreationRestrictions.values()) dispose()
    goalCreationRestrictions.clear()
    for (const dispose of managedSubagentListeners.values()) dispose()
    managedSubagentListeners.clear()
  })
  ctx.tools.register(defineTool({
    name: 'get_autopilot',
    description: 'Read the current Goal, Autopilot lease, budgets, frozen verification baseline, and self-modification policy.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute(_args, exec) {
      return Promise.resolve(statusValue(ctx, requireAgent(exec)))
    },
    isConcurrencySafe: () => true,
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_flow',
    description: 'Advance the durable canonical flow through interview and fixed Metis/Momus/Oracle plan hardening before execution.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'interview', 'harden'],
      },
      summary: {
        type: 'string',
        description: 'Required for interview; concise interpretation of the objective and constraints.',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required for interview; concrete decisions established before planning.',
      },
      openQuestions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional unresolved questions that do not prevent an initial plan.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      if (args.action === 'status') return statusValue(ctx, agent)
      if (args.action === 'interview') {
        if (args.summary === undefined || args.decisions === undefined) {
          throw new Error('autopilot_flow interview requires summary and decisions')
        }
        await ctx.autonomy.recordInterview(agent, {
          summary: args.summary,
          decisions: args.decisions,
          openQuestions: args.openQuestions ?? [],
        })
        return statusValue(ctx, agent)
      }
      const reviewing = await ctx.autonomy.beginPlanReview(agent)
      const plan = reviewing.plan!
      const reviewContext = JSON.stringify({
        parentExecutionSnapshot: {
          authority: 'host-supplied-parent-snapshot',
          childIsolation: 'The reviewer child has no parent Goal, lease, or parent tool registry. Do not query child-local Goal or Autopilot state and do not use the child tool list to challenge these parent facts.',
          goalId: reviewing.goalId,
          workspace: reviewing.verificationBaseline?.kind === 'project'
            ? reviewing.verificationBaseline.workspace
            : agent.session.header.cwd,
          availableTools: ctx.tools.schemas().map(schema => schema.name).filter(name => (
            name === 'bash'
            || name === 'get_autopilot'
            || name.startsWith('autopilot_')
          )),
          flow: {
            stage: reviewing.flow.stage,
            cycle: reviewing.flow.cycle,
            interviewRecordedAt: reviewing.flow.interview?.recordedAt,
            planReviewRecordedAt: reviewing.flow.planReview?.recordedAt,
          },
        },
        objective: ctx.goals.get(agent)?.objective,
        plan: {
          revision: plan.revision,
          intent: plan.intent,
          acceptanceCriteria: plan.acceptanceCriteria,
          tasks: plan.tasks.map(task => ({
            id: task.id,
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
            dependencies: task.dependencies,
          })),
        },
      })
      const roles = ['metis', 'momus', 'oracle'] as const
      const prompts = {
        metis: 'Treat the objective and parentExecutionSnapshot as authoritative. Your fresh child state and child tool list are intentionally isolated and are not evidence about the parent. Return concern only for a hidden requirement, ambiguity, or missing constraint that makes the supplied plan unsafe, unexecutable, or unverifiable. Return advice for optional refinements and execution-time checks.',
        momus: 'Treat the objective and parentExecutionSnapshot as authoritative. Your fresh child state and child tool list are intentionally isolated and are not evidence about the parent. Return concern only when vagueness, scope, verification, or dependencies make the supplied plan unsafe, unexecutable, or unverifiable. Return advice for optional hardening; do not require planning-time file inspection when an execution acceptance check is sufficient.',
        oracle: 'Treat the objective and parentExecutionSnapshot as authoritative. Your fresh child state and child tool list are intentionally isolated and are not evidence about the parent. Return concern only for a decisive architecture, lifecycle, persistence, security, or verification flaw that makes the supplied plan unsafe, unexecutable, or unverifiable. Return advice for optional refinements and execution-time checks.',
      }
      const reviewers: AutopilotPlanReviewVerdict[] = []
      for (const role of roles) {
        const outcome = await consultSpecialist(ctx, {
          parent: agent,
          specialistId: role,
          prompt: prompts[role],
          context: reviewContext,
          routes: resolved.taskRoutes,
          startSubagent,
          signal: AbortSignal.any([exec.signal, ctx.autonomy.signal(agent)]),
        })
        reviewers.push({
          role,
          verdict: outcome.verdict,
          summary: outcome.summary,
          findings: outcome.findings,
          recommendations: outcome.recommendations,
          ...(outcome.childSessionId === undefined ? {} : { childSessionId: outcome.childSessionId }),
        })
      }
      const settled = await ctx.autonomy.settlePlanReview(agent, plan.revision, reviewers)
      if (settled.flow.stage !== 'execution') exec.concludeTurn()
      return statusValue(ctx, agent)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_plan',
    description: 'Create, extend, or reorder the durable Autopilot dependency graph. Replacing is allowed only before work starts.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['replace', 'add', 'reorder'],
        description: 'replace creates the initial plan, add appends tasks, and reorder changes stable display/dispatch order.',
      },
      intent: {
        type: 'string',
        enum: ['implementation', 'investigation', 'repair', 'performance', 'delivery', 'planning'],
        description: 'Required intent classification for replace; it selects the bounded execution workflow without changing authorization.',
      },
      acceptanceCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required whole-goal criteria for replace.',
      },
      tasks: {
        type: 'array',
        description: 'Input tasks for replace or add. Supply only id, title, description, acceptanceCriteria, and dependencies; status, attempts, and evidence are output-only runtime fields.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            description: { type: 'string', required: true },
            acceptanceCriteria: { type: 'array', required: true, items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      order: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every existing task id exactly once for reorder.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      if (args.action === 'replace') {
        if (args.intent === undefined || args.acceptanceCriteria === undefined || args.tasks === undefined) {
          throw new Error('autopilot_plan replace requires intent, acceptanceCriteria, and tasks')
        }
        await ctx.autonomy.setPlan(agent, args.acceptanceCriteria, plannedTasks(args.tasks), args.intent)
      } else if (args.action === 'add') {
        if (args.tasks === undefined) throw new Error('autopilot_plan add requires tasks')
        await ctx.autonomy.addTasks(agent, plannedTasks(args.tasks))
      } else {
        if (args.order === undefined) throw new Error('autopilot_plan reorder requires order')
        await ctx.autonomy.reorderTasks(agent, args.order)
      }
      return statusValue(ctx, agent)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_task',
    description: 'Apply one durable task transition. Completion requires inspectable evidence and dependencies must already be complete.',
    parameters: {
      taskId: { type: 'string', required: true },
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'complete', 'block', 'fail', 'reopen'],
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              required: true,
              enum: ['file', 'command', 'test', 'url', 'note', 'subagent'],
            },
            ref: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
      },
      reason: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      await ctx.autonomy.updateTask(agent, args.taskId, args.action as RunTaskAction, {
        ...(args.evidence === undefined ? {} : { evidence: runEvidence(args.evidence) }),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      })
      return statusValue(ctx, agent)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_specialist',
    description: 'List packaged specialist/category definitions or run one budgeted fresh-context read-only specialist consultation.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'consult'],
      },
      specialistId: {
        type: 'string',
        enum: SPECIALIST_CATALOG.map(item => item.id),
        description: 'Required for consult; an exact packaged specialist id.',
      },
      prompt: {
        type: 'string',
        description: 'Required for consult; the decision or review question.',
      },
      context: {
        type: 'string',
        description: 'Optional bounded context treated as untrusted task data.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      if (args.action === 'list') return specialistCatalogJson()
      if (args.specialistId === undefined || args.prompt === undefined) {
        throw new Error('autopilot_specialist consult requires specialistId and prompt')
      }
      const agent = requireAgent(exec)
      const result = await consultSpecialist(ctx, {
        parent: agent,
        specialistId: args.specialistId,
        prompt: args.prompt,
        ...(args.context === undefined ? {} : { context: args.context }),
        routes: resolved.taskRoutes,
        startSubagent,
        signal: AbortSignal.any([exec.signal, ctx.autonomy.signal(agent)]),
      })
      return specialistConsultationJson(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_delegate',
    description: 'Atomically claim dependency-ready Autopilot tasks, run bounded native DSH subagents in parallel, and durably settle every result.',
    parameters: {
      assignments: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            role: { type: 'string', required: true },
            prompt: { type: 'string', required: true },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const results = await delegateTaskBatch(ctx, {
        parent: agent,
        assignments: args.assignments,
        routes: resolved.taskRoutes,
        routingPreference: resolved.taskRoutingPreference,
        toolAllowlist: resolved.taskWorkerToolAllowlist,
        startSubagent,
        signal: AbortSignal.any([exec.signal, ctx.autonomy.signal(agent)]),
      })
      return delegationJson(results)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'autopilot_verify',
    description: 'Submit completion evidence to frozen project checks and deployment-fixed checks. Passing checks complete the Goal; failures start a repair round.',
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'Concise explanation of how the current workspace satisfies the Goal.',
      },
      evidence: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Concrete files, commands, test results, or other inspectable evidence.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const summary = args.summary.trim()
      const evidence = args.evidence.map(item => item.trim()).filter(item => item.length > 0)
      if (summary.length === 0) throw new Error('verification summary must not be empty')
      const goal = ctx.goals.get(agent)
      const lease = ctx.autonomy.get(agent)
      if (goal === undefined || lease === undefined || goal.id !== lease.goalId
        || goal.phase !== 'active' || goal.activation !== 'armed') {
        throw new Error('autopilot_verify requires the current armed Goal and its active lease')
      }
      assertAuxiliaryQuiescent(ctx, agent, lease)
      const policy = await ensureVerificationPolicy(ctx, resolved, agent)
      if (evidence.length < policy.minimumEvidenceItems) {
        throw new Error(`verification requires at least ${policy.minimumEvidenceItems} non-empty evidence item(s)`)
      }

      const startedAt = Date.now()
      const detailedChecks: Array<{ [key: string]: JsonValue }> = []
      let reviewerOutcomes: readonly ReviewerOutcome[] = Object.freeze([])
      let verificationSettled = false
      try {
        const baseline = await ensureVerificationBaseline(ctx, resolved, agent)
        const verifying = await ctx.autonomy.beginVerification(agent, { summary, evidence })
        ctx.goals.disarm(agent)
        const signal = AbortSignal.any([exec.signal, ctx.autonomy.signal(agent)])
        const plan = verifying.plan
        /* v8 ignore next -- beginVerification proves a complete task plan exists. */
        if (plan === undefined) throw new Error('verified Autopilot run has no durable task plan')
        const before = baseline.kind === 'project'
          ? await validateProjectManifests(baseline.workspace, baseline.manifests)
          : undefined
        let manifestsValidAfterChecks = true
        if (before?.valid === false) {
          manifestsValidAfterChecks = false
          detailedChecks.push(baselineFailure(before.findings))
        } else {
          for (const check of verifierChecks(resolved, baseline, policy)) {
            const spec = ctx.shell.resolve({
              command: check.command,
              ...(check.workdir === undefined ? {} : { workdir: check.workdir }),
              timeoutMs: check.timeoutMs,
              stdoutMaxBytes: Math.max(1024, policy.maxOutputChars * 4),
              signal,
            })
            const result = await ctx.shell.run(spec)
            detailedChecks.push(checkResult(check, result, policy.maxOutputChars))
          }
          if (baseline.kind === 'project') {
            const after = await validateProjectManifests(baseline.workspace, baseline.manifests)
            manifestsValidAfterChecks = after.valid
            if (!after.valid) detailedChecks.push(baselineFailure(after.findings))
          }
        }
        const checksBeforeReview = Object.freeze(detailedChecks.map(durableCheck))
        await goalReconciliations.get(agent)
        const goalAfterChecksBeforeReview = ctx.goals.get(agent)
        if (goalAfterChecksBeforeReview === undefined || goalAfterChecksBeforeReview.id !== goal.id
          || goalAfterChecksBeforeReview.revision !== goal.revision
          || goalAfterChecksBeforeReview.phase !== 'active') {
          throw new Error('Goal changed while verification was running')
        }
        const leaseAfterChecksBeforeReview = ctx.autonomy.get(agent)
        if (leaseAfterChecksBeforeReview === undefined || leaseAfterChecksBeforeReview.id !== lease.id
          || leaseAfterChecksBeforeReview.generation !== lease.generation
          || leaseAfterChecksBeforeReview.phase !== 'verifying') {
          throw new Error('Autopilot run changed while verification checks were running')
        }
        await ctx.autonomy.recordSubagentStarts(agent, policy.reviewers.length)
        reviewerOutcomes = await runReviewerQuorum(ctx, {
          objective: goal.objective,
          parentGoalId: goal.id,
          plan,
          candidate: { summary, evidence, submittedAt: startedAt },
          checks: checksBeforeReview,
          reviewers: resolved.reviewers,
          maxConcurrency: Math.min(verifying.maxConcurrentSubagents, policy.reviewers.length),
          parent: agent,
          startSubagent,
          signal,
        })
        const reviewerRows = durableReviewers(reviewerOutcomes)
        await goalReconciliations.get(agent)
        const goalAfterReview = ctx.goals.get(agent)
        const leaseAfterReview = ctx.autonomy.get(agent)
        if (goalAfterReview === undefined || goalAfterReview.id !== goal.id
          || goalAfterReview.revision !== goal.revision || goalAfterReview.phase !== 'active'
          || leaseAfterReview === undefined || leaseAfterReview.id !== lease.id
          || leaseAfterReview.generation !== lease.generation || leaseAfterReview.phase !== 'verifying') {
          throw new Error('Goal or Autopilot run changed while code review was running')
        }
        const codeReviewVerdict = verificationVerdict(Object.freeze([]), reviewerRows)
        if (codeReviewVerdict !== 'pass') {
          const reviewRecord = verificationRecord(
            verifying.verificationAttempts,
            startedAt,
            summary,
            checksBeforeReview,
            reviewerRows,
          )
          if (reviewRecord.verdict === 'error') {
            await ctx.autonomy.verificationErrored(agent, reviewRecord)
            verificationSettled = true
            throw new Error(reviewRecord.summary)
          }
          await ctx.autonomy.verificationFailed(agent, reviewRecord)
          verificationSettled = true
          const current = ctx.goals.get(agent)
          if (current?.id === goal.id && current.phase === 'active') {
            ctx.goals.resume(agent, goalRef(current))
          }
          exec.concludeTurn()
          return {
            verdict: reviewRecord.verdict,
            summary: reviewRecord.summary,
            evidence,
            checks: detailedChecks,
            reviewers: reviewerJson(reviewRecord.reviewers),
            findings: [...reviewRecord.findings],
            next: 'A new canonical planning round will repair the recorded code-review findings.',
          }
        }
        await ctx.autonomy.beginQualityAssurance(agent)
        if (baseline.kind === 'project' && manifestsValidAfterChecks) {
          const afterReview = await validateProjectManifests(baseline.workspace, baseline.manifests)
          if (!afterReview.valid) detailedChecks.push(baselineFailure(afterReview.findings))
        }
        const goalAfterChecks = ctx.goals.get(agent)
        if (goalAfterChecks === undefined || goalAfterChecks.id !== goal.id
          || goalAfterChecks.revision !== goal.revision || goalAfterChecks.phase !== 'active') {
          throw new Error('Goal changed while verification was running')
        }
        const checks = Object.freeze(detailedChecks.map(durableCheck))
        const record = verificationRecord(
          verifying.verificationAttempts,
          startedAt,
          summary,
          checks,
          durableReviewers(reviewerOutcomes),
        )
        if (record.verdict === 'fail' || record.verdict === 'inconclusive') {
          await ctx.autonomy.verificationFailed(agent, record)
          verificationSettled = true
          const current = ctx.goals.get(agent)
          if (current?.id === goal.id && current.phase === 'active') {
            ctx.goals.resume(agent, goalRef(current))
          }
          exec.concludeTurn()
          return {
            verdict: record.verdict,
            summary: record.summary,
            evidence,
            checks: detailedChecks,
            reviewers: reviewerJson(record.reviewers),
            findings: [...record.findings],
            next: 'A new Goal round will repair the recorded findings.',
          }
        }
        const beforeCleanup = ctx.autonomy.get(agent)
        if (beforeCleanup === undefined || beforeCleanup.id !== lease.id
          || beforeCleanup.generation !== lease.generation || beforeCleanup.phase !== 'verifying') {
          throw new Error('Autopilot run changed before dynamic cleanup could start')
        }
        await dynamicCleanup?.cleanup(agent, beforeCleanup)
        const afterCleanup = ctx.autonomy.get(agent)
        if (afterCleanup === undefined || afterCleanup.id !== beforeCleanup.id
          || afterCleanup.generation !== beforeCleanup.generation || afterCleanup.phase !== 'verifying') {
          const reason = afterCleanup?.reason === undefined ? '' : `: ${afterCleanup.reason}`
          throw new Error(`Dynamic extension cleanup prevented completion${reason}`)
        }

        const current = ctx.goals.get(agent)
        if (current === undefined || current.id !== goal.id || current.phase !== 'active') {
          throw new Error('Goal changed while verification was running')
        }
        await ctx.autonomy.beginFinalization(agent, record)
        verificationSettled = true
        const finalized = await ctx.autonomy.finalizeCompletion(agent, goalRef(current))
        const notice = completionMessage(finalized.notice)
        await ctx.autonomy.registerCompletionDelivery({
          runId: finalized.view.id,
          generation: finalized.view.generation,
          revision: finalized.view.revision,
          sessionId: String(agent.id),
        }, agent, notice.id)
        agent.followup(notice)
        exec.concludeTurn()
        return {
          verdict: 'pass',
          summary: record.summary,
          evidence,
          checks: detailedChecks,
          reviewers: reviewerJson(record.reviewers),
          goal: {
            id: String(finalized.goal.id),
            revision: finalized.goal.revision,
            phase: finalized.goal.phase,
          },
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const attemptsExhausted = error instanceof AutonomyError
          && error.code === 'AUTONOMY_VERIFICATION_EXHAUSTED'
        await goalReconciliations.get(agent)
        const currentLease = ctx.autonomy.get(agent)
        if (!verificationSettled && currentLease?.phase === 'verifying') {
          const record: VerificationRecord = Object.freeze({
            attempt: currentLease.verificationAttempts,
            startedAt,
            finishedAt: Date.now(),
            verdict: 'error',
            summary: `Verifier infrastructure error: ${message}`,
            findings: Object.freeze([message]),
            checks: Object.freeze(detailedChecks.map(durableCheck)),
            reviewers: durableReviewers(reviewerOutcomes),
          })
          await ctx.autonomy.verificationErrored(agent, record)
          verificationSettled = true
        } else if (!verificationSettled && attemptsExhausted && currentLease?.phase === 'running') {
          await ctx.autonomy.pause(agent, message)
        }
        const current = ctx.goals.get(agent)
        const mayBlockGoal = currentLease === undefined
          || currentLease.phase === 'running'
          || currentLease.phase === 'verifying'
          || currentLease.phase === 'paused'
        if (mayBlockGoal && current?.id === goal.id && current.phase === 'active') {
          try {
            ctx.goals.block(agent, goalRef(current), {
              code: attemptsExhausted
                ? 'verification-attempts-exhausted'
                : 'verifier-error',
              message,
            })
          } catch (blockError: unknown) {
            ctx.logger.warn(`dsh-autopilot: could not block Goal after verifier error: ${String(blockError)}`)
            ctx.goals.disarm(agent)
          }
        }
        throw error
      }
    },
  }))
  registerRecoveryContribution(ctx, 'tools')
}
