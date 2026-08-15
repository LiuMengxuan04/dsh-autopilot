/** Durable state and validation for isolated Autopilot delivery work. */
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'

/** Current isolated-delivery record format. */
export const DELIVERY_STATE_VERSION = 2 as const

/** Maximum retained verification checkpoints for one delivery generation. */
export const MAX_DELIVERY_VERIFICATIONS = 32 as const

/** Hard storage ceiling for whole-snapshot rows in one delivery generation. */
export const MAX_DELIVERY_AUDIT_RECORDS = 4_096 as const

/** Hard storage ceiling for UTF-8 JSON across one delivery generation. */
export const MAX_DELIVERY_AUDIT_BYTES = 134_217_728 as const

/** Lifecycle of one isolated worktree. */
export type DeliveryPhase = 'active' | 'prepared' | 'needs-attention' | 'cleaned'

/** One bounded model-reported check observation attached to the exact worktree state. */
export interface DeliveryVerification {
  readonly verdict: 'pass' | 'fail' | 'inconclusive' | 'error'
  readonly summary: string
  readonly checks: readonly {
    readonly name: string
    readonly passed: boolean
    readonly summary: string
  }[]
  readonly recordedAt: number
}

/** Bounded continuation note for a later operator or agent turn. */
export interface DeliveryHandoff {
  readonly summary: string
  readonly nextAction: string
  readonly recordedAt: number
}

/** Fixed-argument delivery proposal. It is data, never an executable script. */
export interface DeliveryPlan {
  readonly createdAt: number
  readonly commit: {
    readonly required: boolean
    readonly message: string
    readonly argv: readonly (readonly string[])[]
  }
  readonly push: {
    readonly remote: string
    readonly branch: string
    readonly argv: readonly string[]
  }
  readonly pullRequest: {
    readonly base: string
    readonly head: string
    readonly title: string
    readonly body: string
  }
  readonly requiresHumanAuthorization: readonly ['push', 'pull-request']
}

/** Complete durable state for one isolated delivery generation. */
export interface DeliverySnapshot {
  readonly version: typeof DELIVERY_STATE_VERSION
  readonly deliveryId: string
  /** Exact Agent session that authorized this isolated delivery. */
  readonly parentSessionId: string
  /** Exact durable Autopilot run that authorized this isolated delivery. */
  readonly parentRunId: string
  /** Exact durable Autopilot run generation that authorized this isolated delivery. */
  readonly parentRunGeneration: number
  /** Exact native Goal paired with the parent Autopilot run. */
  readonly parentGoalId: string
  readonly repository: string
  readonly generation: number
  readonly revision: number
  /** Materialized whole-snapshot row ceiling for this generation. */
  readonly maxAuditRecords: number
  /** Materialized aggregate UTF-8 JSON ceiling for this generation. */
  readonly maxAuditBytes: number
  readonly phase: DeliveryPhase
  readonly createdAt: number
  readonly updatedAt: number
  readonly baseBranch: string
  readonly baseHead: string
  readonly worktreeRoot: string
  readonly worktreePath: string
  readonly branch: string
  readonly head: string
  readonly dirty: boolean
  readonly conflicted: boolean
  readonly verifications: readonly DeliveryVerification[]
  readonly handoff?: DeliveryHandoff | undefined
  readonly plan?: DeliveryPlan | undefined
  readonly reason?: string | undefined
}

/** Durable mutation categories for isolated delivery history. */
export type DeliveryOperation =
  | 'create'
  | 'checkpoint'
  | 'prepare-delivery'
  | 'attention'
  | 'cleanup'
  | 'host-cleanup'

/** One immutable whole-snapshot audit row. */
export interface DeliveryAuditRecord {
  readonly version: typeof DELIVERY_STATE_VERSION
  readonly operation: DeliveryOperation
  readonly time: number
  readonly snapshot: DeliverySnapshot
}

const boundedText = (maximum: number) => z.string().min(1).max(maximum)
const gitRef = z.string().min(1).max(255).regex(/^(?![./])(?!.*(?:\.\.|\/\.|\.\/|\/\/|@\{|\\))[A-Za-z0-9._/-]+(?<![/.])$/u)
const gitHead = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)

const verificationSchema: z.ZodType<DeliveryVerification> = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']),
  summary: boundedText(2_000),
  checks: z.array(z.object({
    name: boundedText(128),
    passed: z.boolean(),
    summary: boundedText(1_000),
  })).max(32),
  recordedAt: z.number().int().nonnegative(),
})

const handoffSchema: z.ZodType<DeliveryHandoff> = z.object({
  summary: boundedText(4_000),
  nextAction: boundedText(2_000),
  recordedAt: z.number().int().nonnegative(),
})

const argvSchema = z.array(z.string().max(4_096)).min(1).max(16)
const planSchema: z.ZodType<DeliveryPlan> = z.object({
  createdAt: z.number().int().nonnegative(),
  commit: z.object({
    required: z.boolean(),
    message: boundedText(500),
    argv: z.array(argvSchema).max(2),
  }),
  push: z.object({
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    branch: gitRef,
    argv: argvSchema,
  }),
  pullRequest: z.object({
    base: gitRef,
    head: gitRef,
    title: boundedText(500),
    body: boundedText(8_000),
  }),
  requiresHumanAuthorization: z.tuple([z.literal('push'), z.literal('pull-request')]),
})

