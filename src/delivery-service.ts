/** Isolated Git worktree lifecycle and fail-closed delivery planning. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import s from '@deepseek-ai/schemastery'
import {
  DELIVERY_STATE_VERSION,
  MAX_DELIVERY_AUDIT_BYTES,
  MAX_DELIVERY_AUDIT_RECORDS,
  MAX_DELIVERY_VERIFICATIONS,
  DeliveryError,
  deliveryGitRef,
  deliveryPathIsWithin,
  deliveryText,
} from './delivery-state.ts'
import type {
  DeliveryHandoff,
  DeliveryPlan,
  DeliverySnapshot,
  DeliveryVerification,
} from './delivery-state.ts'
import { DurableDeliveryStore } from './delivery-store.ts'
import type { AutonomyLeaseView } from './service.ts'

const execFileAsync = promisify(execFile)

/** Default whole-snapshot rows retained by one isolated delivery generation. */
export const DEFAULT_DELIVERY_MAX_AUDIT_RECORDS = 512

/** Default aggregate UTF-8 JSON retained by one isolated delivery generation. */
export const DEFAULT_DELIVERY_MAX_AUDIT_BYTES = 67_108_864

/** Deployment settings for isolated worktrees and Git subprocess limits. */
export interface DeliveryServiceConfig {
  readonly worktreeRoot?: string
  readonly maxVerificationRecords?: number
  readonly maxAuditRecords?: number
  readonly maxAuditBytes?: number
  readonly gitTimeoutMs?: number
  readonly gitOutputMaxBytes?: number
}

interface ResolvedDeliveryServiceConfig {
  readonly worktreeRoot?: string
  readonly maxVerificationRecords: number
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly gitTimeoutMs: number
  readonly gitOutputMaxBytes: number
}

/** Input for creating the next isolated generation of one repository. */
export interface DeliveryCreateInput {
  readonly repository: string
  readonly expectedGeneration: number
  readonly baseBranch?: string
}

/** Input for one compare-and-set worktree checkpoint. */
export interface DeliveryCheckpointInput {
  readonly repository: string
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly verification?: {
    readonly verdict: DeliveryVerification['verdict']
    readonly summary: string
    readonly checks?: readonly {
      readonly name: string
      readonly passed: boolean
      readonly summary: string
    }[]
  }
  readonly handoff?: {
    readonly summary: string
    readonly nextAction: string
  }
}

/** Input for a non-executing delivery plan. */
export interface DeliveryPrepareInput {
  readonly repository: string
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly commitMessage: string
  readonly remote?: string
  readonly targetBranch?: string
  readonly pullRequestTitle?: string
  readonly pullRequestBody?: string
}

/** Input for safe removal of an exact clean worktree generation. */
export interface DeliveryCleanupInput {
  readonly repository: string
  readonly expectedGeneration: number
  readonly expectedRevision: number
}

/** Scalar-only request presented to a Host-owned human authorization provider. */
export interface DeliveryHostCleanupRequest {
  readonly repository: string
  readonly deliveryId: string
  readonly generation: number
  readonly revision: number
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly parentRunGeneration: number
  readonly parentGoalId: string
  readonly phase: DeliverySnapshot['phase']
  readonly worktreePath: string
  readonly branch: string
  readonly head: string
  readonly present: boolean
}

/** Host seam for explicit cleanup after the exact parent run can no longer be armed. */
export interface DeliveryServiceHost {
  authorizeCleanup(request: DeliveryHostCleanupRequest): Promise<boolean>
}

/** Human-originated token format reserved for a future host authorization provider. */
export interface HumanDeliveryAuthorization {
  readonly source: 'human'
  readonly token: string
  readonly deliveryId: string
  readonly generation: number
  readonly revision: number
  readonly operations: readonly ('push' | 'pull-request')[]
  readonly expiresAt: number
}

/** Live observation returned without rewriting durable state. */
export interface DeliveryObservation {
  readonly present: boolean
  readonly head?: string
  readonly branch?: string
  readonly dirty?: boolean
  readonly conflicted?: boolean
  readonly drifted: boolean
}

/** Durable state paired with a current read-only worktree observation. */
export interface DeliveryStatus {
  readonly snapshot: DeliverySnapshot
  readonly observation: DeliveryObservation
}

interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

/** Narrow process seam: consumers can request Git argv, never an executable or shell source. */
export interface DeliveryGitRunner {
  run(repository: string, argv: readonly string[]): Promise<GitResult>
}

function fixedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
}

