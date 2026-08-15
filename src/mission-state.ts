/** Durable state and Markdown parsing for sequential Autopilot missions. */
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { RunEvidence } from './run-state.ts'

/** Current storage format for mission queue snapshots. */
export const MISSION_STATE_VERSION = 1 as const

/** Hard parser ceilings applied before mission state reaches persistence. */
export interface MissionParseLimits {
  readonly maxTasks: number
  readonly maxPromptChars: number
  readonly maxTotalPromptChars: number
}

/** One parsed mission prompt in source order. */
export interface ParsedMissionTask {
  readonly id: string
  readonly prompt: string
}

/** Immutable identity of the workspace file that created a mission. */
export interface MissionSource {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/** One task attempt retained in the durable mission summary. */
export interface MissionTaskAttempt {
  readonly number: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly status: 'passed' | 'failed' | 'blocked'
  readonly summary: string
  readonly evidence: readonly RunEvidence[]
  readonly childSessionId?: string | undefined
}

/** Operator-visible status of one sequential prompt. */
export type MissionTaskStatus =
  | 'planned'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'needs-human-review'

/** Complete durable state of one mission prompt. */
export interface MissionTaskSnapshot extends ParsedMissionTask {
  readonly status: MissionTaskStatus
  readonly attempts: readonly MissionTaskAttempt[]
  readonly updatedAt: number
  readonly reason?: string | undefined
}

/** Summary-level mission status derived from its task states. */
export type MissionPhase =
  | 'planned'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'needs-human-review'
  | 'needs-attention'

/** Whole materialized mission summary retained after every operation. */
export interface MissionSnapshot {
  readonly version: typeof MISSION_STATE_VERSION
  readonly parentSessionId: string
  readonly runId: string
  readonly generation: number
  readonly goalId: string
  readonly missionId: string
  readonly dagTaskId: string
  readonly revision: number
  readonly source: MissionSource
  readonly phase: MissionPhase
  readonly continueOnError: boolean
  readonly tasks: readonly MissionTaskSnapshot[]
  readonly maxAuditRecords: number
  readonly maxAuditBytes: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly reason?: string | undefined
}

/** Append-only operation names for the mission ledger. */
export type MissionOperation =
  | 'plan'
  | 'run-start'
  | 'task-start'
  | 'task-settle'
  | 'mark'
  | 'rerun-start'
  | 'finish'
  | 'attention'

/** One immutable mission ledger row. */
export interface MissionAuditRecord {
  readonly version: typeof MISSION_STATE_VERSION
  readonly operation: MissionOperation
  readonly time: number
  readonly snapshot: MissionSnapshot
}

/** Stable parser or state-machine failure. */
export class MissionStateError extends Error {
  /** Machine-routable failure category. */
  readonly code:
    | 'MISSION_FORMAT_INVALID'
    | 'MISSION_LIMIT_EXCEEDED'
    | 'MISSION_TRANSITION_INVALID'