/** Runtime schema for durable isolated-delivery snapshots. */
export const deliverySnapshotSchema: z.ZodType<DeliverySnapshot> = z.object({
  version: z.literal(DELIVERY_STATE_VERSION),
  deliveryId: z.string().uuid(),
  parentSessionId: boundedText(4_096),
  parentRunId: boundedText(4_096),
  parentRunGeneration: z.number().int().positive(),
  parentGoalId: boundedText(4_096),
  repository: boundedText(4_096),
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
  maxAuditRecords: z.number().int().positive().max(MAX_DELIVERY_AUDIT_RECORDS),
  maxAuditBytes: z.number().int().positive().max(MAX_DELIVERY_AUDIT_BYTES),
  phase: z.enum(['active', 'prepared', 'needs-attention', 'cleaned']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  baseBranch: gitRef,
  baseHead: gitHead,
  worktreeRoot: boundedText(4_096),
  worktreePath: boundedText(4_096),
  branch: gitRef,
  head: gitHead,
  dirty: z.boolean(),
  conflicted: z.boolean(),
  verifications: z.array(verificationSchema).max(MAX_DELIVERY_VERIFICATIONS),
  handoff: handoffSchema.optional(),
  plan: planSchema.optional(),
  reason: boundedText(2_000).optional(),
})

/** Runtime schema for durable isolated-delivery audit rows. */
export const deliveryAuditRecordSchema: z.ZodType<DeliveryAuditRecord> = z.object({
  version: z.literal(DELIVERY_STATE_VERSION),
  operation: z.enum(['create', 'checkpoint', 'prepare-delivery', 'attention', 'cleanup', 'host-cleanup']),
  time: z.number().int().nonnegative(),
  snapshot: deliverySnapshotSchema,
})

/** Stable failure raised by the isolated delivery subsystem. */
export class DeliveryError extends Error {
  /** Stable machine-routable failure category. */
  readonly code:
    | 'DELIVERY_INVALID'
    | 'DELIVERY_CONFLICT'
    | 'DELIVERY_NOT_FOUND'
    | 'DELIVERY_GIT_FAILED'
    | 'DELIVERY_DIRTY_BASELINE'
    | 'DELIVERY_DIRTY_WORKTREE'
    | 'DELIVERY_LIMIT'
    | 'DELIVERY_PERMISSION_DENIED'

  /**
   * @param message - Actionable failure detail.
   * @param code - Stable failure category.
   */
  constructor(message: string, code: DeliveryError['code']) {
    super(message)
    this.name = 'DeliveryError'
    this.code = code
  }
}

/** Validate one branch or remote-tracking component before it reaches Git argv. */
export function deliveryGitRef(value: string, label: string): string {
  const normalized = value.trim()
  if (!gitRef.safeParse(normalized).success || normalized.endsWith('.lock')) {
    throw new DeliveryError(`${label} is not a safe Git ref name`, 'DELIVERY_INVALID')
  }
  return normalized
}

/** Validate one bounded non-empty prose value. */
export function deliveryText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new DeliveryError(`${label} must contain 1-${maximum} characters`, 'DELIVERY_INVALID')
  }
  return normalized
}

/** Whether `candidate` is a strict descendant of the controlled root. */
export function deliveryPathIsWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`)
}

/** Reject internally inconsistent state even when its JSON fields parse. */
export function assertDeliverySnapshot(snapshot: DeliverySnapshot): void {
  deliverySnapshotSchema.parse(snapshot)
  if (snapshot.revision > snapshot.maxAuditRecords) {
    throw new DeliveryError('delivery revision exceeds its materialized audit-record ceiling', 'DELIVERY_LIMIT')
  }
  if (!deliveryPathIsWithin(snapshot.worktreeRoot, snapshot.worktreePath)) {
    throw new DeliveryError('worktree path escapes its controlled root', 'DELIVERY_INVALID')
  }
  if (snapshot.updatedAt < snapshot.createdAt) {
    throw new DeliveryError('delivery updatedAt precedes createdAt', 'DELIVERY_INVALID')
  }
  if (snapshot.conflicted && !snapshot.dirty) {
    throw new DeliveryError('a conflicted worktree must also be dirty', 'DELIVERY_INVALID')
  }
  if (snapshot.phase === 'prepared' && snapshot.plan === undefined) {
    throw new DeliveryError('prepared delivery is missing its plan', 'DELIVERY_INVALID')
  }
  if (snapshot.phase === 'needs-attention' && snapshot.reason === undefined) {
    throw new DeliveryError('attention delivery is missing its reason', 'DELIVERY_INVALID')
  }
  if (snapshot.phase !== 'needs-attention' && snapshot.reason !== undefined) {
    throw new DeliveryError('only an attention delivery may carry a reason', 'DELIVERY_INVALID')
  }
}