/** Node runner that always invokes the literal `git` executable with shell mode disabled. */
export class FixedGitRunner implements DeliveryGitRunner {
  /**
   * @param timeoutMs - Hard subprocess timeout.
   * @param outputMaxBytes - Combined per-stream capture ceiling.
   */
  constructor(
    private readonly timeoutMs: number,
    private readonly outputMaxBytes: number,
  ) {}

  async run(repository: string, argv: readonly string[]): Promise<GitResult> {
    if (argv.length === 0 || argv.some(value => value.includes('\u0000'))) {
      throw new DeliveryError('Git argv is empty or contains NUL', 'DELIVERY_INVALID')
    }
    try {
      const result = await execFileAsync('git', [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'credential.interactive=never',
        '-C', repository,
        ...argv,
      ], {
        encoding: 'utf8',
        env: fixedGitEnvironment(),
        maxBuffer: this.outputMaxBytes,
        timeout: this.timeoutMs,
        windowsHide: true,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as Error & { readonly stderr?: string }
      const stderr = failure.stderr?.trim()
      const detail = (stderr === undefined || stderr.length === 0 ? failure.message : stderr).slice(0, 2_000)
      throw new DeliveryError(`Git ${argv[0]} failed: ${detail}`, 'DELIVERY_GIT_FAILED')
    }
  }
}

interface WorktreeObservation {
  readonly present: boolean
  readonly head?: string
  readonly branch?: string
  readonly dirty?: boolean
  readonly conflicted?: boolean
}

interface DeliveryParentAuthority {
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly parentRunGeneration: number
  readonly parentGoalId: string
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function normalizeExpected(value: number, label: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new DeliveryError(`${label} must be a safe ${allowZero ? 'non-negative' : 'positive'} integer`, 'DELIVERY_INVALID')
  }
  return value
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new DeliveryError(
      `${label} must be a safe integer from ${minimum} through ${maximum}`,
      'DELIVERY_INVALID',
    )
  }
  return resolved
}

function deliveryRemote(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new DeliveryError('remote must be a safe Git remote name', 'DELIVERY_INVALID')
  }
  return normalized
}