  /**
   * @param message - Exact violated mission invariant.
   * @param code - Stable error category.
   */
  constructor(message: string, code: MissionStateError['code']) {
    super(message)
    this.name = 'MissionStateError'
    this.code = code
  }
}

const nonEmpty = z.string().min(1).max(8192)
const safeTime = z.number().int().nonnegative()
const positiveInteger = z.number().int().positive()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const evidenceSchema = z.object({
  kind: z.enum(['file', 'command', 'test', 'url', 'note', 'subagent']),
  ref: z.string().min(1).max(4096),
  summary: z.string().min(1).max(4096),
}).strict()

const attemptSchema: z.ZodType<MissionTaskAttempt> = z.object({
  number: positiveInteger,
  startedAt: safeTime,
  finishedAt: safeTime,
  status: z.enum(['passed', 'failed', 'blocked']),
  summary: nonEmpty,
  evidence: z.array(evidenceSchema).max(128),
  childSessionId: z.string().min(1).max(256).optional(),
}).strict().superRefine((attempt, context) => {
  if (attempt.finishedAt < attempt.startedAt) {
    context.addIssue({ code: 'custom', message: 'mission attempt finishes before it starts' })
  }
  if (attempt.status === 'passed' && attempt.evidence.length === 0) {
    context.addIssue({ code: 'custom', message: 'passed mission attempts require evidence' })
  }
})

const taskSchema: z.ZodType<MissionTaskSnapshot> = z.object({
  id: z.string().regex(/^task-[0-9]{3,6}$/u),
  prompt: z.string().min(1).max(65_536),
  status: z.enum(['planned', 'running', 'passed', 'failed', 'skipped', 'blocked', 'needs-human-review']),
  attempts: z.array(attemptSchema).max(4096),
  updatedAt: safeTime,
  reason: nonEmpty.optional(),
}).strict().superRefine((task, context) => {
  task.attempts.forEach((attempt, index) => {
    if (attempt.number !== index + 1) {
      context.addIssue({ code: 'custom', message: 'mission attempt numbers must be contiguous' })
    }
  })
  if (task.status === 'running' && task.reason !== undefined) {
    context.addIssue({ code: 'custom', message: 'running mission tasks cannot carry a terminal reason' })
  }
  if ((task.status === 'blocked' || task.status === 'needs-human-review') && task.reason === undefined) {
    context.addIssue({ code: 'custom', message: `${task.status} mission tasks require a reason` })
  }
})

/** Runtime validation for a complete durable mission summary. */
export const missionSnapshotSchema: z.ZodType<MissionSnapshot> = z.object({
  version: z.literal(MISSION_STATE_VERSION),
  parentSessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  generation: positiveInteger,
  goalId: z.string().min(1).max(256),
  missionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  dagTaskId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  revision: positiveInteger,
  source: z.object({
    path: z.string().min(1).max(4096),
    sha256,
    bytes: positiveInteger,
  }).strict(),
  phase: z.enum(['planned', 'running', 'passed', 'failed', 'blocked', 'needs-human-review', 'needs-attention']),
  continueOnError: z.boolean(),
  tasks: z.array(taskSchema).min(1).max(4096),
  maxAuditRecords: positiveInteger,
  maxAuditBytes: positiveInteger,
  createdAt: safeTime,
  updatedAt: safeTime,
  reason: nonEmpty.optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.updatedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', message: 'mission updatedAt precedes createdAt' })
  }
  snapshot.tasks.forEach((task, index) => {
    if (task.id !== missionTaskId(index)) {
      context.addIssue({ code: 'custom', message: 'mission task ids must match source order' })
    }
    if (task.updatedAt > snapshot.updatedAt) {
      context.addIssue({ code: 'custom', message: 'mission task time exceeds summary time' })
    }
  })
  const running = snapshot.tasks.filter(task => task.status === 'running').length
  if (running > 1) context.addIssue({ code: 'custom', message: 'missions may run only one task at a time' })
  if ((snapshot.phase === 'running') !== (running === 1)) {
    context.addIssue({ code: 'custom', message: 'running mission phase requires exactly one running task' })
  }
  const derived = deriveMissionPhase(snapshot.tasks)
  if (snapshot.phase !== 'needs-attention' && snapshot.phase !== derived) {
    context.addIssue({ code: 'custom', message: `mission phase ${snapshot.phase} disagrees with task state ${derived}` })
  }
  if (snapshot.phase === 'needs-attention' && snapshot.reason === undefined) {
    context.addIssue({ code: 'custom', message: 'needs-attention missions require a reason' })
  }
})

/** Runtime validation for one append-only mission ledger row. */
export const missionAuditRecordSchema: z.ZodType<MissionAuditRecord> = z.object({
  version: z.literal(MISSION_STATE_VERSION),
  operation: z.enum(['plan', 'run-start', 'task-start', 'task-settle', 'mark', 'rerun-start', 'finish', 'attention']),
  time: safeTime,
  snapshot: missionSnapshotSchema,
}).strict().superRefine((record, context) => {
  if (record.time !== record.snapshot.updatedAt) {
    context.addIssue({ code: 'custom', message: 'mission ledger time must equal summary updatedAt' })
  }
})

/** Stable mission task id for one zero-based source position. */
export function missionTaskId(index: number): string {
  return `task-${String(index + 1).padStart(3, '0')}`
}

/** Stable operator slug derived from a source filename. */
export function missionSlug(path: string, sourceSha256: string): string {
  const file = basename(path, extname(path)).toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
    .slice(0, 46)
  const stem = file.length === 0 ? 'mission' : file
  return `${stem}-${sourceSha256.slice(0, 8)}`
}

/** Parse one prompt per non-empty line using the pinned OMX mission grammar. */
export function parseMissionMarkdown(raw: string, limits: MissionParseLimits): readonly ParsedMissionTask[] {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MissionStateError(`${name} must be a positive safe integer`, 'MISSION_LIMIT_EXCEEDED')
    }
  }
  const prompts: string[] = []
  let inComment = false
  for (const sourceLine of raw.replaceAll('\r\n', '\n').split('\n')) {
    let line = sourceLine.trim()
    if (inComment) {
      const close = line.indexOf('-->')
      if (close < 0) continue
      inComment = false
      line = line.slice(close + 3).trim()
    }
    for (;;) {
      const open = line.indexOf('<!--')
      if (open < 0) break
      const close = line.indexOf('-->', open + 4)
      if (close < 0) {
        line = line.slice(0, open).trim()
        inComment = true
        break
      }
      line = `${line.slice(0, open)} ${line.slice(close + 3)}`.trim()
    }
    if (line.length === 0 || /^#{1,6}(?:\s|$)/u.test(line)) continue
    line = line
      .replace(/^[-*+]\s+\[[ xX]\]\s*/u, '')
      .replace(/^[-*+]\s+/u, '')
      .replace(/^\d+[.)]\s+/u, '')
      .trim()
    if (line.length > limits.maxPromptChars) {
      throw new MissionStateError(
        `mission prompt ${prompts.length + 1} exceeds ${limits.maxPromptChars} characters`,
        'MISSION_LIMIT_EXCEEDED',
      )
    }
    prompts.push(line)
    if (prompts.length > limits.maxTasks) {
      throw new MissionStateError(`mission exceeds ${limits.maxTasks} tasks`, 'MISSION_LIMIT_EXCEEDED')
    }
  }
  if (inComment) throw new MissionStateError('mission contains an unterminated HTML comment', 'MISSION_FORMAT_INVALID')
  if (prompts.length === 0) throw new MissionStateError('mission contains no prompts', 'MISSION_FORMAT_INVALID')
  const total = prompts.reduce((sum, prompt) => sum + prompt.length, 0)
  if (total > limits.maxTotalPromptChars) {
    throw new MissionStateError(
      `mission prompts exceed ${limits.maxTotalPromptChars} aggregate characters`,
      'MISSION_LIMIT_EXCEEDED',
    )
  }
  return Object.freeze(prompts.map((prompt, index) => Object.freeze({ id: missionTaskId(index), prompt })))
}

/** Compute the source digest used to bind summary and file content. */
export function missionSourceSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Derive operator-visible aggregate status from task states. */
export function deriveMissionPhase(tasks: readonly MissionTaskSnapshot[]): Exclude<MissionPhase, 'needs-attention'> {
  if (tasks.some(task => task.status === 'running')) return 'running'
  if (tasks.some(task => task.status === 'blocked')) return 'blocked'
  if (tasks.some(task => task.status === 'needs-human-review')) return 'needs-human-review'
  if (tasks.some(task => task.status === 'failed')) return 'failed'
  if (tasks.every(task => task.status === 'passed')) return 'passed'
  return 'planned'
}

/** Count every task status without dropping zero-valued categories. */
export function missionCounts(tasks: readonly MissionTaskSnapshot[]): Readonly<Record<MissionTaskStatus, number>> {
  const counts: Record<MissionTaskStatus, number> = {
    planned: 0,
    running: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    'needs-human-review': 0,
  }
  for (const task of tasks) counts[task.status] += 1
  return Object.freeze(counts)
}

/** Validate one immutable mission transition before storage publication. */
export function assertMissionTransition(
  previous: MissionSnapshot | undefined,
  record: MissionAuditRecord,
): void {
  missionAuditRecordSchema.parse(record)
  const next = record.snapshot
  if (previous === undefined) {
    if (record.operation !== 'plan' || next.revision !== 1 || next.phase !== 'planned') {
      throw new MissionStateError('the first mission record must be a planned revision 1', 'MISSION_TRANSITION_INVALID')
    }
    return
  }
  for (const field of ['parentSessionId', 'runId', 'generation', 'goalId', 'missionId', 'dagTaskId'] as const) {
    if (previous[field] !== next[field]) {
      throw new MissionStateError(`mission identity field ${field} is immutable`, 'MISSION_TRANSITION_INVALID')
    }
  }
  if (next.revision !== previous.revision + 1) {
    throw new MissionStateError('mission revisions must increase by one', 'MISSION_TRANSITION_INVALID')
  }
  if (next.source.sha256 !== previous.source.sha256 || next.source.path !== previous.source.path
    || next.tasks.length !== previous.tasks.length
    || next.tasks.some((task, index) => task.id !== previous.tasks[index]?.id || task.prompt !== previous.tasks[index]?.prompt)) {
    throw new MissionStateError('mission source and parsed prompts are immutable', 'MISSION_TRANSITION_INVALID')
  }
  if (next.maxAuditRecords !== previous.maxAuditRecords || next.maxAuditBytes !== previous.maxAuditBytes) {
    throw new MissionStateError('mission audit ceilings are immutable', 'MISSION_TRANSITION_INVALID')
  }
}

/** Fold validated ledger rows into the latest mission summaries. */
export function foldMissionAudit(records: readonly MissionAuditRecord[]): ReadonlyMap<string, MissionSnapshot> {
  const current = new Map<string, MissionSnapshot>()
  const sorted = [...records].sort((left, right) => left.snapshot.parentSessionId.localeCompare(right.snapshot.parentSessionId)
    || left.snapshot.generation - right.snapshot.generation
    || left.snapshot.missionId.localeCompare(right.snapshot.missionId)
    || left.snapshot.revision - right.snapshot.revision)
  for (const record of sorted) {
    const key = missionIdentity(record.snapshot)
    const previous = current.get(key)
    assertMissionTransition(previous, record)
    current.set(key, Object.freeze(record.snapshot))
  }
  return current
}

/** Stable identity for one mission within an exact run generation. */
export function missionIdentity(
  snapshot: Pick<MissionSnapshot, 'parentSessionId' | 'runId' | 'generation' | 'missionId'>,
): string {
  return JSON.stringify([snapshot.parentSessionId, snapshot.runId, snapshot.generation, snapshot.missionId])
}