function nextTime(snapshot: DeliverySnapshot): number {
  return Math.max(Date.now(), snapshot.updatedAt + 1)
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Host service that owns isolated worktree state and fixed Git invocations. */
export class DeliveryService extends Service {
  static inject = ['autonomy', 'goals', 'storageDomain']

  static Config: s<DeliveryServiceConfig> = s.object({
    worktreeRoot: s.string(),
    maxVerificationRecords: s.number().step(1).min(1).max(MAX_DELIVERY_VERIFICATIONS).default(16),
    maxAuditRecords: s.number().step(1).min(1).max(MAX_DELIVERY_AUDIT_RECORDS)
      .default(DEFAULT_DELIVERY_MAX_AUDIT_RECORDS),
    maxAuditBytes: s.number().step(1).min(1).max(MAX_DELIVERY_AUDIT_BYTES)
      .default(DEFAULT_DELIVERY_MAX_AUDIT_BYTES),
    gitTimeoutMs: s.number().step(1).min(1_000).max(300_000).default(30_000),
    gitOutputMaxBytes: s.number().step(1).min(1_024).max(16_777_216).default(1_048_576),
  })

  private store: DurableDeliveryStore | undefined
  private operationTail: Promise<void> = Promise.resolve()
  private readonly resolved: ResolvedDeliveryServiceConfig
  private readonly git: DeliveryGitRunner
  private readonly host: DeliveryServiceHost | undefined

  /**
   * @param ctx - Cordis owner carrying storage-domain.
   * @param config - Worktree and subprocess limits.
   * @param git - Fixed-executable Git runner; intended for deterministic embedding tests.
   * @param host - Optional Host-owned human cleanup authorization seam.
   */
  constructor(
    ctx: Context,
    config: DeliveryServiceConfig = {},
    git?: DeliveryGitRunner,
    host?: DeliveryServiceHost,
  ) {
    super(ctx, 'autopilotDelivery')
    if (config.worktreeRoot !== undefined && !isAbsolute(config.worktreeRoot)) {
      throw new DeliveryError('worktreeRoot must be an absolute path', 'DELIVERY_INVALID')
    }
    this.resolved = {
      ...(config.worktreeRoot === undefined ? {} : { worktreeRoot: resolve(config.worktreeRoot) }),
      maxVerificationRecords: configuredInteger(
        config.maxVerificationRecords, 16, 'maxVerificationRecords', 1, MAX_DELIVERY_VERIFICATIONS,
      ),
      maxAuditRecords: configuredInteger(
        config.maxAuditRecords,
        DEFAULT_DELIVERY_MAX_AUDIT_RECORDS,
        'maxAuditRecords',
        1,
        MAX_DELIVERY_AUDIT_RECORDS,
      ),
      maxAuditBytes: configuredInteger(
        config.maxAuditBytes,
        DEFAULT_DELIVERY_MAX_AUDIT_BYTES,
        'maxAuditBytes',
        1,
        MAX_DELIVERY_AUDIT_BYTES,
      ),
      gitTimeoutMs: configuredInteger(config.gitTimeoutMs, 30_000, 'gitTimeoutMs', 1_000, 300_000),
      gitOutputMaxBytes: configuredInteger(
        config.gitOutputMaxBytes, 1_048_576, 'gitOutputMaxBytes', 1_024, 16_777_216,
      ),
    }
    this.git = git ?? new FixedGitRunner(this.resolved.gitTimeoutMs, this.resolved.gitOutputMaxBytes)
    this.host = host
  }

  /** Open and recover the durable delivery audit before consumers activate. */
  protected async [Service.init](): Promise<void> {
    const store = await DurableDeliveryStore.open(this.ctx)
    this.store = store
    this.ctx.effect(() => async () => {
      await this.operationTail
      /* v8 ignore else -- this effect owns the opened store slot. */
      if (this.store === store) this.store = undefined
      await store.close()
    }, 'dsh-autopilot.deliveryStoreClose')
  }

  /** Create a clean isolated branch/worktree for the exact armed parent run. */
  create(parent: Agent, input: DeliveryCreateInput): Promise<DeliverySnapshot> {
    normalizeExpected(input.expectedGeneration, 'expectedGeneration', true)
    return this.serialized(async () => {
      const authority = this.requireArmedParent(parent)
      const repository = await this.canonicalRepository(input.repository)
      const current = this.requireStore().get(repository)
      const actualGeneration = current?.generation ?? 0
      if (actualGeneration !== input.expectedGeneration) {
        throw new DeliveryError(
          `delivery generation conflict; expected ${input.expectedGeneration}, current is ${actualGeneration}`,
          'DELIVERY_CONFLICT',
        )
      }
      if (current !== undefined && current.phase !== 'cleaned') {
        throw new DeliveryError('repository already has a live isolated delivery', 'DELIVERY_CONFLICT')
      }
      const baseline = await this.inspectRepository(repository)
      if (baseline.dirty) {
        throw new DeliveryError('repository baseline is dirty; commit or stash it before start-work', 'DELIVERY_DIRTY_BASELINE')
      }
      const baseBranch = input.baseBranch === undefined
        ? await this.currentBranch(repository)
        : deliveryGitRef(input.baseBranch, 'baseBranch')
      await this.git.run(repository, ['check-ref-format', '--branch', baseBranch])
      const baseHead = (await this.git.run(repository, [
        'rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`,
      ])).stdout.trim()
      const worktreeRoot = await this.resolveWorktreeRoot(repository)
      await this.assertNoUnknownDeliveryArtifacts(repository, worktreeRoot)
      const deliveryId = randomUUID()
      const generation = input.expectedGeneration + 1
      const branch = `dsh-autopilot/${generation}-${deliveryId.slice(0, 12)}`
      const worktreePath = join(worktreeRoot, deliveryId)
      /* v8 ignore next -- a UUID path component cannot escape the canonical controlled root. */
      if (!deliveryPathIsWithin(worktreeRoot, worktreePath)) {
        throw new DeliveryError('generated worktree path escaped its controlled root', 'DELIVERY_INVALID')
      }
      await this.git.run(repository, [
        'worktree', 'add', '--no-track', '-b', branch, worktreePath, baseHead,
      ])
      const now = Date.now()
      const snapshot: DeliverySnapshot = Object.freeze({
        version: DELIVERY_STATE_VERSION,
        deliveryId,
        ...authority,
        repository,
        generation,
        revision: 1,
        maxAuditRecords: this.resolved.maxAuditRecords,
        maxAuditBytes: this.resolved.maxAuditBytes,
        phase: 'active',
        createdAt: now,
        updatedAt: now,
        baseBranch,
        baseHead,
        worktreeRoot,
        worktreePath,
        branch,
        head: baseHead,
        dirty: false,
        conflicted: false,
        verifications: Object.freeze([]),
      })
      try {
        this.assertSameAuthority(parent, authority)
        return await this.requireStore().create(input.expectedGeneration, snapshot)
      } catch (error) {
        await this.rollbackCreatedWorktree(repository, worktreePath, branch, baseHead)
        throw error
      }
    })
  }

  /** Read durable state together with current worktree drift, without mutating either. */
  status(repositoryInput: string): Promise<DeliveryStatus | undefined> {
    return this.serialized(async () => {
      const repository = await this.canonicalRepository(repositoryInput)
      const snapshot = this.requireStore().get(repository)
      if (snapshot === undefined) return undefined
      const observed = await this.inspectWorktree(snapshot)
      return Object.freeze({
        snapshot,
        observation: Object.freeze({
          ...observed,
          drifted: observed.present
            ? observed.head !== snapshot.head || observed.branch !== snapshot.branch
              || observed.dirty !== snapshot.dirty || observed.conflicted !== snapshot.conflicted
            : snapshot.phase !== 'cleaned',
        }),
      })
    })
  }

  /** Return current delivery snapshots for trusted read-only Host diagnostics. */
  list(): readonly DeliverySnapshot[] {
    return this.requireStore().list()
  }

  /** Persist exact head/dirty/conflict state plus bounded check observations and handoff evidence. */
  checkpoint(parent: Agent, input: DeliveryCheckpointInput): Promise<DeliverySnapshot> {
    this.validateMutationRevision(input)
    const verification = input.verification === undefined
      ? undefined
      : this.verification(input.verification)
    const handoff = input.handoff === undefined ? undefined : this.handoff(input.handoff)
    return this.serialized(async () => {
      const authority = this.requireArmedParent(parent)
      const repository = await this.canonicalRepository(input.repository)
      const current = this.currentExact(parent, authority, repository, input.expectedGeneration, input.expectedRevision)
      const observed = await this.inspectWorktree(current)
      const now = nextTime(current)
      if (!observed.present || observed.head === undefined || observed.branch === undefined
        || observed.dirty === undefined || observed.conflicted === undefined) {
        this.assertSameAuthority(parent, authority)
        return this.requireStore().appendIfCurrent('attention', current, Object.freeze({
          ...current,
          revision: current.revision + 1,
          phase: 'needs-attention',
          updatedAt: now,
          plan: undefined,
          reason: 'isolated worktree is missing',
        }))
      }
      const verifications = verification === undefined
        ? current.verifications
        : Object.freeze([...current.verifications, { ...verification, recordedAt: now }])
      if (verifications.length > this.resolved.maxVerificationRecords) {
        throw new DeliveryError(
          `delivery reached its ${this.resolved.maxVerificationRecords} verification checkpoint ceiling`,
          'DELIVERY_LIMIT',
        )
      }
      const reason = observed.branch !== current.branch
        ? `worktree branch changed from ${current.branch} to ${observed.branch}`
        : observed.conflicted ? 'worktree contains unresolved merge conflicts' : undefined
      this.assertSameAuthority(parent, authority)
      return this.requireStore().appendIfCurrent(reason === undefined ? 'checkpoint' : 'attention', current, Object.freeze({
        ...current,
        revision: current.revision + 1,
        phase: reason === undefined ? 'active' : 'needs-attention',
        updatedAt: now,
        head: observed.head,
        branch: current.branch,
        dirty: observed.dirty,
        conflicted: observed.conflicted,
        verifications,
        ...(handoff === undefined ? {} : { handoff: { ...handoff, recordedAt: now } }),
        plan: undefined,
        ...(reason === undefined ? { reason: undefined } : { reason }),
      }))
    })
  }

  /** Persist a fixed-argv commit/push/PR proposal without executing any delivery mutation. */
  prepareDelivery(parent: Agent, input: DeliveryPrepareInput): Promise<DeliverySnapshot> {
    this.validateMutationRevision(input)
    const commitMessage = deliveryText(input.commitMessage, 'commitMessage', 500)
    const remote = deliveryRemote(input.remote ?? 'origin')
    const title = deliveryText(input.pullRequestTitle ?? commitMessage, 'pullRequestTitle', 500)
    const body = deliveryText(input.pullRequestBody ?? 'Prepared by dsh-autopilot.', 'pullRequestBody', 8_000)
    return this.serialized(async () => {
      const authority = this.requireArmedParent(parent)
      const repository = await this.canonicalRepository(input.repository)
      const current = this.currentExact(parent, authority, repository, input.expectedGeneration, input.expectedRevision)
      if (current.phase !== 'active') {
        throw new DeliveryError('delivery plan requires an active checkpoint', 'DELIVERY_CONFLICT')
      }
      const observed = await this.inspectWorktree(current)
      if (!observed.present || observed.head !== current.head || observed.branch !== current.branch
        || observed.dirty !== current.dirty || observed.conflicted !== current.conflicted) {
        throw new DeliveryError('worktree changed after its durable checkpoint', 'DELIVERY_CONFLICT')
      }
      if (!current.dirty && current.head === current.baseHead) {
        throw new DeliveryError('delivery plan requires a change from the base revision', 'DELIVERY_INVALID')
      }
      const latestVerification = current.verifications.at(-1)
      if (latestVerification?.verdict !== 'pass') {
        throw new DeliveryError('delivery plan requires the latest checkpoint check observation to report pass', 'DELIVERY_PERMISSION_DENIED')
      }
      const targetBranch = deliveryGitRef(input.targetBranch ?? current.baseBranch, 'targetBranch')
      const commitArgv: readonly (readonly string[])[] = current.dirty
        ? Object.freeze([
            Object.freeze(['git', '-C', current.worktreePath, 'add', '--all']),
            Object.freeze(['git', '-C', current.worktreePath, 'commit', '--message', commitMessage]),
          ])
        : Object.freeze([])
      const now = nextTime(current)
      const plan: DeliveryPlan = Object.freeze({
        createdAt: now,
        commit: Object.freeze({ required: current.dirty, message: commitMessage, argv: commitArgv }),
        push: Object.freeze({
          remote,
          branch: current.branch,
          argv: Object.freeze([
            'git', '-C', current.worktreePath, 'push', '--set-upstream', remote, current.branch,
          ]),
        }),
        pullRequest: Object.freeze({
          base: targetBranch,
          head: current.branch,
          title,
          body,
        }),
        requiresHumanAuthorization: Object.freeze(['push', 'pull-request'] as const),
      })
      this.assertSameAuthority(parent, authority)
      return this.requireStore().appendIfCurrent('prepare-delivery', current, Object.freeze({
        ...current,
        revision: current.revision + 1,
        phase: 'prepared',
        updatedAt: now,
        plan,
        reason: undefined,
      }))
    })
  }

  /** Remove an exact clean worktree under its still-armed parent run. The branch is retained. */
  cleanup(parent: Agent, input: DeliveryCleanupInput): Promise<DeliverySnapshot> {
    this.validateMutationRevision(input)
    return this.serialized(async () => {
      const authority = this.requireArmedParent(parent)
      const repository = await this.canonicalRepository(input.repository)
      const current = this.currentExact(parent, authority, repository, input.expectedGeneration, input.expectedRevision)
      const observed = await this.inspectWorktree(current)
      await this.assertCleanupSafe(repository, current, observed)
      this.assertSameAuthority(parent, authority)
      if (observed.present) {
        await this.git.run(repository, ['worktree', 'remove', current.worktreePath])
      }
      this.assertSameAuthority(parent, authority)
      return this.appendCleaned(current, 'cleanup')
    })
  }

  /**
   * Clean an abandoned exact generation only after a Host-owned provider confirms human authorization.
   * This method is deliberately absent from the model tool surface.
   */
  cleanupAbandoned(input: DeliveryCleanupInput): Promise<DeliverySnapshot> {
    this.validateMutationRevision(input)
    return this.serialized(async () => {
      if (this.host === undefined) {
        throw new DeliveryError(
          'abandoned cleanup requires a Host-owned human authorization provider',
          'DELIVERY_PERMISSION_DENIED',
        )
      }
      const repository = await this.canonicalRepository(input.repository)
      let current = this.deliveryCurrentExact(repository, input.expectedGeneration, input.expectedRevision)
      let observed = await this.inspectWorktree(current)
      await this.assertCleanupSafe(repository, current, observed)
      const authorized = await this.host.authorizeCleanup(Object.freeze({
        repository,
        deliveryId: current.deliveryId,
        generation: current.generation,
        revision: current.revision,
        parentSessionId: current.parentSessionId,
        parentRunId: current.parentRunId,
        parentRunGeneration: current.parentRunGeneration,
        parentGoalId: current.parentGoalId,
        phase: current.phase,
        worktreePath: current.worktreePath,
        branch: current.branch,
        head: current.head,
        present: observed.present,
      }))
      if (!authorized) {
        throw new DeliveryError('human authorization denied abandoned cleanup', 'DELIVERY_PERMISSION_DENIED')
      }
      current = this.deliveryCurrentExact(repository, input.expectedGeneration, input.expectedRevision)
      observed = await this.inspectWorktree(current)
      await this.assertCleanupSafe(repository, current, observed)
      if (observed.present) {
        await this.git.run(repository, ['worktree', 'remove', current.worktreePath])
      }
      return this.appendCleaned(current, 'host-cleanup')
    })
  }

  /**
   * Fail closed until a host-owned human-token verifier and mutation executor are installed.
   * @param _repository - Exact repository requested for delivery.
   * @param _authorization - Human-originated token that this version deliberately cannot consume.
   * @returns This version never returns.
   */
  executeExternalDelivery(
    _repository: string,
    _authorization: HumanDeliveryAuthorization,
  ): Promise<never> {
    return Promise.reject(new DeliveryError(
      'external commit/push/pull-request execution is disabled; a host-verified human authorization provider is required',
      'DELIVERY_PERMISSION_DENIED',
    ))
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(task)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private requireStore(): DurableDeliveryStore {
    /* v8 ignore next -- service injection activates only after Service.init completes. */
    if (this.store === undefined) throw new DeliveryError('delivery service is not initialized', 'DELIVERY_INVALID')
    return this.store
  }

  private validateMutationRevision(input: {
    readonly expectedGeneration: number
    readonly expectedRevision: number
  }): void {
    normalizeExpected(input.expectedGeneration, 'expectedGeneration', false)
    normalizeExpected(input.expectedRevision, 'expectedRevision', false)
  }

  private currentExact(
    parent: Agent,
    authority: DeliveryParentAuthority,
    repository: string,
    expectedGeneration: number,
    expectedRevision: number,
  ): DeliverySnapshot {
    this.assertSameAuthority(parent, authority)
    const current = this.deliveryCurrentExact(repository, expectedGeneration, expectedRevision)
    if (current.parentSessionId !== authority.parentSessionId
      || current.parentRunId !== authority.parentRunId
      || current.parentRunGeneration !== authority.parentRunGeneration
      || current.parentGoalId !== authority.parentGoalId) {
      throw new DeliveryError(
        'isolated delivery belongs to a different Autopilot parent run',
        'DELIVERY_PERMISSION_DENIED',
      )
    }
    return current
  }

  private deliveryCurrentExact(
    repository: string,
    expectedGeneration: number,
    expectedRevision: number,
  ): DeliverySnapshot {
    const current = this.requireStore().get(repository)
    if (current === undefined) throw new DeliveryError('repository has no isolated delivery', 'DELIVERY_NOT_FOUND')
    if (current.generation !== expectedGeneration || current.revision !== expectedRevision) {
      throw new DeliveryError(
        `delivery generation/revision conflict; current is ${current.generation}/${current.revision}`,
        'DELIVERY_CONFLICT',
      )
    }
    if (current.phase === 'cleaned') {
      throw new DeliveryError('isolated delivery is already cleaned', 'DELIVERY_CONFLICT')
    }
    return current
  }

  private async assertCleanupSafe(
    repository: string,
    current: DeliverySnapshot,
    observed: WorktreeObservation,
  ): Promise<void> {
    if (observed.present && (observed.dirty || observed.conflicted)) {
      throw new DeliveryError('cleanup refuses a dirty or conflicted worktree', 'DELIVERY_DIRTY_WORKTREE')
    }
    if (observed.present && observed.branch !== current.branch) {
      throw new DeliveryError('cleanup refuses a worktree on an unexpected branch', 'DELIVERY_CONFLICT')
    }
    if (observed.present && (observed.head !== current.head || observed.dirty !== current.dirty
      || observed.conflicted !== current.conflicted)) {
      throw new DeliveryError('cleanup refuses worktree state that changed after its checkpoint', 'DELIVERY_CONFLICT')
    }
    if (!observed.present) {
      if ((await this.registeredWorktreePaths(repository)).includes(current.worktreePath)) {
        throw new DeliveryError(
          'cleanup refuses a missing worktree that remains registered in Git metadata',
          'DELIVERY_CONFLICT',
        )
      }
      const branchHead = (await this.git.run(repository, [
        'rev-parse', '--verify', `refs/heads/${current.branch}^{commit}`,
      ])).stdout.trim()
      if (branchHead !== current.head) {
        throw new DeliveryError(
          'cleanup refuses a missing worktree whose retained branch changed after its checkpoint',
          'DELIVERY_CONFLICT',
        )
      }
    }
  }

  private appendCleaned(
    current: DeliverySnapshot,
    operation: 'cleanup' | 'host-cleanup',
  ): Promise<DeliverySnapshot> {
    const now = nextTime(current)
    return this.requireStore().appendIfCurrent(operation, current, Object.freeze({
      ...current,
      revision: current.revision + 1,
      phase: 'cleaned',
      updatedAt: now,
      dirty: false,
      conflicted: false,
      reason: undefined,
    }))
  }

  private requireArmedParent(parent: Agent): DeliveryParentAuthority {
    let lease: AutonomyLeaseView | undefined
    let goal: ReturnType<Context['goals']['get']>
    try {
      lease = this.ctx.autonomy.get(parent)
      goal = this.ctx.goals.get(parent)
    } catch {
      throw new DeliveryError(
        'delivery mutation requires a live parent Agent carrying the exact armed Autopilot run',
        'DELIVERY_PERMISSION_DENIED',
      )
    }
    if (lease === undefined || goal === undefined || goal.id !== lease.goalId
      || lease.activation !== 'armed' || goal.activation !== 'armed'
      || lease.phase !== 'running' || goal.phase !== 'active') {
      throw new DeliveryError(
        'delivery mutation requires the exact armed active Goal and running Autopilot lease',
        'DELIVERY_PERMISSION_DENIED',
      )
    }
    return this.authority(parent, lease)
  }

  private authority(parent: Agent, lease: AutonomyLeaseView): DeliveryParentAuthority {
    return Object.freeze({
      parentSessionId: String(parent.id),
      parentRunId: lease.id,
      parentRunGeneration: lease.generation,
      parentGoalId: String(lease.goalId),
    })
  }

  private assertSameAuthority(parent: Agent, expected: DeliveryParentAuthority): void {
    const current = this.requireArmedParent(parent)
    if (current.parentSessionId !== expected.parentSessionId
      || current.parentRunId !== expected.parentRunId
      || current.parentRunGeneration !== expected.parentRunGeneration
      || current.parentGoalId !== expected.parentGoalId) {
      throw new DeliveryError(
        'Autopilot parent run changed during the delivery operation',
        'DELIVERY_PERMISSION_DENIED',
      )
    }
  }

  private verification(input: NonNullable<DeliveryCheckpointInput['verification']>): Omit<DeliveryVerification, 'recordedAt'> {
    const checks = input.checks ?? []
    if (checks.length > 32) throw new DeliveryError('verification has more than 32 checks', 'DELIVERY_LIMIT')
    return Object.freeze({
      verdict: input.verdict,
      summary: deliveryText(input.summary, 'verification summary', 2_000),
      checks: Object.freeze(checks.map(check => Object.freeze({
        name: deliveryText(check.name, 'verification check name', 128),
        passed: check.passed,
        summary: deliveryText(check.summary, 'verification check summary', 1_000),
      }))),
    })
  }

  private handoff(input: NonNullable<DeliveryCheckpointInput['handoff']>): Omit<DeliveryHandoff, 'recordedAt'> {
    return Object.freeze({
      summary: deliveryText(input.summary, 'handoff summary', 4_000),
      nextAction: deliveryText(input.nextAction, 'handoff nextAction', 2_000),
    })
  }

  private async canonicalRepository(repositoryInput: string): Promise<string> {
    const requested = resolve(deliveryText(repositoryInput, 'repository', 4_096))
    let canonical: string
    try {
      canonical = await realpath(requested)
    } catch (error) {
      throw new DeliveryError(
        `repository does not exist: ${String(error)}`,
        'DELIVERY_INVALID',
      )
    }
    const topLevel = (await this.git.run(canonical, ['rev-parse', '--show-toplevel'])).stdout.trim()
    const canonicalTopLevel = await realpath(topLevel)
    if (canonical !== canonicalTopLevel) {
      throw new DeliveryError('repository must name the Git top-level directory, not a subdirectory', 'DELIVERY_INVALID')
    }
    return canonical
  }

  private async resolveWorktreeRoot(repository: string): Promise<string> {
    const repositoryHash = createHash('sha256').update(repository).digest('hex').slice(0, 12)
    const configured = this.resolved.worktreeRoot
    let requested: string
    let permitsRepositoryContainment = false
    if (configured === undefined) {
      const gitDirectory = await realpath(join(repository, '.git')).catch((error: unknown) => {
        throw new DeliveryError(
          `default worktreeRoot requires a normal repository .git directory: ${String(error)}`,
          'DELIVERY_INVALID',
        )
      })
      if (!(await stat(gitDirectory)).isDirectory() || !deliveryPathIsWithin(repository, gitDirectory)) {
        throw new DeliveryError(
          'default worktreeRoot requires .git to be a directory inside the session workspace; configure an absolute worktreeRoot for linked worktrees',
          'DELIVERY_INVALID',
        )
      }
      requested = join(gitDirectory, 'dsh-autopilot-worktrees', `${basename(repository)}-${repositoryHash}`)
      permitsRepositoryContainment = true
    } else {
      requested = configured
    }
    if (!permitsRepositoryContainment
      && (resolve(requested) === repository || deliveryPathIsWithin(repository, requested))) {
      throw new DeliveryError('worktreeRoot must be outside the source repository', 'DELIVERY_INVALID')
    }
    await mkdir(requested, { recursive: true })
    const canonical = await realpath(requested)
    if (!permitsRepositoryContainment
      && (canonical === repository || deliveryPathIsWithin(repository, canonical))) {
      throw new DeliveryError('worktreeRoot must be outside the source repository', 'DELIVERY_INVALID')
    }
    return canonical
  }

  private async currentBranch(repository: string): Promise<string> {
    const branch = (await this.git.run(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
    return deliveryGitRef(branch, 'current branch')
  }

  private async inspectRepository(repository: string): Promise<{ readonly dirty: boolean; readonly conflicted: boolean }> {
    const status = (await this.git.run(repository, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    const lines = status.split('\n').filter(Boolean)
    return {
      dirty: lines.length > 0,
      conflicted: lines.some(line => CONFLICT_CODES.has(line.slice(0, 2))),
    }
  }

  private async inspectWorktree(snapshot: DeliverySnapshot): Promise<WorktreeObservation> {
    if (!(await exists(snapshot.worktreePath))) return { present: false }
    /* v8 ignore next -- every stored/recovered snapshot passed assertDeliverySnapshot. */
    if (!deliveryPathIsWithin(snapshot.worktreeRoot, snapshot.worktreePath)) {
      throw new DeliveryError('durable worktree path escapes its controlled root', 'DELIVERY_INVALID')
    }
    const [canonicalRoot, canonicalWorktree] = await Promise.all([
      realpath(snapshot.worktreeRoot),
      realpath(snapshot.worktreePath),
    ])
    if (canonicalRoot !== resolve(snapshot.worktreeRoot)
      || canonicalWorktree !== resolve(snapshot.worktreePath)
      || !deliveryPathIsWithin(canonicalRoot, canonicalWorktree)) {
      throw new DeliveryError('worktree path or controlled root changed through a symlink', 'DELIVERY_INVALID')
    }
    const [headResult, branchResult, repository] = await Promise.all([
      this.git.run(canonicalWorktree, ['rev-parse', '--verify', 'HEAD']),
      this.git.run(canonicalWorktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.inspectRepository(canonicalWorktree),
    ])
    const topLevel = (await this.git.run(canonicalWorktree, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (await realpath(topLevel) !== canonicalWorktree) {
      throw new DeliveryError('stored worktree path is not its Git top-level directory', 'DELIVERY_INVALID')
    }
    return {
      present: true,
      head: headResult.stdout.trim(),
      branch: branchResult.stdout.trim(),
      dirty: repository.dirty,
      conflicted: repository.conflicted,
    }
  }

  private async assertNoUnknownDeliveryArtifacts(repository: string, worktreeRoot: string): Promise<void> {
    const history = this.requireStore().history(repository)
    const knownBranches = new Set(history.map(record => record.snapshot.branch))
    const branches = (await this.git.run(repository, [
      'for-each-ref', '--format=%(refname:short)', 'refs/heads/dsh-autopilot/',
    ])).stdout.split('\n').map(value => value.trim()).filter(Boolean)
    const unknownBranch = branches.find(branch => !knownBranches.has(branch))
    if (unknownBranch !== undefined) {
      throw new DeliveryError(
        `untracked Autopilot delivery branch ${JSON.stringify(unknownBranch)} requires human recovery`,
        'DELIVERY_CONFLICT',
      )
    }
    const controlledPath = (await this.registeredWorktreePaths(repository))
      .find(path => deliveryPathIsWithin(worktreeRoot, path))
    if (controlledPath !== undefined) {
      throw new DeliveryError(
        `controlled worktree ${JSON.stringify(controlledPath)} requires human recovery`,
        'DELIVERY_CONFLICT',
      )
    }
  }

  private async registeredWorktreePaths(repository: string): Promise<readonly string[]> {
    const output = (await this.git.run(repository, ['worktree', 'list', '--porcelain', '-z'])).stdout
    return Object.freeze(output.split('\u0000')
      .filter(field => field.startsWith('worktree '))
      .map(field => field.slice('worktree '.length)))
  }

  private async rollbackCreatedWorktree(
    repository: string,
    worktreePath: string,
    branch: string,
    baseHead: string,
  ): Promise<void> {
    try {
      const [head, observedBranch, state] = await Promise.all([
        this.git.run(worktreePath, ['rev-parse', '--verify', 'HEAD']),
        this.git.run(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        this.inspectRepository(worktreePath),
      ])
      if (head.stdout.trim() !== baseHead || observedBranch.stdout.trim() !== branch || state.dirty) return
    } catch {
      // An uninspectable worktree is retained so human recovery cannot lose unrecorded changes.
      return
    }
    try {
      await this.git.run(repository, ['worktree', 'remove', worktreePath])
    } catch {
      // A failed rollback remains visible to `git worktree list`; the original storage failure is authoritative.
      return
    }
    try {
      await this.git.run(repository, ['branch', '-d', branch])
    } catch {
      // The clean generated branch is retained when Git refuses safe deletion.
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotDelivery: DeliveryService
  }
}

export default DeliveryService
