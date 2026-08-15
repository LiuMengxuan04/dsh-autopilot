import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalId } from '@deepseek-ai/dsh-goal/types'
import { MessageId, createAssistantMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutonomyError,
  AutonomyService,
  DEFAULT_ACTIVE_MS_CEILING,
  DEFAULT_MAX_AUDIT_BYTES,
  DEFAULT_MAX_AUDIT_RECORDS,
  DEFAULT_GOAL_ROUNDS_CEILING,
  DEFAULT_MAX_ACTIVE_MS,
  DEFAULT_MAX_DYNAMIC_SOURCE_CHARS,
  DEFAULT_MAX_EVIDENCE_ITEMS,
  DEFAULT_MAX_GOAL_ROUNDS,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  DEFAULT_MAX_TASK_ATTEMPTS,
  DEFAULT_MAX_TASKS,
  resolveAutonomyLimits,
} from '../../src/service.ts'
import type { AutonomyServiceConfig } from '../../src/service.ts'
import type { RecoveryLifecycleIntent, RecoveryReport, RecoveryRunRef } from '../../src/recovery.ts'
import {
  AutopilotRecoveryReadiness,
  RECOVERY_CRITICAL_CONTRIBUTIONS,
} from '../../src/recovery-coordinator.ts'
import type {
  PlannedTaskInput,
  RunEvidence,
  RunSnapshot,
  VerificationBaseline,
  VerificationPolicy,
  VerificationRecord,
} from '../../src/run-state.ts'
import { MAX_PLAN_REVIEW_ATTEMPTS, VERIFICATION_POLICY_VERSION } from '../../src/run-state.ts'
import type { DurableRunStore } from '../../src/run-store.ts'
import { createServiceHarness, createTestAgent } from '../helpers.ts'

const roots = new Set<string>()

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const taskEvidence: RunEvidence = {
  kind: 'test',
  ref: 'pnpm test',
  summary: 'focused test passed',
}

function task(id: string, dependencies: readonly string[] = []): PlannedTaskInput {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    acceptanceCriteria: [`${id} accepted`],
    dependencies,
  }
}

async function recordTestInterview(ctx: Context, agent: Agent): Promise<void> {
  await ctx.autonomy.recordInterview(agent, {
    summary: 'The objective and repository constraints are understood.',
    decisions: ['Use the bounded test plan.'],
    openQuestions: [],
  })
}

async function approveTestPlan(ctx: Context, agent: Agent): Promise<void> {
  const reviewing = await ctx.autonomy.beginPlanReview(agent)
  const revision = reviewing.plan?.revision
  if (revision === undefined) throw new Error('test plan is missing')
  await ctx.autonomy.settlePlanReview(agent, revision, [
    { role: 'metis', verdict: 'advice', summary: 'requirements are explicit', findings: [], recommendations: [] },
    { role: 'momus', verdict: 'advice', summary: 'plan is executable', findings: [], recommendations: [] },
    { role: 'oracle', verdict: 'advice', summary: 'architecture is sound', findings: [], recommendations: [] },
  ])
}

function verification(
  verdict: VerificationRecord['verdict'],
  attempt = 1,
  summary = `${verdict} verification`,
): VerificationRecord {
  return {
    attempt,
    startedAt: 100,
    finishedAt: 200,
    verdict,
    summary,
    findings: verdict === 'pass' ? [] : [`${verdict} finding`],
    checks: [{ name: 'tests', passed: verdict === 'pass', summary: 'test result' }],
    reviewers: [{
      role: 'requirements',
      verdict,
      summary: 'review result',
      findings: verdict === 'pass' ? [] : ['review finding'],
      childSessionId: 'child-1',
    }],
  }
}

function projectBaseline(frozenAt = 100): VerificationBaseline {
  return {
    kind: 'project',
    workspace: '/workspace',
    frozenAt,
    manifests: [{ name: 'package.json', sha256: 'a'.repeat(64) }],
    checks: [{
      id: 'js:test',
      label: 'JavaScript tests',
      cwd: '/workspace',
      argv: ['npm', 'run', 'test'],
      command: 'npm run test',
      manifest: 'package.json',
    }],
  }
}

function verificationPolicy(frozenAt = 100): VerificationPolicy {
  return {
    version: VERIFICATION_POLICY_VERSION,
    frozenAt,
    sha256: 'd'.repeat(64),
    workspace: '/workspace',
    minimumEvidenceItems: 2,
    maxOutputChars: 4000,
    fixedChecks: [{ name: 'tests', commandSha256: 'e'.repeat(64), timeoutMs: 120_000 }],
    autoDiscoverChecks: true,
    projectChecks: ['js:test'],
    maxProjectChecks: 8,
    projectCheckTimeoutMs: 600_000,
    reviewers: [{
      role: 'requirements',
      descriptionSha256: 'f'.repeat(64),
      primary: { subagentProvider: 'spawn', provider: 'deepseek', model: 'reviewer' },
      fallbacks: [{ subagentProvider: 'spawn' }],
    }],
  }
}

function emitAssistantMessage(
  ctx: Context,
  agent: Agent,
  text = 'Autopilot work is complete.',
  turn = 1,
): void {
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    seq: agent.session.events.length,
    time: Date.now(),
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test', model: 'test' },
      }),
    },
  })
}

function emitCompletionTurn(ctx: Context, agent: Agent, messageId: MessageId, turn = 1): void {
  const message = completionUserMessage(messageId)
  agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn })
  ctx.emit('session/event', agent.session, {
    type: 'user/message',
    seq: agent.session.events.length,
    time: Date.now(),
    data: message,
  })
  emitAssistantMessage(ctx, agent, 'Autopilot work is complete.', turn)
  ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    seq: agent.session.events.length,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  })
}

function completionUserMessage(messageId: MessageId): UserMessage {
  return freezeMessage({
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text: 'Deliver the Autopilot completion report.' }],
    source: {
      kind: 'plugin', plugin: 'dsh-autopilot', form: 'notice', summary: 'Autopilot completion report pending',
    },
  }) as UserMessage
}

function emitFailedCompletionTurn(
  ctx: Context,
  agent: Agent,
  messageId: MessageId,
  turn: number,
  reason: TurnEndReason,
  assistantText?: string,
  admitted = true,
): void {
  const message = completionUserMessage(messageId)
  agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn })
  if (admitted) {
    ctx.emit('session/event', agent.session, {
      type: 'user/message',
      seq: agent.session.events.length,
      time: Date.now(),
      data: message,
    })
  }
  if (assistantText !== undefined) emitAssistantMessage(ctx, agent, assistantText, turn)
  ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    seq: agent.session.events.length,
    time: Date.now(),
    data: { turn, reason },
  })
}

function appendCompletionTurn(agent: Agent, messageId: MessageId, turn = 1, completed = true): UserMessage {
  const message = completionUserMessage(messageId)
  agent.session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, inserted: [message],
  })
  agent.session.append('turn/start', { turn })
  agent.session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
  if (completed) {
    agent.session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Autopilot work is complete.' }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return message
}

async function startPlannedRun(options: {
  autonomy?: AutonomyServiceConfig
  duration?: number
} = {}) {
  const harness = await createServiceHarness(
    options.autonomy === undefined ? {} : { autonomy: options.autonomy },
  )
  const goal = harness.ctx.goals.create(harness.agent, { objective: 'exercise durable Autopilot' })
  await harness.ctx.autonomy.start(harness.agent, {
    goalId: goal.id,
    ...(options.duration === undefined ? {} : { maxActiveMs: options.duration }),
  })
  await recordTestInterview(harness.ctx, harness.agent)
  await harness.ctx.autonomy.setPlan(
    harness.agent,
    ['all tasks complete'],
    [task('build'), task('test', ['build'])],
  )
  await approveTestPlan(harness.ctx, harness.agent)
  return { ...harness, goal }
}

async function completeTaskGraph(harness: Awaited<ReturnType<typeof startPlannedRun>>): Promise<void> {
  await harness.ctx.autonomy.updateTask(harness.agent, 'build', 'start')
  await harness.ctx.autonomy.updateTask(harness.agent, 'build', 'complete', { evidence: [taskEvidence] })
  await harness.ctx.autonomy.updateTask(harness.agent, 'test', 'start')
  await harness.ctx.autonomy.updateTask(harness.agent, 'test', 'complete', { evidence: [taskEvidence] })
}

async function completedRun() {
  const harness = await startPlannedRun({ autonomy: { autoResume: true } })
  await completeTaskGraph(harness)
  await harness.ctx.autonomy.beginVerification(harness.agent, {
    summary: 'candidate', evidence: ['tests'],
  })
  await harness.ctx.autonomy.complete(harness.agent, verification('pass'))
  return { ...harness, ref: recoveryRef(latestSnapshot(harness.ctx, harness.agent)) }
}

describe('AutonomyService limits', () => {
  it.each([
    [{ defaultMaxGoalRounds: 0 }, 'AUTONOMY_INVALID_ROUNDS'],
    [{ maxGoalRounds: 1.5 }, 'AUTONOMY_INVALID_ROUNDS'],
    [{ defaultMaxGoalRounds: 3, maxGoalRounds: 2 }, 'AUTONOMY_INVALID_ROUNDS'],
    [{ defaultMaxActiveMs: 0 }, 'AUTONOMY_INVALID_DURATION'],
    [{ maxActiveMs: Number.MAX_SAFE_INTEGER + 1 }, 'AUTONOMY_INVALID_DURATION'],
    [{ defaultMaxActiveMs: 3, maxActiveMs: 2 }, 'AUTONOMY_INVALID_DURATION'],
    [{ maxVerificationAttempts: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxDynamicPackages: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxSubagents: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxConcurrentSubagents: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxTasks: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxTaskAttempts: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxEvidenceItems: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxSnapshotBytes: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxAuditRecords: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxAuditBytes: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxDynamicSourceChars: 0 }, 'AUTONOMY_INVALID_TRANSITION'],
    [{ maxSubagents: 1, maxConcurrentSubagents: 2 }, 'AUTONOMY_INVALID_TRANSITION'],
  ])('rejects invalid configuration %j', (autonomy, code) => {
    expect(() => resolveAutonomyLimits(autonomy)).toThrow(expect.objectContaining({ code }))
  })

  it('materializes every default and enforces requested ceilings', async () => {
    expect(resolveAutonomyLimits({})).toEqual({
      defaultMaxGoalRounds: DEFAULT_MAX_GOAL_ROUNDS,
      maxGoalRounds: DEFAULT_GOAL_ROUNDS_CEILING,
      defaultMaxActiveMs: DEFAULT_MAX_ACTIVE_MS,
      maxActiveMs: DEFAULT_ACTIVE_MS_CEILING,
      maxVerificationAttempts: 3,
      maxDynamicPackages: 8,
      maxSubagents: 32,
      maxConcurrentSubagents: 4,
      maxTasks: DEFAULT_MAX_TASKS,
      maxTaskAttempts: DEFAULT_MAX_TASK_ATTEMPTS,
      maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS,
      maxSnapshotBytes: DEFAULT_MAX_SNAPSHOT_BYTES,
      maxAuditRecords: DEFAULT_MAX_AUDIT_RECORDS,
      maxAuditBytes: DEFAULT_MAX_AUDIT_BYTES,
      maxDynamicSourceChars: DEFAULT_MAX_DYNAMIC_SOURCE_CHARS,
      selfModification: 'off',
      autoResume: false,
    })
    const { ctx } = await createServiceHarness({
      autonomy: {
        defaultMaxGoalRounds: 4,
        maxGoalRounds: 8,
        defaultMaxActiveMs: 1000,
        maxActiveMs: 2000,
        maxVerificationAttempts: 2,
        maxDynamicPackages: 3,
        maxSubagents: 6,
        maxConcurrentSubagents: 2,
        maxTasks: 12,
        maxTaskAttempts: 24,
        maxEvidenceItems: 48,
        maxSnapshotBytes: 65_536,
        maxAuditRecords: 96,
        maxAuditBytes: 1_048_576,
        maxDynamicSourceChars: 8192,
        selfModification: 'off',
        autoResume: true,
      },
    })
    expect(ctx.autonomy.limits).toMatchObject({
      defaultMaxGoalRounds: 4,
      maxGoalRounds: 8,
      defaultMaxActiveMs: 1000,
      maxActiveMs: 2000,
      maxVerificationAttempts: 2,
      maxDynamicPackages: 3,
      maxSubagents: 6,
      maxConcurrentSubagents: 2,
      maxTasks: 12,
      maxTaskAttempts: 24,
      maxEvidenceItems: 48,
      maxSnapshotBytes: 65_536,
      maxAuditRecords: 96,
      maxAuditBytes: 1_048_576,
      maxDynamicSourceChars: 8192,
      selfModification: 'off',
      autoResume: true,
    })
    expect(ctx.autonomy.resolveGoalRounds()).toBe(4)
    expect(ctx.autonomy.resolveGoalRounds(8)).toBe(8)
    expect(ctx.autonomy.resolveDuration()).toBe(1000)
    expect(ctx.autonomy.resolveDuration(2000)).toBe(2000)
    expect(() => ctx.autonomy.resolveGoalRounds(9)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_ROUNDS',
    }))
    expect(() => ctx.autonomy.resolveGoalRounds(1.5)).toThrow(AutonomyError)
    expect(() => ctx.autonomy.resolveDuration(2001)).toThrow(expect.objectContaining({
      code: 'AUTONOMY_INVALID_DURATION',
    }))
    expect(() => ctx.autonomy.resolveDuration(-1)).toThrow(AutonomyError)
    await ctx.fiber.dispose()
  })

  it('keeps the live cache unchanged when a frozen durable-content ceiling rejects a mutation', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { maxTasks: 1 } })
    const goal = ctx.goals.create(agent, { objective: 'bound the durable task graph' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await recordTestInterview(ctx, agent)
    await expect(ctx.autonomy.setPlan(agent, ['bounded'], [task('one'), task('two')]))
      .rejects.toThrow(/task graph exceeds its materialized budget/)
    expect(ctx.autonomy.get(agent)).toMatchObject({ revision: 2, maxTasks: 1 })
    expect(ctx.autonomy.get(agent)?.plan).toBeUndefined()
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual(['start', 'flow'])
    await expect(ctx.autonomy.setPlan(agent, ['bounded'], [task('one')]))
      .resolves.toMatchObject({ revision: 3, plan: { tasks: [{ id: 'one' }] } })
    await ctx.fiber.dispose()
  })
})

describe('AutonomyService durable lifecycle', () => {
  it('freezes verifier policy across restart and fails closed on weaker deployment state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-policy-'))
    roots.add(root)
    const first = await createServiceHarness({ storageRoot: root, agentId: 'policy-session' })
    const goal = first.ctx.goals.create(first.agent, { objective: 'freeze completion policy' })
    await first.ctx.autonomy.start(first.agent, { goalId: goal.id })

    const [left, right] = await Promise.all([
      first.ctx.autonomy.freezeVerificationPolicy(first.agent, verificationPolicy(100)),
      first.ctx.autonomy.freezeVerificationPolicy(first.agent, verificationPolicy(200)),
    ])
    expect(left.verificationPolicy).toEqual(right.verificationPolicy)
    expect(first.ctx.autonomy.history(first.agent).map(record => record.operation)).toEqual([
      'start', 'verification-policy',
    ])
    const winner = first.ctx.autonomy.get(first.agent)?.verificationPolicy
    await first.ctx.fiber.dispose()

    const reopened = await createServiceHarness({ storageRoot: root, agentId: 'policy-session' })
    await expect(reopened.ctx.autonomy.freezeVerificationPolicy(
      reopened.agent,
      verificationPolicy(300),
    )).resolves.toMatchObject({ verificationPolicy: winner })
    await expect(reopened.ctx.autonomy.freezeVerificationPolicy(reopened.agent, {
      ...verificationPolicy(400),
      sha256: '0'.repeat(64),
      fixedChecks: [],
      reviewers: [{
        role: 'requirements',
        descriptionSha256: 'f'.repeat(64),
        primary: { subagentProvider: 'spawn' },
        fallbacks: [],
      }],
    })).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
      message: expect.stringContaining('verification policy drift'),
    })
    expect(reopened.ctx.autonomy.get(reopened.agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      verificationPolicy: winner,
      reason: expect.stringContaining('verification policy drift'),
    })
    await reopened.ctx.fiber.dispose()
  })

  it('rejects policy freezing without a running armed lease', async () => {
    const missing = await createServiceHarness()
    await expect(missing.ctx.autonomy.freezeVerificationPolicy(
      missing.agent,
      verificationPolicy(),
    )).rejects.toMatchObject({ code: 'AUTONOMY_LEASE_MISSING' })
    await missing.ctx.fiber.dispose()

    const paused = await createServiceHarness()
    const goal = paused.ctx.goals.create(paused.agent, { objective: 'pause before policy freeze' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: goal.id })
    await paused.ctx.autonomy.pause(paused.agent)
    await expect(paused.ctx.autonomy.freezeVerificationPolicy(
      paused.agent,
      verificationPolicy(),
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await paused.ctx.fiber.dispose()
  })

  it('converges concurrent baseline freezes and preserves the winner across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-baseline-'))
    roots.add(root)
    const first = await createServiceHarness({ storageRoot: root, agentId: 'baseline-session' })
    const goal = first.ctx.goals.create(first.agent, { objective: 'freeze verification inputs' })
    await first.ctx.autonomy.start(first.agent, { goalId: goal.id })

    const [left, right] = await Promise.all([
      first.ctx.autonomy.freezeVerificationBaseline(first.agent, projectBaseline(100)),
      first.ctx.autonomy.freezeVerificationBaseline(first.agent, projectBaseline(200)),
    ])
    expect(left.verificationBaseline).toEqual(right.verificationBaseline)
    expect(first.ctx.autonomy.history(first.agent).map(record => record.operation)).toEqual([
      'start', 'verification-baseline',
    ])
    await expect(first.ctx.autonomy.freezeVerificationBaseline(first.agent, {
      ...projectBaseline(300),
      manifests: [{ name: 'package.json', sha256: 'b'.repeat(64) }],
    })).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
      message: expect.stringContaining('different project state'),
    })
    const winner = first.ctx.autonomy.get(first.agent)?.verificationBaseline
    await first.ctx.fiber.dispose()

    const reopened = await createServiceHarness({ storageRoot: root, agentId: 'baseline-session' })
    expect(reopened.ctx.autonomy.get(reopened.agent)).toMatchObject({
      activation: 'disarmed',
      verificationBaseline: winner,
    })
    await reopened.ctx.fiber.dispose()
  })

  it('rejects baseline freezing without a running armed lease', async () => {
    const missing = await createServiceHarness()
    await expect(missing.ctx.autonomy.freezeVerificationBaseline(
      missing.agent,
      projectBaseline(),
    )).rejects.toMatchObject({ code: 'AUTONOMY_LEASE_MISSING' })
    await missing.ctx.fiber.dispose()

    const paused = await createServiceHarness()
    const goal = paused.ctx.goals.create(paused.agent, { objective: 'pause before freeze' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: goal.id })
    await paused.ctx.autonomy.pause(paused.agent)
    await expect(paused.ctx.autonomy.freezeVerificationBaseline(
      paused.agent,
      projectBaseline(),
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await paused.ctx.fiber.dispose()
  })

  it('persists every mutation, pauses active time, resumes explicitly, and revokes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { ctx, agent, goal } = await startPlannedRun({
      autonomy: { defaultMaxActiveMs: 5000, maxActiveMs: 10_000 },
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      revision: 5,
      generation: 1,
      phase: 'running',
      activation: 'armed',
      remainingActiveMs: 5000,
    })
    const firstSignal = ctx.autonomy.signal(agent)
    await vi.advanceTimersByTimeAsync(1200)
    await expect(ctx.autonomy.pause(agent, 'manual pause')).resolves.toMatchObject({
      revision: 6,
      phase: 'paused',
      activation: 'disarmed',
      remainingActiveMs: 3800,
      reason: 'manual pause',
    })
    expect(firstSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ctx.autonomy.get(agent)?.remainingActiveMs).toBe(3800)
    await expect(ctx.autonomy.resume(agent, goal.id)).resolves.toMatchObject({
      revision: 7,
      phase: 'running',
      activation: 'armed',
      remainingActiveMs: 3800,
    })
    expect(ctx.autonomy.signal(agent)).not.toBe(firstSignal)
    await expect(ctx.autonomy.revoke(agent)).resolves.toMatchObject({
      phase: 'revoked',
      activation: 'disarmed',
      reason: 'revoked by user',
    })
    await expect(ctx.autonomy.revoke(agent)).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    expect(ctx.autonomy.history(agent).map(item => item.operation)).toEqual([
      'start', 'flow', 'plan', 'flow', 'flow', 'pause', 'resume', 'revoke',
    ])
    await ctx.fiber.dispose()
  })

  it('reopens a running process as disarmed and preserves plan plus all run-lifetime budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-restart-'))
    roots.add(root)
    const agentId = 'restart-session'
    const first = await createServiceHarness({
      storageRoot: root,
      agentId,
      autonomy: {
        defaultMaxActiveMs: 10_000,
        maxActiveMs: 20_000,
        maxVerificationAttempts: 3,
        maxDynamicPackages: 4,
        maxSubagents: 8,
        maxConcurrentSubagents: 2,
        maxTasks: 12,
        maxTaskAttempts: 24,
        maxEvidenceItems: 48,
        maxSnapshotBytes: 65_536,
        maxAuditRecords: 96,
        maxAuditBytes: 1_048_576,
        maxDynamicSourceChars: 8192,
      },
    })
    const goal = first.ctx.goals.create(first.agent, { objective: 'survive process restart' })
    await first.ctx.autonomy.start(first.agent, { goalId: goal.id })
    await recordTestInterview(first.ctx, first.agent)
    await first.ctx.autonomy.setPlan(first.agent, ['done'], [task('one')])
    await first.ctx.autonomy.recordDynamicPackage(first.agent)
    await first.ctx.autonomy.recordSubagentStarts(first.agent, 2)
    const before = first.ctx.autonomy.get(first.agent)!
    await first.ctx.fiber.dispose()

    const second = await createServiceHarness({
      storageRoot: root,
      agentId,
      autonomy: {
        defaultMaxActiveMs: 1,
        maxActiveMs: 20_000,
        maxVerificationAttempts: 1,
        maxDynamicPackages: 1,
        maxSubagents: 1,
        maxConcurrentSubagents: 1,
      },
    })
    expect(second.ctx.autonomy.get(second.agent)).toMatchObject({
      id: before.id,
      generation: 1,
      revision: before.revision,
      phase: 'running',
      activation: 'disarmed',
      dynamicPackages: 1,
      subagentsStarted: 2,
      maxVerificationAttempts: 3,
      maxDynamicPackages: 4,
      maxSubagents: 8,
      maxConcurrentSubagents: 2,
      maxTasks: 12,
      maxTaskAttempts: 24,
      maxEvidenceItems: 48,
      maxSnapshotBytes: 65_536,
      maxAuditRecords: 96,
      maxAuditBytes: 1_048_576,
      maxDynamicSourceChars: 8192,
      plan: expect.objectContaining({ tasks: [expect.objectContaining({ id: 'one' })] }),
    })
    expect(() => second.ctx.autonomy.signal(second.agent)).toThrow(/human.*resume/)
    await expect(second.ctx.autonomy.recordDynamicPackage(second.agent)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(second.ctx.autonomy.recordSubagentStarts(second.agent, 1)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(second.ctx.autonomy.pause(second.agent, 'normalize crash state')).resolves.toMatchObject({
      phase: 'paused',
      activation: 'disarmed',
    })
    vi.spyOn(second.ctx.goals, 'get').mockReturnValue({ ...goal, activation: 'disarmed' })
    await expect(second.ctx.autonomy.resume(second.agent, goal.id)).resolves.toMatchObject({
      activation: 'armed',
      dynamicPackages: 1,
      subagentsStarted: 2,
    })
    await second.ctx.autonomy.pause(second.agent)
    const extended = await second.ctx.autonomy.resume(second.agent, goal.id, 5000)
    expect(extended).toMatchObject({
      maxActiveMs: 15_000,
      dynamicPackages: 1,
      subagentsStarted: 2,
    })
    expect(extended.remainingActiveMs).toBeGreaterThan(4900)
    expect(extended.remainingActiveMs).toBeLessThanOrEqual(5000)
    await second.ctx.fiber.dispose()

    const third = await createServiceHarness({ storageRoot: root, agentId })
    vi.spyOn(third.ctx.goals, 'get').mockReturnValue({ ...goal, activation: 'disarmed' })
    expect(third.ctx.autonomy.get(third.agent)).toMatchObject({
      phase: 'running', activation: 'disarmed', dynamicPackages: 1, subagentsStarted: 2,
    })
    await expect(third.ctx.autonomy.resume(third.agent, goal.id)).resolves.toMatchObject({
      phase: 'running', activation: 'armed', dynamicPackages: 1, subagentsStarted: 2,
    })
    await third.ctx.fiber.dispose()
  })

  it('settles live task attempts on pause and revoke without losing retry history', async () => {
    const harness = await startPlannedRun()
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const paused = await harness.ctx.autonomy.pause(harness.agent, 'operator pause')
    expect(paused.plan?.tasks[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      attemptHistory: [expect.objectContaining({ outcome: 'interrupted', reason: 'operator pause' })],
    })

    await harness.ctx.autonomy.resume(harness.agent, harness.goal.id)
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const revoked = await harness.ctx.autonomy.revoke(harness.agent, 'authorization withdrawn')
    expect(revoked.plan?.tasks[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      reason: 'authorization withdrawn',
      attemptHistory: [
        expect.objectContaining({ attempt: 1, outcome: 'interrupted' }),
        expect.objectContaining({ attempt: 2, outcome: 'interrupted', reason: 'authorization withdrawn' }),
      ],
    })
    await harness.ctx.fiber.dispose()
  })

  it('starts a monotonically increasing generation only after terminal state', async () => {
    const { ctx, agent } = await createServiceHarness()
    const firstGoal = ctx.goals.create(agent, { objective: 'first' })
    await ctx.autonomy.start(agent, { goalId: firstGoal.id })
    await expect(ctx.autonomy.start(agent, { goalId: firstGoal.id })).rejects.toMatchObject({
      code: 'AUTONOMY_ALREADY_ACTIVE',
    })
    await ctx.autonomy.revoke(agent, 'replace')
    ctx.goals.complete(agent, firstGoal)
    const secondGoal = ctx.goals.create(agent, { objective: 'second' })
    await expect(ctx.autonomy.start(agent, { goalId: secondGoal.id })).resolves.toMatchObject({
      generation: 2,
      revision: 1,
      goalId: secondGoal.id,
    })
    await ctx.fiber.dispose()
  })

  it('does not arm a stale start snapshot after an observer marks the run needs-attention', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'fail start closed after observer mutation' })
    ctx.on('autonomy/changed', async ({ operation }) => {
      if (operation !== 'start') return
      await ctx.autonomy.markNeedsAttention(
        recoveryRef(latestSnapshot(ctx, agent)),
        'start observer requires host reconciliation',
      )
    })

    await expect(ctx.autonomy.start(agent, { goalId: goal.id })).rejects.toThrow(
      /changed during start observers/,
    )
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: 'start observer requires host reconciliation',
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(probe(ctx.autonomy).runtimes.has(agent)).toBe(false)
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual(['start', 'needs-attention'])
    await ctx.fiber.dispose()
  })

  it('fails a start closed when an observer changes only its live Goal', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'guard the start-to-runtime publication window' })
    ctx.on('autonomy/changed', ({ operation }) => {
      if (operation === 'start') ctx.goals.disarm(agent)
    })

    await expect(ctx.autonomy.start(agent, { goalId: goal.id })).rejects.toThrow(/changed during start observers/)
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: 'the run or Goal changed during start observers before runtime activation',
    })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual(['start', 'needs-attention'])
    await ctx.fiber.dispose()
  })

  it('requires matching, disarmed, nonterminal state and explicit time for exhausted resume', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
    })
    const goal = ctx.goals.create(agent, { objective: 'resume validation' })
    await expect(ctx.autonomy.resume(agent, goal.id)).rejects.toMatchObject({ code: 'AUTONOMY_LEASE_MISSING' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await expect(ctx.autonomy.resume(agent, goal.id)).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    const expiresAt = ctx.autonomy.get(agent)?.expiresAt
    if (expiresAt === undefined) throw new Error('fixture lease has no expiry')
    vi.setSystemTime(expiresAt)
    await expect(ctx.autonomy.pause(agent)).resolves.toMatchObject({ phase: 'exhausted' })
    await expect(ctx.autonomy.resume(agent, 'other-goal' as GoalId)).rejects.toThrow(/different Goal/)
    await expect(ctx.autonomy.resume(agent, goal.id)).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_DURATION' })
    await expect(ctx.autonomy.resume(agent, goal.id, 50)).resolves.toMatchObject({ phase: 'running' })
    await ctx.autonomy.revoke(agent)
    await expect(ctx.autonomy.resume(agent, goal.id)).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await ctx.fiber.dispose()
  })

  it('enforces the deployment active-time ceiling across repeated human extensions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 100, maxActiveMs: 250 },
    })
    const goal = ctx.goals.create(agent, { objective: 'bound cumulative authorization' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await ctx.autonomy.pause(agent)
    await expect(ctx.autonomy.resume(agent, goal.id, 100)).resolves.toMatchObject({ maxActiveMs: 200 })
    await ctx.autonomy.pause(agent)
    await expect(ctx.autonomy.resume(agent, goal.id, 50)).resolves.toMatchObject({ maxActiveMs: 250 })
    await ctx.autonomy.pause(agent)
    await expect(ctx.autonomy.resume(agent, goal.id, 1)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_DURATION',
      message: expect.stringMatching(/remaining deployment allowance 0/),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', maxActiveMs: 250 })
    await ctx.fiber.dispose()
  })
})

describe('AutonomyService task graph and budgets', () => {
  it('persists the canonical interview, plan-hardening quorum, repair cycle, and execution gate', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'exercise the canonical flow' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    expect(ctx.autonomy.get(agent)?.flow).toMatchObject({ stage: 'interview', cycle: 1, revision: 1 })
    await expect(ctx.autonomy.setPlan(agent, ['done'], [task('work')])).rejects.toThrow(/interview/)
    await expect(ctx.autonomy.beginPlanReview(agent)).rejects.toThrow(/canonical planning/)
    await expect(ctx.autonomy.recordInterview(agent, {
      summary: ' ', decisions: [], openQuestions: [],
    })).rejects.toThrow(/summary and at least one decision/)

    await ctx.autonomy.recordInterview(agent, {
      summary: ' Understand the objective. ',
      decisions: [' Use a durable plan. ', ' '],
      openQuestions: [' Confirm deployment. ', ' '],
    })
    expect(ctx.autonomy.get(agent)?.flow).toMatchObject({
      stage: 'planning',
      cycle: 1,
      interview: {
        summary: 'Understand the objective.',
        decisions: ['Use a durable plan.'],
        openQuestions: ['Confirm deployment.'],
      },
    })
    await expect(ctx.autonomy.beginPlanReview(agent)).rejects.toThrow(/durable task plan/)
    await expect(ctx.autonomy.recordInterview(agent, {
      summary: 'again', decisions: ['again'], openQuestions: [],
    })).rejects.toThrow(/already complete/)
    await ctx.autonomy.setPlan(agent, ['done'], [task('work')])
    await expect(ctx.autonomy.updateTask(agent, 'work', 'start')).rejects.toThrow(/plan review/)
    const reviewing = await ctx.autonomy.beginPlanReview(agent)
    await expect(ctx.autonomy.beginPlanReview(agent)).resolves.toMatchObject({ revision: reviewing.revision })
    await expect(ctx.autonomy.beginQualityAssurance(agent)).rejects.toThrow(/begin canonical QA/)
    await expect(ctx.autonomy.addTasks(agent, [task('premature')])).rejects.toThrow(/planning or execution repair/)
    await expect(ctx.autonomy.claimTasks(agent, ['work'])).rejects.toThrow(/passing canonical plan review/)
    await expect(ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, [
      { role: 'metis', verdict: 'advice', summary: ' ', findings: [], recommendations: [] },
      { role: 'momus', verdict: 'advice', summary: 'plan is executable', findings: [], recommendations: [] },
      { role: 'oracle', verdict: 'advice', summary: 'architecture is sound', findings: [], recommendations: [] },
    ])).rejects.toThrow(/summaries must not be empty/)
    await expect(ctx.autonomy.settlePlanReview(agent, 999, [])).rejects.toThrow(/plan revision/)
    const concern = [
      { role: 'metis' as const, verdict: 'advice' as const, summary: 'requirements clear', findings: [], recommendations: [] },
      { role: 'momus' as const, verdict: 'concern' as const, summary: 'proof is vague', findings: ['missing proof'], recommendations: ['name the check'] },
      { role: 'oracle' as const, verdict: 'advice' as const, summary: 'architecture clear', findings: [], recommendations: [] },
    ]
    await ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, concern)
    expect(ctx.autonomy.get(agent)).toMatchObject({
      reason: 'canonical plan review requires revision',
      flow: { stage: 'planning', cycle: 2, planReview: { passed: false, cycle: 1 } },
    })
    await ctx.autonomy.beginPlanReview(agent)
    await expect(ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, [
      concern[1]!, concern[0]!, concern[2]!,
    ])).rejects.toThrow(/ordered Metis, Momus, and Oracle/)
    await ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, concern.map(row => ({
      ...row,
      verdict: 'advice' as const,
      summary: ` ${row.role} approved `,
      findings: [],
      recommendations: [],
    })))
    expect(ctx.autonomy.get(agent)?.flow).toMatchObject({ stage: 'execution', cycle: 2, planReview: { passed: true } })
    await expect(ctx.autonomy.reorderTasks(agent, ['work'])).rejects.toThrow(/canonical planning/)
    await ctx.autonomy.addTasks(agent, [task('repair')])
    expect(ctx.autonomy.get(agent)?.flow).toMatchObject({ stage: 'planning', cycle: 3 })
    await ctx.fiber.dispose()
  })

  it('fails closed when canonical plan hardening does not converge', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'bound plan hardening' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await recordTestInterview(ctx, agent)
    await ctx.autonomy.setPlan(agent, ['done'], [task('work')])
    const concern = [
      { role: 'metis' as const, verdict: 'advice' as const, summary: 'requirements clear', findings: [], recommendations: [] },
      { role: 'momus' as const, verdict: 'concern' as const, summary: 'decisive blocker', findings: ['unsafe dependency'], recommendations: ['repair it'] },
      { role: 'oracle' as const, verdict: 'advice' as const, summary: 'architecture clear', findings: [], recommendations: [] },
    ]
    for (let attempt = 1; attempt < MAX_PLAN_REVIEW_ATTEMPTS; attempt += 1) {
      const reviewing = await ctx.autonomy.beginPlanReview(agent)
      await ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, concern)
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'running',
        activation: 'armed',
        flow: { stage: 'planning', cycle: attempt + 1, planReviewAttempts: attempt },
      })
    }

    const reviewing = await ctx.autonomy.beginPlanReview(agent)
    await ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, concern)
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: `canonical plan review did not converge after ${MAX_PLAN_REVIEW_ATTEMPTS} attempts`,
      flow: {
        stage: 'planning',
        cycle: MAX_PLAN_REVIEW_ATTEMPTS,
        planReviewAttempts: MAX_PLAN_REVIEW_ATTEMPTS,
        planReview: { cycle: MAX_PLAN_REVIEW_ATTEMPTS, passed: false },
      },
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await expect(ctx.autonomy.beginPlanReview(agent)).rejects.toThrow(/needs-attention/)
    await ctx.fiber.dispose()
  })

  it('records plan-hardening exhaustion when the matching Goal is already disarmed', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'retain a disarmed exhaustion result' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await recordTestInterview(ctx, agent)
    await ctx.autonomy.setPlan(agent, ['done'], [task('work')])
    const concern = [
      { role: 'metis' as const, verdict: 'advice' as const, summary: 'requirements clear', findings: [], recommendations: [] },
      { role: 'momus' as const, verdict: 'concern' as const, summary: 'decisive blocker', findings: ['unsafe dependency'], recommendations: ['repair it'] },
      { role: 'oracle' as const, verdict: 'advice' as const, summary: 'architecture clear', findings: [], recommendations: [] },
    ]
    for (let attempt = 1; attempt <= MAX_PLAN_REVIEW_ATTEMPTS; attempt += 1) {
      const reviewing = await ctx.autonomy.beginPlanReview(agent)
      if (attempt === MAX_PLAN_REVIEW_ATTEMPTS) ctx.goals.disarm(agent)
      await ctx.autonomy.settlePlanReview(agent, reviewing.plan!.revision, concern)
    }
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('manages plan replacement, addition, ordering, readiness, and task evidence', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'task graph' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    expect(ctx.autonomy.readyTasks(agent)).toEqual([])
    await expect(ctx.autonomy.addTasks(agent, [task('late')])).rejects.toThrow(/initial plan/)
    await expect(ctx.autonomy.reorderTasks(agent, ['late'])).rejects.toThrow(/initial plan/)
    await expect(ctx.autonomy.updateTask(agent, 'late', 'start')).rejects.toThrow(/no task plan/)

    await recordTestInterview(ctx, agent)
    await ctx.autonomy.setPlan(agent, ['first'], [task('old')])
    await ctx.autonomy.setPlan(agent, ['new'], [task('build'), task('test', ['build'])])
    await ctx.autonomy.addTasks(agent, [task('review', ['test'])])
    await ctx.autonomy.reorderTasks(agent, ['build', 'review', 'test'])
    await approveTestPlan(ctx, agent)
    expect(ctx.autonomy.readyTasks(agent).map(item => item.id)).toEqual(['build'])
    await expect(ctx.autonomy.updateTask(agent, 'test', 'start')).rejects.toMatchObject({
      code: 'RUN_TASK_DEPENDENCY_BLOCKED',
    })
    await ctx.autonomy.updateTask(agent, 'build', 'start')
    await expect(ctx.autonomy.setPlan(agent, ['locked'], [task('other')])).rejects.toMatchObject({
      code: 'RUN_PLAN_LOCKED',
    })
    await ctx.autonomy.updateTask(agent, 'build', 'complete', { evidence: [taskEvidence] })
    expect(ctx.autonomy.readyTasks(agent).map(item => item.id)).toEqual(['test'])
    await ctx.fiber.dispose()
  })

  it('claims ready tasks atomically and enforces concurrency plus lifetime budgets', async () => {
    const { ctx, agent } = await createServiceHarness({
      autonomy: { maxSubagents: 3, maxConcurrentSubagents: 2 },
    })
    const goal = ctx.goals.create(agent, { objective: 'delegate tasks' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await expect(ctx.autonomy.claimTasks(agent, ['missing'])).rejects.toThrow(/no task plan/)
    await recordTestInterview(ctx, agent)
    await ctx.autonomy.setPlan(agent, ['done'], [task('a'), task('b'), task('c'), task('d')])
    await approveTestPlan(ctx, agent)
    await expect(ctx.autonomy.claimTasks(agent, [])).rejects.toMatchObject({ code: 'RUN_PLAN_INVALID' })
    await expect(ctx.autonomy.claimTasks(agent, ['a', 'a'])).rejects.toMatchObject({ code: 'RUN_PLAN_INVALID' })
    await expect(ctx.autonomy.claimTasks(agent, ['a', 'b', 'c'])).rejects.toMatchObject({
      code: 'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
    })
    await expect(ctx.autonomy.claimTasks(agent, ['a', 'b'])).resolves.toMatchObject({ subagentsStarted: 2 })
    expect(ctx.autonomy.get(agent)?.plan?.tasks.slice(0, 2).map(item => item.status)).toEqual([
      'in_progress', 'in_progress',
    ])
    await expect(ctx.autonomy.claimTasks(agent, ['c'])).resolves.toMatchObject({ subagentsStarted: 3 })
    await expect(ctx.autonomy.claimTasks(agent, ['d'])).rejects.toMatchObject({
      code: 'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
    })
    await expect(ctx.autonomy.recordSubagentStarts(agent, 1)).rejects.toMatchObject({
      code: 'AUTONOMY_SUBAGENT_BUDGET_EXHAUSTED',
    })
    await expect(ctx.autonomy.recordSubagentStarts(agent, 0)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await ctx.fiber.dispose()
  })

  it('uses durable compare-and-set accounting under concurrent budget mutations', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { maxDynamicPackages: 1 } })
    const goal = ctx.goals.create(agent, { objective: 'concurrent accounting' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const results = await Promise.allSettled([
      ctx.autonomy.recordDynamicPackage(agent),
      ctx.autonomy.recordDynamicPackage(agent),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(ctx.autonomy.get(agent)?.dynamicPackages).toBe(1)
    await expect(ctx.autonomy.recordDynamicPackage(agent)).rejects.toThrow(/budget exhausted/)
    await ctx.fiber.dispose()
  })
})

describe('AutonomyService durable dynamic extensions', () => {
  const validRequest = {
    logicalId: 'formatter',
    name: ' Formatter ',
    purpose: ' Format generated files ',
    hostCode: ' export default function apply() {} ',
    sourceSha256: 'a'.repeat(64),
  }

  async function dynamicHarness(autonomy: AutonomyServiceConfig = {}) {
    const harness = await createServiceHarness({
      autonomy: { selfModification: 'host-only', ...autonomy },
    })
    const goal = harness.ctx.goals.create(harness.agent, { objective: 'extend Cordis safely' })
    await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
    return harness
  }

  it('validates authorization, identity, required source, and digest', async () => {
    const disabled = await dynamicHarness({ selfModification: 'off' })
    await expect(disabled.ctx.autonomy.beginDynamicExtension(disabled.agent, validRequest)).rejects.toThrow(
      /disabled/,
    )
    await disabled.ctx.fiber.dispose()

    const harness = await dynamicHarness()
    await expect(harness.ctx.autonomy.beginDynamicExtension(harness.agent, {
      ...validRequest, logicalId: 'Bad_Id',
    })).rejects.toThrow(/logicalId/)
    for (const request of [
      { ...validRequest, name: ' ' },
      { ...validRequest, purpose: '' },
      { ...validRequest, hostCode: ' ' },
    ]) {
      await expect(harness.ctx.autonomy.beginDynamicExtension(harness.agent, request)).rejects.toThrow(
        /must not be empty/,
      )
    }
    await expect(harness.ctx.autonomy.beginDynamicExtension(harness.agent, {
      ...validRequest, sourceSha256: 'not-a-digest',
    })).rejects.toThrow(/sourceSha256/)
    await harness.ctx.fiber.dispose()
  })

  it('versions, activates, supersedes, removes, and budgets extensions durably', async () => {
    const harness = await dynamicHarness({ maxDynamicPackages: 3 })
    const first = await harness.ctx.autonomy.beginDynamicExtension(harness.agent, validRequest)
    expect(first.extension).toMatchObject({
      logicalId: 'formatter',
      version: 1,
      name: 'Formatter',
      purpose: 'Format generated files',
      hostCode: 'export default function apply() {}',
      status: 'applying',
    })
    expect(first.view).toMatchObject({ dynamicPackages: 1, dynamicExtensions: [first.extension] })
    await expect(harness.ctx.autonomy.beginDynamicExtension(harness.agent, validRequest)).rejects.toThrow(
      /already has an applying version/,
    )
    await expect(harness.ctx.autonomy.settleDynamicExtension(
      harness.agent, 'formatter', 99, { ok: true },
    )).rejects.toThrow(/is not applying/)
    await harness.ctx.autonomy.settleDynamicExtension(harness.agent, 'formatter', 1, { ok: true })
    await expect(harness.ctx.autonomy.settleDynamicExtension(
      harness.agent, 'formatter', 1, { ok: true },
    )).rejects.toThrow(/is not applying/)

    const second = await harness.ctx.autonomy.beginDynamicExtension(harness.agent, {
      ...validRequest,
      hostCode: 'export default function applyV2() {}',
      sourceSha256: 'b'.repeat(64),
    })
    expect(second.extension.version).toBe(2)
    const beta = await harness.ctx.autonomy.beginDynamicExtension(harness.agent, {
      ...validRequest,
      logicalId: 'linter',
      name: 'Linter',
      sourceSha256: 'c'.repeat(64),
    })
    expect(beta.extension.version).toBe(1)
    const activated = await harness.ctx.autonomy.settleDynamicExtension(
      harness.agent, 'formatter', 2, { ok: true },
    )
    expect(activated.dynamicExtensions).toEqual([
      expect.objectContaining({ logicalId: 'formatter', version: 1, status: 'superseded' }),
      expect.objectContaining({ logicalId: 'formatter', version: 2, status: 'active' }),
      expect.objectContaining({ logicalId: 'linter', version: 1, status: 'applying' }),
    ])
    await expect(harness.ctx.autonomy.removeDynamicExtension(harness.agent, 'formatter', ' ')).rejects.toThrow(
      /requires a reason/,
    )
    await expect(harness.ctx.autonomy.removeDynamicExtension(harness.agent, 'missing', 'unused')).rejects.toThrow(
      /has no active version/,
    )
    const removing = await harness.ctx.autonomy.beginDynamicExtensionRemoval(
      harness.agent, 'formatter', ' superseded by static implementation ',
    )
    expect(removing.view.dynamicExtensions).toEqual([
      expect.objectContaining({ version: 1, status: 'superseded' }),
      expect.objectContaining({ version: 2, status: 'removing', reason: 'superseded by static implementation' }),
      expect.objectContaining({ logicalId: 'linter', status: 'applying' }),
    ])
    expect(removing.extensions).toEqual([expect.objectContaining({ version: 2, status: 'removing' })])
    const retry = await harness.ctx.autonomy.settleDynamicExtensionRemoval(
      harness.agent,
      'formatter',
      { ok: false, reason: 'host cleanup timed out' },
    )
    expect(retry.dynamicExtensions[1]).toMatchObject({ status: 'removing', reason: 'host cleanup timed out' })
    const defaultReason = await harness.ctx.autonomy.settleDynamicExtensionRemoval(
      harness.agent,
      'formatter',
      { ok: false, reason: ' ' },
    )
    expect(defaultReason.dynamicExtensions[1]).toMatchObject({
      status: 'removing', reason: 'dynamic extension cleanup failed',
    })
    const retriedRemoval = await harness.ctx.autonomy.beginDynamicExtensionRemoval(
      harness.agent,
      'formatter',
      'retry host cleanup',
    )
    expect(retriedRemoval.view.revision).toBe(defaultReason.revision)
    expect(retriedRemoval.extensions).toEqual([
      expect.objectContaining({ version: 2, status: 'removing', reason: 'dynamic extension cleanup failed' }),
    ])
    const removed = await harness.ctx.autonomy.settleDynamicExtensionRemoval(
      harness.agent,
      'formatter',
      { ok: true },
    )
    expect(removed.dynamicExtensions[1]).toMatchObject({ status: 'removed' })
    await expect(harness.ctx.autonomy.settleDynamicExtensionRemoval(
      harness.agent,
      'formatter',
      { ok: true },
    )).rejects.toThrow(/no cleanup-pending version/)
    await harness.ctx.autonomy.removeDynamicExtension(harness.agent, 'linter', 'cancelled')
    await harness.ctx.autonomy.settleDynamicExtensionRemoval(harness.agent, 'linter', { ok: true })
    await expect(harness.ctx.autonomy.beginDynamicExtension(harness.agent, {
      ...validRequest, logicalId: 'third',
    })).rejects.toThrow(/budget exhausted/)
    await harness.ctx.fiber.dispose()
  })

  it('blocks a replacement while host cleanup remains pending', async () => {
    const harness = await dynamicHarness({ maxDynamicPackages: 2 })
    const first = await harness.ctx.autonomy.beginDynamicExtension(harness.agent, validRequest)
    await harness.ctx.autonomy.settleDynamicExtension(
      harness.agent,
      first.extension.logicalId,
      first.extension.version,
      { ok: true },
    )
    await harness.ctx.autonomy.beginDynamicExtensionRemoval(
      harness.agent,
      first.extension.logicalId,
      'host cleanup pending',
    )
    await expect(harness.ctx.autonomy.beginDynamicExtension(harness.agent, validRequest)).rejects.toThrow(
      /removing version/,
    )
    await harness.ctx.fiber.dispose()
  })

  it('records failed activation reasons and permits a later version', async () => {
    const harness = await dynamicHarness({ maxDynamicPackages: 2, selfModification: 'client-approved' })
    const first = await harness.ctx.autonomy.beginDynamicExtension(harness.agent, validRequest)
    const failed = await harness.ctx.autonomy.settleDynamicExtension(
      harness.agent,
      first.extension.logicalId,
      first.extension.version,
      { ok: false, reason: ' ' },
    )
    expect(failed.dynamicExtensions).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'dynamic extension activation failed' }),
    ])
    await expect(harness.ctx.autonomy.removeDynamicExtension(
      harness.agent, first.extension.logicalId, 'remove failed',
    )).rejects.toThrow(/has no active version/)
    const second = await harness.ctx.autonomy.beginDynamicExtension(harness.agent, validRequest)
    expect(second.extension.version).toBe(2)
    const failedAgain = await harness.ctx.autonomy.settleDynamicExtension(
      harness.agent,
      second.extension.logicalId,
      second.extension.version,
      { ok: false, reason: 'health check failed' },
    )
    expect(failedAgain.dynamicExtensions[1]).toMatchObject({
      status: 'failed', reason: 'health check failed',
    })
    await harness.ctx.fiber.dispose()
  })
})

describe('AutonomyService verification state machine', () => {
  it('requires the canonical execution stage even when the durable graph is complete', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    const current = latestSnapshot(harness.ctx, harness.agent)
    await probe(harness.ctx.autonomy).store!.append('plan', {
      ...current,
      revision: current.revision + 1,
      updatedAt: current.updatedAt + 1,
      flow: {
        ...current.flow,
        revision: current.flow.revision + 1,
        stage: 'planning',
        cycle: current.flow.cycle + 1,
        updatedAt: current.updatedAt + 1,
      },
    })
    await expect(harness.ctx.autonomy.beginVerification(harness.agent, {
      summary: 'candidate', evidence: ['tests'],
    })).rejects.toThrow(/canonical execution stage/)
    await harness.ctx.fiber.dispose()
  })

  it('requires a complete evidenced graph and records failed then passing quorum results', async () => {
    const harness = await startPlannedRun({ autonomy: { maxVerificationAttempts: 2 } })
    const { ctx, agent } = harness
    await expect(ctx.autonomy.beginVerification(agent, { summary: 'early', evidence: [] })).rejects.toMatchObject({
      code: 'AUTONOMY_PLAN_INCOMPLETE',
    })
    await completeTaskGraph(harness)
    await expect(ctx.autonomy.beginVerification(agent, {
      summary: 'candidate one',
      evidence: ['pnpm test'],
    })).resolves.toMatchObject({ phase: 'verifying', verificationAttempts: 1 })
    await expect(ctx.autonomy.recordSubagentStarts(agent, 1)).resolves.toMatchObject({ subagentsStarted: 1 })
    await expect(ctx.autonomy.beginVerification(agent, { summary: 'twice', evidence: [] })).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(ctx.autonomy.recordDynamicPackage(agent)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(ctx.autonomy.verificationFailed(agent, verification('pass'))).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(ctx.autonomy.verificationFailed(agent, verification('inconclusive'))).resolves.toMatchObject({
      phase: 'running',
      reason: 'inconclusive verification',
      verificationHistory: [expect.objectContaining({ verdict: 'inconclusive' })],
    })
    await ctx.autonomy.beginVerification(agent, { summary: 'candidate two', evidence: ['report'] })
    await expect(ctx.autonomy.complete(agent, verification('fail', 2))).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(ctx.autonomy.complete(agent, verification('pass', 2))).resolves.toMatchObject({
      phase: 'completed',
      activation: 'disarmed',
      verificationAttempts: 2,
      verificationHistory: [
        expect.objectContaining({ verdict: 'inconclusive' }),
        expect.objectContaining({ verdict: 'pass' }),
      ],
    })
    await expect(ctx.autonomy.pause(agent)).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await ctx.fiber.dispose()
  })

  it('returns failed verification to work and enforces its durable attempt ceiling', async () => {
    const harness = await startPlannedRun({ autonomy: { maxVerificationAttempts: 1 } })
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.verificationFailed(harness.agent, verification('fail'))
    await expect(harness.ctx.autonomy.beginVerification(harness.agent, {
      summary: 'retry', evidence: ['tests'],
    })).rejects.toMatchObject({ code: 'AUTONOMY_VERIFICATION_EXHAUSTED' })
    await expect(harness.ctx.autonomy.complete(harness.agent, verification('pass'))).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await expect(harness.ctx.autonomy.verificationFailed(harness.agent, verification('fail'))).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await harness.ctx.fiber.dispose()
  })

  it('pauses and disarms after verifier infrastructure errors', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    const signal = harness.ctx.autonomy.signal(harness.agent)
    await expect(harness.ctx.autonomy.verificationErrored(
      harness.agent,
      verification('error', 1, 'review provider unavailable'),
    )).resolves.toMatchObject({
      phase: 'paused',
      activation: 'disarmed',
      reason: 'review provider unavailable',
      verificationHistory: [expect.objectContaining({ verdict: 'error' })],
    })
    expect(signal.aborted).toBe(true)
    await expect(harness.ctx.autonomy.verificationErrored(
      harness.agent,
      verification('error', 2),
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await expect(harness.ctx.autonomy.recordSubagentStarts(harness.agent, 1)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await harness.ctx.fiber.dispose()
  })

  it('settles verifier outcomes safely after host disposal disarms the runtime', async () => {
    const errored = await startPlannedRun()
    await completeTaskGraph(errored)
    await errored.ctx.autonomy.beginVerification(errored.agent, {
      summary: 'error candidate', evidence: ['tests'],
    })
    agentEvents(errored.ctx, errored.agent).emit('agent/disposed', {})
    await expect(errored.ctx.autonomy.verificationErrored(
      errored.agent,
      verification('error'),
    )).resolves.toMatchObject({ phase: 'paused', activation: 'disarmed' })
    await errored.ctx.fiber.dispose()

    const passed = await startPlannedRun()
    await completeTaskGraph(passed)
    await passed.ctx.autonomy.beginVerification(passed.agent, {
      summary: 'pass candidate', evidence: ['tests'],
    })
    agentEvents(passed.ctx, passed.agent).emit('agent/disposed', {})
    await expect(passed.ctx.autonomy.complete(passed.agent, verification('pass'))).resolves.toMatchObject({
      phase: 'completed',
      activation: 'disarmed',
    })
    await passed.ctx.fiber.dispose()
  })

  it('durably reserves verification before Goal completion and acknowledges feedback separately', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, {
      summary: 'verified candidate', evidence: ['focused tests'],
    })
    const signal = harness.ctx.autonomy.signal(harness.agent)
    const pass = verification('pass')

    const finalizing = await harness.ctx.autonomy.beginFinalization(harness.agent, pass)
    expect(finalizing).toMatchObject({ phase: 'finalizing', activation: 'disarmed' })
    expect(signal.aborted).toBe(true)
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({
      phase: 'finalizing',
      finalization: pass,
      verificationHistory: [],
      completionReported: false,
    })

    const activeGoal = harness.ctx.goals.get(harness.agent)
    if (activeGoal === undefined) throw new Error('fixture Goal is missing')
    const completed = await harness.ctx.autonomy.finalizeCompletion(harness.agent, activeGoal)
    expect(completed).toMatchObject({
      goal: { phase: 'complete' },
      view: {
        phase: 'completed',
        activation: 'disarmed',
        verificationHistory: [pass],
        completionReported: false,
      },
      notice: {
        id: `${finalizing.id}:completion`,
        runId: finalizing.id,
        goalId: harness.goal.id,
        summary: 'pass verification',
      },
    })
    expect(latestSnapshot(harness.ctx, harness.agent)).not.toHaveProperty('finalization')
    const completedRef = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    await expect(harness.ctx.autonomy.completionNotice(completedRef)).resolves.toEqual(completed.notice)
    await expect(harness.ctx.autonomy.completionNotice(recoveryRef({
      ...latestSnapshot(harness.ctx, harness.agent), revision: 1,
    }))).rejects.toThrow(/stale/)
    await harness.ctx.autonomy.markCompletionReported(completedRef)
    const reported = latestSnapshot(harness.ctx, harness.agent)
    expect(reported).toMatchObject({ phase: 'completed', completionReported: true })
    await expect(harness.ctx.autonomy.completionNotice(recoveryRef(reported))).resolves.toBeUndefined()
    await expect(harness.ctx.autonomy.markCompletionReported(recoveryRef(reported))).resolves.toBeUndefined()
    await expect(harness.ctx.autonomy.markCompletionReported(completedRef)).resolves.toBeUndefined()
    expect(harness.ctx.autonomy.history(harness.agent).map(item => item.operation).slice(-3)).toEqual([
      'finalization-start', 'finalization-complete', 'completion-reported',
    ])
    await harness.ctx.fiber.dispose()
  })

  it('converges a Goal already completed after the durable finalization reservation', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    harness.ctx.goals.disarm(harness.agent)
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const active = harness.ctx.goals.get(harness.agent)
    if (active === undefined) throw new Error('fixture Goal is missing')
    const complete = harness.ctx.goals.complete(harness.agent, active)

    await expect(harness.ctx.autonomy.finalizeCompletion(harness.agent, complete)).resolves.toMatchObject({
      goal: { phase: 'complete', revision: complete.revision },
      view: { phase: 'completed' },
    })
    await harness.ctx.fiber.dispose()
  })

  it('leaves a retryable finalizing row when sidecar completion fails after Goal completion', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const store = probe(harness.ctx.autonomy).store
    const goal = harness.ctx.goals.get(harness.agent)
    if (store === undefined || goal === undefined) throw new Error('fixture finalization state is missing')
    const append = vi.spyOn(store, 'appendIfCurrent').mockRejectedValueOnce(new Error('sidecar unavailable'))

    await expect(harness.ctx.autonomy.finalizeCompletion(harness.agent, goal)).rejects.toThrow(/sidecar unavailable/)
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ phase: 'complete' })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ phase: 'finalizing' })
    append.mockRestore()
    const completedGoal = harness.ctx.goals.get(harness.agent)
    if (completedGoal === undefined) throw new Error('fixture completed Goal is missing')
    await expect(harness.ctx.autonomy.finalizeCompletion(harness.agent, completedGoal)).resolves.toMatchObject({
      view: { phase: 'completed' },
    })
    await harness.ctx.fiber.dispose()
  })

  it('disarms both authorization planes when the finalization reservation cannot persist', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    const signal = harness.ctx.autonomy.signal(harness.agent)
    const store = probe(harness.ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    vi.spyOn(store, 'appendIfCurrent').mockRejectedValueOnce(new Error('finalization store unavailable'))

    await expect(harness.ctx.autonomy.beginFinalization(
      harness.agent,
      verification('pass'),
    )).rejects.toThrow(/finalization store unavailable/)
    expect(signal.aborted).toBe(true)
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      phase: 'verifying', activation: 'disarmed',
    })
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ activation: 'disarmed' })
    await harness.ctx.fiber.dispose()
  })

  it('fails finalization closed on invalid evidence or Goal identity drift', async () => {
    const invalid = await startPlannedRun()
    await completeTaskGraph(invalid)
    await invalid.ctx.autonomy.beginVerification(invalid.agent, { summary: 'candidate', evidence: ['tests'] })
    await expect(invalid.ctx.autonomy.beginFinalization(invalid.agent, verification('fail'))).rejects.toThrow(
      /passing verification/,
    )
    await expect(invalid.ctx.autonomy.beginFinalization(invalid.agent, verification('pass', 2))).rejects.toThrow(
      /current attempt/,
    )
    await invalid.ctx.fiber.dispose()

    const missing = await startPlannedRun()
    await completeTaskGraph(missing)
    await missing.ctx.autonomy.beginVerification(missing.agent, { summary: 'candidate', evidence: ['tests'] })
    vi.spyOn(missing.ctx.goals, 'get').mockReturnValue(undefined)
    await expect(missing.ctx.autonomy.complete(missing.agent, verification('pass'))).rejects.toThrow(
      /current Goal is missing/,
    )
    expect(missing.ctx.autonomy.get(missing.agent)).toMatchObject({ phase: 'finalizing' })
    await missing.ctx.fiber.dispose()

    const drift = await startPlannedRun()
    await completeTaskGraph(drift)
    await drift.ctx.autonomy.beginVerification(drift.agent, { summary: 'candidate', evidence: ['tests'] })
    await drift.ctx.autonomy.beginFinalization(drift.agent, verification('pass'))
    const goal = drift.ctx.goals.get(drift.agent)
    if (goal === undefined) throw new Error('fixture Goal is missing')
    await expect(drift.ctx.autonomy.finalizeCompletion(drift.agent, {
      id: goal.id,
      revision: goal.revision + 1,
    })).rejects.toThrow(/Goal changed/)
    expect(drift.ctx.autonomy.get(drift.agent)).toMatchObject({
      phase: 'needs-attention', reason: /Goal changed/,
    })
    await expect(drift.ctx.autonomy.finalizeCompletion(drift.agent, goal)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    await drift.ctx.fiber.dispose()
  })

  it('contains post-commit completion observer failure without reopening completion', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const logged = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => harness.ctx.logger)
    harness.ctx.on('autonomy/changed', ({ operation }) => {
      if (operation === 'finalization-complete') throw new Error('observer unavailable')
    })
    const goal = harness.ctx.goals.get(harness.agent)
    if (goal === undefined) throw new Error('fixture Goal is missing')

    await expect(harness.ctx.autonomy.finalizeCompletion(harness.agent, goal)).resolves.toMatchObject({
      view: { phase: 'completed' },
    })
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/finalization-complete notification failed.*observer unavailable/),
    )
    await harness.ctx.fiber.dispose()
  })

  it('acknowledges completion only after an assistant message and retries a failed acknowledgement', async () => {
    const harness = await startPlannedRun()
    emitAssistantMessage(harness.ctx, harness.agent, 'unrelated earlier answer')
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const goal = harness.ctx.goals.get(harness.agent)
    if (goal === undefined) throw new Error('fixture Goal is missing')
    const finalized = await harness.ctx.autonomy.finalizeCompletion(harness.agent, goal)
    expect(finalized.view.completionReported).toBe(false)
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    const messageId = MessageId(`dsh-autopilot:${finalized.notice.id}`)
    await harness.ctx.autonomy.registerCompletionDelivery(expected, harness.agent, messageId)
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'turn/end',
      seq: harness.agent.session.events.length,
      time: Date.now(),
      data: {},
    } as never)
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ completionReported: false })

    const store = probe(harness.ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    vi.spyOn(store, 'reduceCurrent').mockRejectedValueOnce(new Error('notice store unavailable'))
    const logged = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => harness.ctx.logger)
    emitCompletionTurn(harness.ctx, harness.agent, messageId)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/acknowledge completion.*notice store unavailable/))
    })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ completionReported: false })

    emitAssistantMessage(harness.ctx, harness.agent, 'retry acknowledgement trigger', 2)
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ completionReported: true })
    })
    await harness.ctx.fiber.dispose()
  })

  it.each([
    ['max-tokens', { kind: 'max-tokens' } as TurnEndReason, undefined],
    ['aborted', { kind: 'aborted', reason: { kind: 'user' } } as TurnEndReason, undefined],
    ['no assistant text', { kind: 'completed' } as TurnEndReason, '   '],
  ])('redelivers the deterministic completion notice after a %s report turn', async (
    _label,
    reason,
    assistantText,
  ) => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)

    emitFailedCompletionTurn(harness.ctx, harness.agent, messageId, 1, reason, assistantText)
    await vi.waitFor(() => {
      expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({
        completionDeliveryAttempts: 1,
        completionDeliveryExhausted: false,
      })
      expect(harness.agent.followup).toHaveBeenCalledOnce()
    })
    expect(harness.agent.followup).toHaveBeenCalledWith(expect.objectContaining({
      id: messageId,
      content: [{ type: 'text', text: expect.stringContaining('Deliver the final user-facing completion report') }],
    }))

    emitCompletionTurn(harness.ctx, harness.agent, messageId, 2)
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ completionReported: true })
    })
    expect(latestSnapshot(harness.ctx, harness.agent).reason).toBeUndefined()
    expect(harness.ctx.autonomy.history(harness.agent).slice(-2).map(record => record.operation)).toEqual([
      'completion-delivery-failed',
      'completion-reported',
    ])
    await harness.ctx.fiber.dispose()
  })

  it('redelivers an exact claimed completion notice after agent/error without double-counting turn/end', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)
    const message = completionUserMessage(messageId)
    agentEvents(harness.ctx, harness.agent).emit('agent/inbox/claimed', { message, turn: 1 })
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'user/message', seq: 1, time: Date.now(), data: message,
    })

    agentEvents(harness.ctx, harness.agent).emit('agent/error', {
      turn: 1, step: 1, error: new Error('provider failed'),
    })
    await vi.waitFor(() => {
      expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({
        completionDeliveryAttempts: 1,
        reason: expect.stringContaining('agent/error'),
      })
      expect(harness.agent.followup).toHaveBeenCalledOnce()
    })
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'turn/end', seq: 2, time: Date.now(),
      data: { turn: 1, reason: { kind: 'error', error: { message: 'provider failed', code: 'UNKNOWN' } } },
    })
    await Promise.resolve()
    expect(latestSnapshot(harness.ctx, harness.agent).completionDeliveryAttempts).toBe(1)

    emitCompletionTurn(harness.ctx, harness.agent, messageId, 2)
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ completionReported: true })
    })
    await harness.ctx.fiber.dispose()
  })

  it('tracks only matching inbox splices from the owning Session', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)
    const pending = probe(harness.ctx.autonomy).pendingCompletionReports.get(String(harness.agent.id))
    if (pending === undefined) throw new Error('fixture completion delivery is missing')
    pending.redeliveryPending = true

    const alias = createTestAgent(String(harness.agent.id))
    harness.ctx.emit('session/event', alias.session, {
      type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'agent/inbox/spliced',
      seq: 2,
      time: Date.now(),
      data: {
        target: 'next-turn',
        start: 0,
        inserted: [completionUserMessage(MessageId('unrelated-completion-notice'))],
      },
    })
    expect(pending.redeliveryPending).toBe(true)
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'agent/inbox/spliced',
      seq: 3,
      time: Date.now(),
      data: { target: 'next-turn', start: 0, inserted: [completionUserMessage(messageId)] },
    })
    expect(pending.redeliveryPending).toBe(false)

    agentEvents(harness.ctx, harness.agent).emit('agent/inbox/claimed', {
      message: completionUserMessage(messageId),
      turn: 4,
    })
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'agent/inbox/spliced',
      seq: 4,
      time: Date.now(),
      data: { target: 'next-turn', start: 0, inserted: [] },
    })
    expect(pending.claimedTurn).toBe(4)
    await harness.ctx.fiber.dispose()
  })

  it('deduplicates completion retries and rejects stale requeues', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)
    const internals = probe(harness.ctx.autonomy)
    const pending = internals.pendingCompletionReports.get(String(harness.agent.id))
    if (pending === undefined) throw new Error('fixture completion delivery is missing')

    internals.retryCompletionDelivery(pending, 'unclaimed duplicate')
    pending.claimedTurn = 1
    pending.retrying = Promise.resolve()
    internals.retryCompletionDelivery(pending, 'in-flight duplicate')
    pending.retrying = undefined

    pending.redeliveryPending = false
    internals.resumePendingCompletion(harness.agent)
    pending.redeliveryPending = true
    vi.mocked(harness.agent.followup).mockImplementationOnce(() => { throw new Error('requeue unavailable') })
    const logged = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => harness.ctx.logger)
    internals.resumePendingCompletion(harness.agent)
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/requeue failed.*requeue unavailable/))

    harness.agent.inbox.append('next-turn', completionUserMessage(messageId))
    internals.enqueueCompletionDelivery(pending)
    expect(pending.redeliveryPending).toBe(false)
    harness.agent.inbox.clear()
    harness.agent.inbox.append('next-step', completionUserMessage(messageId))
    internals.enqueueCompletionDelivery(pending)
    expect(pending.redeliveryPending).toBe(false)

    await harness.ctx.autonomy.markCompletionReported(harness.ref)
    internals.enqueueCompletionDelivery(pending)
    expect(internals.pendingCompletionReports.has(String(harness.agent.id))).toBe(false)
    await harness.ctx.fiber.dispose()
  })

  it('contains stale completion-delivery reducers and post-commit races', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)
    const internals = probe(harness.ctx.autonomy)
    const pending = internals.pendingCompletionReports.get(String(harness.agent.id))
    const store = internals.store
    if (pending === undefined || store === undefined) throw new Error('fixture completion internals are missing')
    const snapshot = latestSnapshot(harness.ctx, harness.agent)
    vi.spyOn(store, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reducer) => {
      const operation = reducer({ ...snapshot, completionDeliveryAttempts: undefined })
      if (operation === undefined) throw new Error('fixture reducer did not produce a mutation')
      return operation.snapshot
    })

    await internals.persistCompletionDeliveryFailure(pending, 'legacy retry')
    expect(internals.pendingCompletionReports.has(String(harness.agent.id))).toBe(false)
    await expect(internals.persistCompletionDeliveryFailure(pending, 'stale retry')).rejects.toThrow(
      /no longer matches/,
    )
    await harness.ctx.fiber.dispose()
  })

  it('keeps a failed report enqueue pending and retries it when the Agent becomes idle', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    vi.mocked(harness.agent.followup)
      .mockImplementationOnce(() => { throw new Error('inbox unavailable') })
      .mockImplementationOnce(() => {})
    const logged = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => harness.ctx.logger)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)

    emitFailedCompletionTurn(harness.ctx, harness.agent, messageId, 1, { kind: 'max-tokens' })
    await vi.waitFor(() => {
      expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({ completionDeliveryAttempts: 1 })
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/delivery stalled.*inbox unavailable/))
    })
    await Promise.resolve()
    agentEvents(harness.ctx, harness.agent).emit('agent/status', { status: 'idle' })
    expect(harness.agent.followup).toHaveBeenCalledTimes(2)

    emitCompletionTurn(harness.ctx, harness.agent, messageId, 2)
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ completionReported: true })
    })
    await harness.ctx.fiber.dispose()
  })

  it('persists completion delivery exhaustion and stops automatic report turns at the retry ceiling', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    const logged = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => harness.ctx.logger)
    const flush = vi.spyOn(harness.ctx.sessions, 'flush')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)

    emitFailedCompletionTurn(
      harness.ctx,
      harness.agent,
      messageId,
      1,
      { kind: 'max-tokens' },
    )
    await vi.waitFor(() => expect(harness.agent.followup).toHaveBeenCalledTimes(1))
    emitFailedCompletionTurn(
      harness.ctx,
      harness.agent,
      messageId,
      2,
      { kind: 'aborted', reason: { kind: 'user' } },
    )
    await vi.waitFor(() => expect(harness.agent.followup).toHaveBeenCalledTimes(2))
    emitFailedCompletionTurn(
      harness.ctx,
      harness.agent,
      messageId,
      3,
      { kind: 'completed' },
      undefined,
      false,
    )

    await vi.waitFor(() => {
      expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({
        phase: 'completed',
        completionReported: false,
        completionDeliveryAttempts: 3,
        completionDeliveryExhausted: true,
        completionDeliveryExhaustionNotified: false,
        reason: expect.stringContaining('without admitting the notice'),
      })
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/delivery exhausted after 3 attempts/))
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/exhaustion notice requires configured session persistence/))
    })
    expect(harness.agent.followup).toHaveBeenCalledTimes(2)
    const terminalMessages = () => harness.agent.session.events.filter(event =>
      event.type === 'user/message' && String(event.data.id).endsWith(':delivery-exhausted'))
    expect(terminalMessages()).toHaveLength(1)
    expect(terminalMessages()[0]).toMatchObject({
      data: {
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-autopilot', form: 'notice' },
        content: [{
          type: 'text',
          text: expect.stringMatching(/acceptance passed.*failed to produce.*\/autopilot audit/),
        }],
      },
    })

    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      recoveryRef(latestSnapshot(harness.ctx, harness.agent)),
      harness.agent,
      messageId,
    )).rejects.toThrow(/retries are exhausted/)
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/failed to expose exhausted completion delivery/))

    await Promise.resolve()
    agentEvents(harness.ctx, harness.agent).emit('agent/status', { status: 'idle' })
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringMatching(
      /failed to expose exhausted completion delivery.*session persistence/,
    )))
    const pending = probe(harness.ctx.autonomy).pendingCompletionReports.get(String(harness.agent.id))
    await vi.waitFor(() => expect(pending?.retrying).toBeUndefined())
    agentEvents(harness.ctx, harness.agent).emit('agent/status', { status: 'idle' })
    await vi.waitFor(() => {
      expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({
        completionDeliveryExhaustionNotified: true,
      })
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
        completionDeliveryAttempts: 3,
        completionDeliveryExhausted: true,
        completionDeliveryExhaustionNotified: true,
        reason: expect.stringContaining('without admitting the notice'),
      })
    })
    expect(flush).toHaveBeenCalledTimes(4)
    expect(terminalMessages()).toHaveLength(1)
    expect(harness.ctx.autonomy.history(harness.agent).slice(-4).map(record => record.operation)).toEqual([
      'completion-delivery-failed',
      'completion-delivery-failed',
      'completion-delivery-failed',
      'completion-delivery-exhaustion-notified',
    ])
    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      recoveryRef(latestSnapshot(harness.ctx, harness.agent)),
      harness.agent,
      messageId,
    )).rejects.toThrow(/retries are exhausted/)
    expect(harness.agent.followup).toHaveBeenCalledTimes(2)
    expect(terminalMessages()).toHaveLength(1)
    await harness.ctx.fiber.dispose()
  })

  it('publishes and clears a terminal Host notice when the retry ceiling is persisted', async () => {
    const harness = await completedRun()
    const messageId = MessageId(`dsh-autopilot:${harness.ref.runId}:completion`)
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)
    const internals = probe(harness.ctx.autonomy)
    const pending = internals.pendingCompletionReports.get(String(harness.agent.id))
    if (pending === undefined) throw new Error('fixture completion delivery is missing')

    await internals.persistCompletionDeliveryFailure(pending, 'first failed report')
    await internals.persistCompletionDeliveryFailure(pending, 'second failed report')
    await internals.persistCompletionDeliveryFailure(pending, 'third failed report')

    expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({
      completionDeliveryAttempts: 3,
      completionDeliveryExhausted: true,
      completionDeliveryExhaustionNotified: true,
    })
    expect(internals.pendingCompletionReports.has(String(harness.agent.id))).toBe(false)
    await harness.ctx.fiber.dispose()
  })

  it('rejects invalid, colliding, and concurrently converged exhaustion notices', async () => {
    const invalid = await completedRun()
    await expect(probe(invalid.ctx.autonomy).ensureCompletionExhaustionNotice(
      invalid.ref,
      invalid.agent,
    )).rejects.toThrow(/no longer matches its outbox/)
    await invalid.ctx.fiber.dispose()

    const colliding = await completedRun()
    const collidingId = MessageId(`dsh-autopilot:${colliding.ref.runId}:completion`)
    await colliding.ctx.autonomy.registerCompletionDelivery(colliding.ref, colliding.agent, collidingId)
    const collidingInternals = probe(colliding.ctx.autonomy)
    const collidingPending = collidingInternals.pendingCompletionReports.get(String(colliding.agent.id))
    if (collidingPending === undefined) throw new Error('fixture completion delivery is missing')
    await collidingInternals.persistCompletionDeliveryFailure(collidingPending, 'first failed report')
    await collidingInternals.persistCompletionDeliveryFailure(collidingPending, 'second failed report')
    const exhaustionId = MessageId(`dsh-autopilot:${colliding.ref.runId}:completion:delivery-exhausted`)
    colliding.agent.session.append('user/message', freezeMessage({
      id: exhaustionId,
      role: 'user',
      content: [{ type: 'text', text: 'unrelated colliding message' }],
      source: { kind: 'plugin', plugin: 'another-plugin', form: 'notice', summary: 'collision' },
    }), { surfaceOp: 'append' })
    await expect(collidingInternals.persistCompletionDeliveryFailure(
      collidingPending,
      'third failed report',
    )).rejects.toThrow(/already in use/)
    await colliding.ctx.fiber.dispose()

    const converging = await completedRun()
    const convergingId = MessageId(`dsh-autopilot:${converging.ref.runId}:completion`)
    await converging.ctx.autonomy.registerCompletionDelivery(converging.ref, converging.agent, convergingId)
    const convergingInternals = probe(converging.ctx.autonomy)
    const convergingPending = convergingInternals.pendingCompletionReports.get(String(converging.agent.id))
    const store = convergingInternals.store
    if (convergingPending === undefined || store === undefined) throw new Error('fixture completion internals are missing')
    await convergingInternals.persistCompletionDeliveryFailure(convergingPending, 'first failed report')
    await convergingInternals.persistCompletionDeliveryFailure(convergingPending, 'second failed report')
    const flush = vi.spyOn(converging.ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(convergingInternals.persistCompletionDeliveryFailure(
      convergingPending,
      'third failed report',
    )).rejects.toThrow(/requires configured session persistence/)
    flush.mockResolvedValue(true)
    const exhausted = latestSnapshot(converging.ctx, converging.agent)
    vi.spyOn(store, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reducer) => {
      expect(reducer({ ...exhausted, completionDeliveryExhaustionNotified: true })).toBeUndefined()
      return undefined
    })
    await expect(convergingInternals.ensureCompletionExhaustionNotice(
      recoveryRef(exhausted),
      converging.agent,
    )).resolves.toMatchObject({ completionDeliveryExhaustionNotified: true })
    vi.spyOn(store, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reducer) => {
      const operation = reducer(undefined)
      return operation?.snapshot
    })
    await expect(convergingInternals.ensureCompletionExhaustionNotice(
      recoveryRef(exhausted),
      converging.agent,
    )).rejects.toThrow(/no longer matches its outbox/)
    await converging.ctx.fiber.dispose()
  })

  it('validates cold completion-delivery ownership and exact pending revision', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const goal = harness.ctx.goals.get(harness.agent)
    if (goal === undefined) throw new Error('fixture Goal is missing')
    await harness.ctx.autonomy.finalizeCompletion(harness.agent, goal)
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))

    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      expected,
      createTestAgent('wrong-completion-owner'),
      MessageId('completion-test'),
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      { ...expected, revision: expected.revision - 1 },
      harness.agent,
      MessageId('completion-test'),
    )).rejects.toThrow(/no longer matches/)
    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      expected,
      harness.agent,
      MessageId('completion-test'),
    )).resolves.toBe('registered')
    await harness.ctx.autonomy.markCompletionReported(expected)
    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      recoveryRef(latestSnapshot(harness.ctx, harness.agent)),
      harness.agent,
      MessageId('completion-test'),
    )).rejects.toThrow(/no longer matches/)
    await harness.ctx.fiber.dispose()
  })

  it('rejects a corrupt completed row before it can reach completion delivery', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'defensive completion read' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const current = latestSnapshot(ctx, agent)
    const store = probe(ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    const completed = Object.freeze({
      ...current,
      revision: current.revision + 1,
      updatedAt: current.updatedAt + 1,
      phase: 'completed' as const,
      expiresAt: undefined,
      verificationHistory: Object.freeze([]),
    })
    await expect(store.append('finalization-complete', completed)).rejects.toThrow(/completed canonical flow/)
    await ctx.fiber.dispose()
  })

  it('acknowledges a pending row without process-local delivery state', async () => {
    const harness = await startPlannedRun()
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const goal = harness.ctx.goals.get(harness.agent)
    if (goal === undefined) throw new Error('fixture Goal is missing')
    await harness.ctx.autonomy.finalizeCompletion(harness.agent, goal)
    const completed = latestSnapshot(harness.ctx, harness.agent)

    await harness.ctx.autonomy.markCompletionReported(recoveryRef(completed))
    expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({ completionReported: true })
    await harness.ctx.fiber.dispose()
  })

  it('acknowledges durable answered notices and requires a persisted answering turn', async () => {
    const rejected = await completedRun()
    const rejectedId = MessageId('dsh-autopilot:durable-answer-rejected')
    appendCompletionTurn(rejected.agent, rejectedId)
    vi.spyOn(rejected.ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(rejected.ctx.autonomy.registerCompletionDelivery(
      rejected.ref,
      rejected.agent,
      rejectedId,
    )).rejects.toThrow(/requires configured session persistence/)
    expect(rejected.ctx.autonomy.get(rejected.agent)?.completionReported).toBe(false)
    await rejected.ctx.fiber.dispose()

    const acknowledged = await completedRun()
    const acknowledgedId = MessageId('dsh-autopilot:durable-answer-accepted')
    appendCompletionTurn(acknowledged.agent, acknowledgedId)
    await expect(acknowledged.ctx.autonomy.registerCompletionDelivery(
      acknowledged.ref,
      acknowledged.agent,
      acknowledgedId,
    )).resolves.toBe('reported')
    expect(acknowledged.ctx.autonomy.get(acknowledged.agent)?.completionReported).toBe(true)
    await acknowledged.ctx.fiber.dispose()
  })

  it('tracks only the claimed notice turn and retries a failed asynchronous acknowledgement', async () => {
    const harness = await completedRun()
    const messageId = MessageId('dsh-autopilot:claimed-notice')
    const message = appendCompletionTurn(harness.agent, messageId, 4, false)
    await expect(harness.ctx.autonomy.registerCompletionDelivery(
      harness.ref,
      harness.agent,
      messageId,
    )).resolves.toBe('registered')

    agentEvents(harness.ctx, harness.agent).emit('agent/inbox/claimed', {
      message: { ...message, id: MessageId('unrelated-message') },
      turn: 9,
    })
    emitAssistantMessage(harness.ctx, harness.agent, '   ', 4)
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'turn/end', seq: 100, time: Date.now(),
      data: { turn: 4, reason: { kind: 'interrupted' } },
    })
    await vi.waitFor(() => {
      expect(harness.agent.followup).toHaveBeenCalledOnce()
      expect(latestSnapshot(harness.ctx, harness.agent)).toMatchObject({ completionDeliveryAttempts: 1 })
    })

    vi.spyOn(harness.ctx.sessions, 'flush').mockResolvedValueOnce(false).mockResolvedValue(true)
    const logged = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => harness.ctx.logger)
    emitCompletionTurn(harness.ctx, harness.agent, messageId, 5)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/failed to acknowledge completion feedback/))
    })
    expect(harness.ctx.autonomy.get(harness.agent)?.completionReported).toBe(false)
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'assistant/message', seq: 102, time: Date.now(),
      data: {
        turn: 5,
        step: 2,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'retry acknowledgement' }],
          source: { provider: 'test', model: 'test' },
        }),
      },
    })
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)?.completionReported).toBe(true)
    })
    await harness.ctx.fiber.dispose()
  })

  it('deduplicates an acknowledgement already in flight', async () => {
    const harness = await completedRun()
    const messageId = MessageId('dsh-autopilot:inflight-ack')
    await harness.ctx.autonomy.registerCompletionDelivery(harness.ref, harness.agent, messageId)
    let releaseFlush: ((value: boolean) => void) | undefined
    const flush = vi.spyOn(harness.ctx.sessions, 'flush').mockImplementation(
      () => new Promise<boolean>((resolve) => { releaseFlush = resolve }),
    )
    emitCompletionTurn(harness.ctx, harness.agent, messageId, 7)
    harness.ctx.emit('session/event', harness.agent.session, {
      type: 'assistant/message', seq: 103, time: Date.now(),
      data: {
        turn: 7,
        step: 2,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'duplicate event while flushing' }],
          source: { provider: 'test', model: 'test' },
        }),
      },
    })
    expect(flush).toHaveBeenCalledOnce()
    releaseFlush?.(true)
    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)?.completionReported).toBe(true)
    })
    await harness.ctx.fiber.dispose()
  })

  it('rejects stale or non-completed acknowledgement rows and corrupt completion evidence', async () => {
    const running = await createServiceHarness({ autonomy: { autoResume: true } })
    const runningGoal = running.ctx.goals.create(running.agent, { objective: 'reject early notice ack' })
    await running.ctx.autonomy.start(running.agent, { goalId: runningGoal.id })
    const runningRef = recoveryRef(latestSnapshot(running.ctx, running.agent))
    await expect(running.ctx.autonomy.markCompletionReported({
      ...runningRef, runId: 'stale-run',
    })).rejects.toThrow(/stale run/)
    await expect(running.ctx.autonomy.markCompletionReported(runningRef)).rejects.toThrow(/not pending/)
    await running.ctx.fiber.dispose()

    const corrupt = await completedRun()
    const store = probe(corrupt.ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    const snapshot = latestSnapshot(corrupt.ctx, corrupt.agent)
    vi.spyOn(store, 'get').mockReturnValueOnce({
      ...snapshot,
      verificationHistory: [],
    })
    await expect(corrupt.ctx.autonomy.completionNotice(corrupt.ref)).rejects.toThrow(/no passing verification/)
    await corrupt.ctx.fiber.dispose()

    const detached = await completedRun()
    vi.spyOn(detached.ctx.agents, 'get').mockReturnValueOnce(undefined)
    await expect(detached.ctx.autonomy.markCompletionReported(detached.ref)).resolves.toBeUndefined()
    expect(detached.ctx.autonomy.get(detached.agent)?.completionReported).toBe(true)
    await detached.ctx.fiber.dispose()
  })
})

describe('AutonomyService expiry and host lifecycle', () => {
  it('expires, pauses the Goal, preserves queued work, and segments long timers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 1000, maxActiveMs: 3_000_000_000 },
    })
    const goal = ctx.goals.create(agent, { objective: 'expire safely' })
    await ctx.autonomy.start(agent, { goalId: goal.id, maxActiveMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'exhausted', remainingActiveMs: 0 })
    })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(agent.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'dsh-autopilot lease expired' },
      { keepInbox: true },
    )

    ctx.goals.complete(agent, ctx.goals.get(agent)!)
    await ctx.autonomy.revoke(agent, 'replace exhausted lease')
    const next = ctx.goals.create(agent, { objective: 'long lease' })
    await ctx.autonomy.start(agent, { goalId: next.id, maxActiveMs: 3_000_000_000 })
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(ctx.autonomy.get(agent)?.phase).toBe('running')
    await ctx.fiber.dispose()
  })

  it('contains Goal pause failures during expiry and leaves an already-paused Goal unchanged', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const failing = await createServiceHarness({ autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 } })
    const failingGoal = failing.ctx.goals.create(failing.agent, { objective: 'expiry fallback' })
    await failing.ctx.autonomy.start(failing.agent, { goalId: failingGoal.id })
    vi.spyOn(failing.ctx.goals, 'pause').mockImplementation(() => {
      throw new Error('pause storage failed')
    })
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => { expect(failing.ctx.autonomy.get(failing.agent)?.phase).toBe('exhausted') })
    expect(failing.ctx.goals.get(failing.agent)).toMatchObject({ activation: 'disarmed' })
    expect(failing.agent.cancel).toHaveBeenCalled()
    await failing.ctx.fiber.dispose()

    vi.setSystemTime(2000)
    const paused = await createServiceHarness({ autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 } })
    const pausedGoal = paused.ctx.goals.create(paused.agent, { objective: 'already paused' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: pausedGoal.id })
    paused.ctx.goals.pause(paused.agent, pausedGoal)
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => { expect(paused.ctx.autonomy.get(paused.agent)?.phase).toBe('exhausted') })
    expect(paused.ctx.goals.get(paused.agent)).toMatchObject({ phase: 'paused' })
    await paused.ctx.fiber.dispose()
  })

  it('persists exhaustion and interrupted attempts before pausing the Goal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const harness = await startPlannedRun({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
      duration: 10,
    })
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const originalPause = harness.ctx.goals.pause.bind(harness.ctx.goals)
    const pause = vi.spyOn(harness.ctx.goals, 'pause').mockImplementation((agent, goal) => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({ phase: 'exhausted' })
      expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({
        status: 'pending',
        attemptHistory: [expect.objectContaining({ outcome: 'interrupted', reason: 'active duration exhausted' })],
      })
      return originalPause(agent, goal)
    })

    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => { expect(pause).toHaveBeenCalledOnce() })
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    await harness.ctx.fiber.dispose()
  })

  it('disarms on lifecycle restart, persists a pause, and requires explicit human resume', async () => {
    const { ctx, agent } = await createServiceHarness()
    const outsider = createTestAgent('lifecycle-outsider')
    agentEvents(ctx, outsider).emit('agent/session-start', { source: 'startup' })
    agentEvents(ctx, outsider).emit('agent/disposed', {})

    const goal = ctx.goals.create(agent, { objective: 'lifecycle coverage' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const signal = ctx.autonomy.signal(agent)
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'paused',
        activation: 'disarmed',
        reason: 'session lifecycle restarted; explicit human resume is required',
      })
    })
    expect(signal.aborted).toBe(true)
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    await expect(ctx.autonomy.resume(agent, goal.id)).resolves.toMatchObject({ activation: 'armed' })
    agentEvents(ctx, agent).emit('agent/disposed', {})
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('does not rearm a normal resume after an observer disarms its Goal', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'contain resume observer reentry' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await ctx.autonomy.pause(agent, 'prepare observer race')
    ctx.on('autonomy/changed', ({ operation }) => {
      if (operation !== 'resume') return
      const current = ctx.goals.get(agent)
      if (current?.activation === 'armed') ctx.goals.disarm(agent)
    })

    await expect(ctx.autonomy.resume(agent, goal.id)).rejects.toMatchObject({
      code: 'AUTONOMY_INVALID_TRANSITION',
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: 'the run or Goal changed during resume observers before runtime rearm',
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual([
      'start', 'pause', 'resume', 'needs-attention',
    ])
    await ctx.fiber.dispose()
  })

  it('preserves an observer pause that wins a normal resume publication race', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'preserve a newer sidecar revision' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await ctx.autonomy.pause(agent, 'prepare sidecar race')
    ctx.on('autonomy/changed', async ({ operation }) => {
      if (operation === 'resume') await ctx.autonomy.pause(agent, 'observer pause won')
    })

    await expect(ctx.autonomy.resume(agent, goal.id)).rejects.toThrow(/changed during resume observers/)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', reason: 'observer pause won' })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual([
      'start', 'pause', 'resume', 'pause',
    ])
    await ctx.fiber.dispose()
  })

  it('continues an explicitly authorized run across compaction without granting a fork', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'continue after compaction' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const before = ctx.autonomy.get(agent)!
    const firstSignal = ctx.autonomy.signal(agent)

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })

    expect(ctx.autonomy.get(agent)).toMatchObject({
      id: before.id,
      revision: before.revision,
      phase: 'running',
      activation: 'armed',
      autoResume: true,
    })
    expect(ctx.goals.get(agent)).toMatchObject({ id: goal.id, phase: 'active', activation: 'armed' })
    expect(ctx.autonomy.signal(agent)).toBe(firstSignal)
    expect(ctx.autonomy.history(agent).map(item => item.operation)).toEqual(['start'])

    const fork = createTestAgent('compaction-fork')
    ctx.agents.register(fork)
    agentEvents(ctx, fork).emit('agent/session-start', { source: 'startup' })
    expect(ctx.autonomy.get(fork)).toBeUndefined()
    expect(ctx.autonomy.currentRuns()).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('preserves a verifying run when another lifecycle owner already rearmed its Goal', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, {
      summary: 'candidate survives compaction',
      evidence: ['focused tests'],
    })
    const goalBefore = harness.ctx.goals.get(harness.agent)
    if (goalBefore === undefined) throw new Error('fixture Goal is missing')
    const getGoal = vi.spyOn(harness.ctx.goals, 'get').mockReturnValue({
      ...goalBefore,
      activation: 'armed',
    })
    const resumeGoal = vi.spyOn(harness.ctx.goals, 'resume')

    agentEvents(harness.ctx, harness.agent).emit('agent/session-start', { source: 'compact' })
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      phase: 'verifying', activation: 'armed',
    })
    expect(resumeGoal).not.toHaveBeenCalled()
    getGoal.mockRestore()
    resumeGoal.mockRestore()
    const disarmedGoal = harness.ctx.goals.get(harness.agent)
    if (disarmedGoal === undefined) throw new Error('fixture Goal disappeared')
    harness.ctx.goals.resume(harness.agent, disarmedGoal)
    await harness.ctx.fiber.dispose()
  })

  it('fails compaction continuation closed when Goal rearm or reconciliation fails', async () => {
    const rearm = await createServiceHarness({ autonomy: { autoResume: true } })
    const rearmGoal = rearm.ctx.goals.create(rearm.agent, { objective: 'failed compact rearm' })
    await rearm.ctx.autonomy.start(rearm.agent, { goalId: rearmGoal.id })
    vi.spyOn(rearm.ctx.goals, 'resume').mockImplementation(() => { throw new Error('Goal CAS failed') })

    agentEvents(rearm.ctx, rearm.agent).emit('agent/session-start', { source: 'compact' })
    await vi.waitFor(() => {
      expect(rearm.ctx.autonomy.get(rearm.agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: /Goal CAS failed/,
      })
    })
    await rearm.ctx.fiber.dispose()

    const mismatch = await createServiceHarness({ autonomy: { autoResume: true } })
    const mismatchGoal = mismatch.ctx.goals.create(mismatch.agent, { objective: 'missing compact Goal' })
    await mismatch.ctx.autonomy.start(mismatch.agent, { goalId: mismatchGoal.id })
    const getGoal = vi.spyOn(mismatch.ctx.goals, 'get').mockReturnValue(undefined)
    agentEvents(mismatch.ctx, mismatch.agent).emit('agent/session-start', { source: 'compact' })
    await vi.waitFor(() => {
      expect(mismatch.ctx.autonomy.get(mismatch.agent)).toMatchObject({
        phase: 'needs-attention',
        reason: /no longer exposes/,
      })
    })
    getGoal.mockRestore()
    await mismatch.ctx.fiber.dispose()

    const failedMarker = await createServiceHarness({ autonomy: { autoResume: true } })
    const failedMarkerGoal = failedMarker.ctx.goals.create(failedMarker.agent, {
      objective: 'failed compact marker',
    })
    await failedMarker.ctx.autonomy.start(failedMarker.agent, { goalId: failedMarkerGoal.id })
    vi.spyOn(failedMarker.ctx.goals, 'resume').mockImplementation(() => { throw new Error('Goal CAS failed') })
    vi.spyOn(failedMarker.ctx.autonomy, 'markNeedsAttention').mockRejectedValueOnce(
      new Error('attention store unavailable'),
    )
    const logged = vi.spyOn(failedMarker.ctx.logger, 'error').mockImplementation(() => failedMarker.ctx.logger)
    agentEvents(failedMarker.ctx, failedMarker.agent).emit('agent/session-start', { source: 'compact' })
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/compaction needs-attention.*store unavailable/))
    })
    expect(failedMarker.ctx.autonomy.get(failedMarker.agent)).toMatchObject({
      phase: 'running', activation: 'disarmed',
    })
    await failedMarker.ctx.fiber.dispose()
  })

  it('does not continue an auto-resume lease across a clear lifecycle edge', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'do not inherit a clear' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    await recordTestInterview(ctx, agent)
    await ctx.autonomy.setPlan(agent, ['stop safely'], [task('active-work')])

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'clear' })
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('fails an armed run closed after an Agent loop error without automatic retry', async () => {
    const empty = await createServiceHarness()
    const outsider = createTestAgent('agent-error-outsider')
    agentEvents(empty.ctx, outsider).emit('agent/error', {
      turn: 1, step: 1, error: new Error('unowned'),
    })
    await empty.ctx.fiber.dispose()
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const signal = harness.ctx.autonomy.signal(harness.agent)
    agentEvents(harness.ctx, harness.agent).emit('agent/error', {
      turn: 1,
      step: 2,
      error: new AggregateError([new Error('provider disconnected')], 'turn failed'),
    })

    await vi.waitFor(() => {
      expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: /turn failed.*provider disconnected/,
      })
    })
    expect(signal.aborted).toBe(true)
    expect(harness.ctx.goals.get(harness.agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({
      status: 'pending',
      attemptHistory: [expect.objectContaining({
        outcome: 'interrupted', reason: expect.stringMatching(/provider disconnected/),
      })],
    })
    const historyLength = harness.ctx.autonomy.history(harness.agent).length
    agentEvents(harness.ctx, harness.agent).emit('agent/error', {
      turn: 1,
      step: 3,
      error: new Error('late duplicate'),
    })
    await Promise.resolve()
    expect(harness.ctx.autonomy.history(harness.agent)).toHaveLength(historyLength)
    await harness.ctx.fiber.dispose()
  })

  it('keeps Agent errors fail-closed when attention persistence also fails', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'contain loop and storage failure' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    const store = probe(ctx.autonomy).store
    if (runtime === undefined || store === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'driver already stopped')
    vi.spyOn(store, 'reduceCurrent').mockRejectedValueOnce(new Error('attention store unavailable'))
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)

    agentEvents(ctx, agent).emit('agent/error', {
      turn: 1,
      step: 2,
      error: new Error('provider failed'),
    })
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(/agent-error needs-attention.*attention store unavailable/),
      )
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('persists exhaustion when restart observes elapsed active time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100, autoResume: true },
    })
    const goal = ctx.goals.create(agent, { objective: 'elapsed before notification' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expiresAt = ctx.autonomy.get(agent)?.expiresAt
    if (expiresAt === undefined) throw new Error('fixture lease has no expiry')
    vi.setSystemTime(expiresAt)
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'exhausted', remainingActiveMs: 0 })
    })
    await ctx.fiber.dispose()
  })

  it('disarms the matching Goal when the service itself unloads', async () => {
    const { ctx, agent, autonomyFiber } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'unload active lease' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const alreadyPaused = createTestAgent('unload-paused-goal')
    ctx.agents.register(alreadyPaused)
    const pausedGoal = ctx.goals.create(alreadyPaused, { objective: 'already paused on unload' })
    await ctx.autonomy.start(alreadyPaused, { goalId: pausedGoal.id })
    ctx.goals.pause(alreadyPaused, pausedGoal)
    await autonomyFiber.dispose()
    expect(ctx.get('autonomy')).toBeUndefined()
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.goals.get(alreadyPaused)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })
})

describe('AutonomyService initialization and audit events', () => {
  it('fails reads before initialization and rejects recovery without persistence', async () => {
    const service = new AutonomyService(new Context())
    expect(() => service.get(createTestAgent('uninitialized'))).toThrow(/not initialized/)
    await expect(service.startRecovery()).rejects.toThrow(/requires sessionPersistence/)
  })

  it('awaits changed listeners and exposes detached audit history', async () => {
    const { ctx, agent } = await createServiceHarness()
    const operations: string[] = []
    ctx.on('autonomy/changed', async ({ operation, view }) => {
      await Promise.resolve()
      operations.push(`${operation}:${view.revision}`)
    })
    expect(ctx.autonomy.get(agent)).toBeUndefined()
    const goal = ctx.goals.create(agent, { objective: 'events' })
    const started = await ctx.autonomy.start(agent, { goalId: goal.id })
    expect(operations).toEqual(['start:1'])
    expect(ctx.autonomy.history(agent)).toHaveLength(1)
    expect(Object.isFrozen(ctx.autonomy.history(agent))).toBe(true)
    expect(started.verificationHistory).toEqual([])
    expect(started).not.toHaveProperty('plan')
    expect(started).not.toHaveProperty('reason')
    await ctx.fiber.dispose()
  })

  it('rearms an exact max-tokens continuation while the native Goal still has round budget', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'surface a truncated autonomous turn' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.emit('session/event', agent.session, {
      type: 'turn/end',
      seq: agent.session.events.length,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    ctx.goals.disarm(agent)
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'active', activation: 'armed', roundsStarted: 0,
    })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual(['start'])
    await ctx.fiber.dispose()
  })

  it('fails a max-tokens rearm race closed before reporting a persistence failure', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'contain a max-tokens Goal race' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const signal = ctx.autonomy.signal(agent)
    ctx.emit('session/event', agent.session, {
      type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    ctx.goals.disarm(agent)
    const getGoal = ctx.goals.get.bind(ctx.goals)
    vi.spyOn(ctx.goals, 'get')
      .mockImplementationOnce(() => getGoal(agent))
      .mockImplementationOnce(() => {
        const current = getGoal(agent)
        return current === undefined ? undefined : { ...current, revision: current.revision + 1 }
      })
      .mockImplementation(() => getGoal(agent))
    vi.spyOn(ctx.autonomy, 'markNeedsAttention').mockRejectedValueOnce(new Error('attention store unavailable'))
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)

    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringMatching(
      /max-tokens continuation needs-attention.*attention store unavailable/,
    )))
    expect(signal.aborted).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('fails a thrown max-tokens Goal resume closed and persists needs-attention', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'contain a failed max-tokens resume' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.emit('session/event', agent.session, {
      type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    ctx.goals.disarm(agent)
    vi.spyOn(ctx.goals, 'resume').mockImplementation(() => { throw new Error('Goal store unavailable') })

    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    await vi.waitFor(() => expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      reason: expect.stringContaining('Goal store unavailable'),
    }))
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('surfaces a max-tokens stop whose runtime diverged before native continuation', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'surface a divergent max-tokens runtime' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.emit('session/event', agent.session, {
      type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    const mutableRuntime = runtime as { runId: string }
    mutableRuntime.runId = 'divergent-runtime'

    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    await vi.waitFor(() => expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      reason: expect.stringContaining('native Goal driver disarmed before Autopilot completed'),
    }))
    await ctx.fiber.dispose()
  })

  it('fails max-tokens continuation closed when the native Goal round budget is exhausted', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, {
      objective: 'bound truncated autonomous turns',
      maxGoalRounds: 1,
    })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'final allowed Goal round' }],
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    expect(ctx.goals.get(agent)).toMatchObject({ roundsStarted: 1, maxGoalRounds: 1 })
    ctx.emit('session/event', agent.session, {
      type: 'turn/end', seq: agent.session.events.length, time: Date.now(),
      data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    ctx.goals.disarm(agent)
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: expect.stringMatching(/round budget exhausted/),
      })
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed', roundsStarted: 1 })
    await ctx.fiber.dispose()
  })

  it('marks a generic native Goal silent-disarm as needs-attention', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'surface native driver failure' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    ctx.emit('session/event', agent.session, {
      type: 'turn/end',
      seq: agent.session.events.length,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    ctx.goals.disarm(agent)
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    await vi.waitFor(() => {
      expect(ctx.autonomy.get(agent)).toMatchObject({
        phase: 'needs-attention',
        activation: 'disarmed',
        reason: expect.stringMatching(/silently disarmed/),
      })
    })
    await ctx.fiber.dispose()
  })

  it('keeps a valid armed Autopilot run transparent across normal idle', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'remain authorized while idle' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const signal = ctx.autonomy.signal(agent)
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    await Promise.resolve()

    expect(signal.aborted).toBe(false)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual(['start'])
    await ctx.fiber.dispose()
  })

  it('disarms runtime and exact Goal even when idle reconciliation cannot persist', async () => {
    const { ctx, agent } = await createServiceHarness()
    const goal = ctx.goals.create(agent, { objective: 'fail closed on reconciliation storage loss' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const internals = probe(ctx.autonomy)
    const runtime = internals.runtimes.get(agent)
    const store = internals.store
    if (runtime === undefined || store === undefined) throw new Error('fixture internals are missing')
    const signal = runtime.activity.signal
    const mutableRuntime = runtime as { runId: string }
    mutableRuntime.runId = 'mismatched-runtime'
    vi.spyOn(store, 'reduceCurrent').mockRejectedValueOnce(new Error('attention storage unavailable'))
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })

    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(
        /failed to persist idle-agent needs-attention.*attention storage unavailable/,
      ))
    })
    expect(signal.aborted).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('waits for explicit recovery start even after session persistence appears', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'optional recovery seam' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const inspect = vi.fn(async () => ({
      meta: agent.session.header,
      events: agent.session.events,
    }))

    expect(inspect).not.toHaveBeenCalled()
    ctx.provide('sessionPersistence', {
      inspect,
      list: vi.fn(async () => [agent.session.header]),
    } as never)
    await Promise.resolve()
    expect(inspect).not.toHaveBeenCalled()
    const idle = ctx.autonomy.whenRecoveryIdle()
    let idleSettled = false
    void idle.then(() => { idleSettled = true })
    await Promise.resolve()
    expect(idleSettled).toBe(false)
    const first = ctx.autonomy.startRecovery()
    const second = ctx.autonomy.startRecovery()
    expect(second).toBe(first)
    const activeIdle = ctx.autonomy.whenRecoveryIdle()
    await expect(first).resolves.toHaveLength(1)
    await expect(activeIdle).resolves.toBeUndefined()
    await expect(idle).resolves.toBeUndefined()
    expect(inspect).toHaveBeenCalledWith(agent.id)
    expect(ctx.autonomy.get(agent)?.reason).toBeUndefined()
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
    await ctx.fiber.dispose()
  })

  it('reconciles an explicitly auto-resumable run on every same-host Session reopen', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'survive same-host Agent replacement' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const inspect = vi.fn(async () => ({ meta: agent.session.header, events: agent.session.events }))
    ctx.provide('sessionPersistence', {
      inspect,
      list: vi.fn(async () => [agent.session.header]),
    } as never)
    await ctx.autonomy.startRecovery()
    expect(inspect).toHaveBeenCalledOnce()

    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate Agent disposal')
    ctx.goals.disarm(agent)
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })

    await vi.waitFor(() => {
      expect(inspect).toHaveBeenCalledTimes(2)
      expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    })
    await ctx.fiber.dispose()
  })

  it('contains a top-level optional recovery scan failure', async () => {
    const { ctx } = await createServiceHarness()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    vi.spyOn(ctx.autonomy, 'currentRuns').mockImplementation(() => {
      throw new Error('sidecar scan failed')
    })

    ctx.provide('sessionPersistence', { inspect: vi.fn(), list: vi.fn(async () => []) } as never)
    await expect(ctx.autonomy.startRecovery()).resolves.toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/cold recovery scan failed.*sidecar scan failed/))
    await ctx.fiber.dispose()
  })

  it('contains same-host maintenance failure and logs only actionable recovery reports', async () => {
    const { ctx, agent } = await createServiceHarness()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    const inspect = vi.fn(async () => ({ meta: agent.session.header, events: agent.session.events }))
    ctx.provide('sessionPersistence', {
      inspect,
      list: vi.fn(async () => []),
    } as never)
    await ctx.autonomy.startRecovery()
    expect(inspect).not.toHaveBeenCalled()

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledOnce() })

    vi.spyOn(agent, 'runMaintenance').mockRejectedValueOnce(new Error('maintenance unavailable'))
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/same-host recovery failed.*maintenance unavailable/))
    })

    const service = probe(ctx.autonomy)
    service.logRecoveryReport({
      sessionId: String(agent.id),
      commandId: 'orphan-start',
      outcome: 'needs-attention',
      reason: 'materialized policy is missing',
    })
    service.logRecoveryReport({
      run: { runId: 'failed-run', generation: 1, revision: 1, sessionId: String(agent.id) },
      outcome: 'failed',
      reason: 'storage unavailable',
    })
    service.logRecoveryReport({
      run: { runId: 'safe', generation: 1, revision: 1, sessionId: String(agent.id) },
      outcome: 'skipped',
      reason: 'human pause',
    })
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('materialized policy is missing'))
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/recovery failed.*storage unavailable/))
    await ctx.fiber.dispose()
  })
})

interface RuntimeProbe {
  readonly runId: string
  readonly goalId: GoalId
  readonly activity: AbortController
  timer?: NodeJS.Timeout | undefined
}

interface PendingCompletionProbe {
  run: RecoveryRunRef
  readonly agent: Agent
  readonly session: Agent['session']
  readonly messageId: MessageId
  claimedTurn?: number | undefined
  admitted?: boolean | undefined
  assistantText?: boolean | undefined
  deliveryComplete?: boolean | undefined
  acknowledging?: Promise<void> | undefined
  retrying?: Promise<void> | undefined
  redeliveryPending?: boolean | undefined
  exhaustionNoticePending?: boolean | undefined
}

interface AutonomyServiceProbe {
  store?: Pick<DurableRunStore, 'append' | 'appendIfCurrent' | 'reduceCurrent' | 'get' | 'currentRuns'> | undefined
  recovery?: unknown
  readonly runtimes: Map<Agent, RuntimeProbe>
  readonly pendingCompletionReports: Map<string, PendingCompletionProbe>
  armRuntime(agent: Agent, snapshot: RunSnapshot): void
  disarmRuntime(agent: Agent, runtime: RuntimeProbe, reason: string): void
  disarmAfterRearmRace(
    agent: Agent,
    attempted: RunSnapshot,
    authoritative: RunSnapshot | undefined,
    reason: string,
  ): void
  enqueueCompletionDelivery(pending: PendingCompletionProbe): void
  retryCompletionDelivery(pending: PendingCompletionProbe, reason: string): void
  resumePendingCompletion(agent: Agent): void
  persistCompletionDeliveryFailure(pending: PendingCompletionProbe, reason: string): Promise<void>
  ensureCompletionExhaustionNotice(expected: RecoveryRunRef, agent: Agent): Promise<RunSnapshot>
  view(agent: Agent, snapshot: RunSnapshot): {
    readonly completionDeliveryAttempts?: number | undefined
    readonly completionDeliveryExhausted?: boolean | undefined
    readonly completionDeliveryExhaustionNotified?: boolean | undefined
  }
  scheduleExpiry(agent: Agent, snapshot: RunSnapshot, runtime: RuntimeProbe): void
  expire(agent: Agent, snapshot: RunSnapshot, runtime: RuntimeProbe): Promise<void>
  pausePersistedRun(agent: Agent, reason: string): Promise<void>
  logRecoveryReport(report: RecoveryReport): void
}

function probe(service: AutonomyService): AutonomyServiceProbe {
  return service as unknown as AutonomyServiceProbe
}

function latestSnapshot(ctx: { readonly autonomy: AutonomyService }, agent: Agent): RunSnapshot {
  const latest = ctx.autonomy.history(agent).at(-1)
  if (latest === undefined) throw new Error('fixture has no audit snapshot')
  return latest.snapshot
}

function recoveryRef(snapshot: RunSnapshot): RecoveryRunRef {
  return {
    runId: snapshot.runId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    sessionId: snapshot.sessionId,
  }
}

function lifecycleIntent(
  command: RecoveryLifecycleIntent['command'],
): RecoveryLifecycleIntent {
  return { commandId: `command-${command.kind}`, seq: 1, command }
}

describe('AutonomyService cold-recovery controller', () => {
  it('fails every latest active generation closed when recovery readiness is lost', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await expect(harness.ctx.autonomy.failRecoveryReadiness('   ')).rejects.toThrow(/must not be empty/)
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])

    const verifying = createTestAgent('readiness-verifying-session')
    harness.ctx.agents.register(verifying)
    const verifyingGoal = harness.ctx.goals.create(verifying, { objective: 'fail a verifying row closed' })
    await harness.ctx.autonomy.start(verifying, { goalId: verifyingGoal.id })
    await recordTestInterview(harness.ctx, verifying)
    await harness.ctx.autonomy.setPlan(verifying, ['verified'], [task('verify')])
    await approveTestPlan(harness.ctx, verifying)
    await harness.ctx.autonomy.updateTask(verifying, 'verify', 'start')
    await harness.ctx.autonomy.updateTask(verifying, 'verify', 'complete', { evidence: [taskEvidence] })
    await harness.ctx.autonomy.beginVerification(verifying, { summary: 'candidate', evidence: ['tests'] })

    const detached = createTestAgent('readiness-detached-session')
    const unregister = harness.ctx.agents.register(detached)
    const detachedGoal = harness.ctx.goals.create(detached, { objective: 'fail a detached row closed' })
    await harness.ctx.autonomy.start(detached, { goalId: detachedGoal.id })
    unregister()
    expect(harness.ctx.autonomy.currentSnapshots()).toHaveLength(3)

    await harness.ctx.autonomy.failRecoveryReadiness(' critical recovery contribution unloaded ')

    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: 'critical recovery contribution unloaded',
      plan: { tasks: expect.arrayContaining([expect.objectContaining({ id: 'build', status: 'pending' })]) },
    })
    expect(harness.ctx.autonomy.get(verifying)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(latestSnapshot(harness.ctx, detached)).toMatchObject({ phase: 'needs-attention' })
    expect(harness.agent.cancel).toHaveBeenCalledTimes(2)
    expect(verifying.cancel).toHaveBeenCalledTimes(2)
    expect(detached.cancel).not.toHaveBeenCalled()
    await harness.ctx.fiber.dispose()
  })

  it('keeps a concurrently changed readiness row durable while disarming its live owners', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'preserve a newer readiness winner' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const signal = ctx.autonomy.signal(agent)
    const store = probe(ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    vi.spyOn(store, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reducer) => {
      expect(reducer(undefined)).toBeUndefined()
      return undefined
    })

    await ctx.autonomy.failRecoveryReadiness('bundle changed concurrently')

    expect(signal.aborted).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('aggregates readiness persistence failures after disarming live owners', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'surface readiness persistence loss' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const signal = ctx.autonomy.signal(agent)
    const store = probe(ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    vi.spyOn(store, 'reduceCurrent').mockRejectedValueOnce(new Error('readiness store unavailable'))

    await expect(ctx.autonomy.failRecoveryReadiness('critical bundle unavailable')).rejects.toThrow(AggregateError)
    expect(signal.aborted).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('lists immutable rows and rearms only the exact disarmed run and Goal', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'recover exact state' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const first = latestSnapshot(ctx, agent)
    const expected = recoveryRef(first)

    expect(ctx.autonomy.currentRuns()).toEqual([expect.objectContaining({
      ...expected,
      goalId: goal.id,
      phase: 'running',
      autoResume: true,
    })])
    expect(Object.isFrozen(ctx.autonomy.currentRuns())).toBe(true)
    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toEqual({ kind: 'recovered' })
    expect(ctx.autonomy.history(agent)).toHaveLength(1)

    ctx.goals.disarm(agent)
    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toEqual({ kind: 'recovered' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'armed' })
    expect(ctx.autonomy.history(agent)).toHaveLength(1)

    ctx.goals.disarm(agent)
    const internals = probe(ctx.autonomy)
    const runtime = internals.runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    internals.disarmRuntime(agent, runtime, 'simulate process loss')
    const disarmedGoal = ctx.goals.get(agent)
    if (disarmedGoal === undefined) throw new Error('fixture Goal is missing')

    await expect(ctx.autonomy.activateRecovered(expected, agent, disarmedGoal)).resolves.toEqual({
      kind: 'recovered',
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ revision: 2, phase: 'running', activation: 'armed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    expect(ctx.autonomy.history(agent).map(item => item.operation)).toEqual(['start', 'resume'])

    await expect(ctx.autonomy.activateRecovered(expected, agent, disarmedGoal)).resolves.toMatchObject({
      kind: 'superseded',
    })
    await expect(ctx.autonomy.activateRecovered(
      recoveryRef(latestSnapshot(ctx, agent)),
      createTestAgent('wrong-recovery-agent'),
      disarmedGoal,
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await ctx.fiber.dispose()
  })

  it('projects legacy delivery defaults and disarms only an authoritative rearm race', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'exercise exact rearm ownership' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const snapshot = latestSnapshot(ctx, agent)
    const internals = probe(ctx.autonomy)
    const runtime = internals.runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    const legacy = { ...snapshot }
    delete legacy.completionDeliveryAttempts
    delete legacy.completionDeliveryExhausted
    delete legacy.completionDeliveryExhaustionNotified

    expect(internals.view(agent, legacy)).toMatchObject({
      completionDeliveryAttempts: 0,
      completionDeliveryExhausted: false,
      completionDeliveryExhaustionNotified: false,
    })
    internals.disarmAfterRearmRace(agent, snapshot, undefined, 'stale observer')
    expect(runtime.activity.signal.aborted).toBe(false)
    internals.disarmAfterRearmRace(agent, snapshot, snapshot, 'authoritative observer')
    expect(runtime.activity.signal.aborted).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('does not reverse a Goal disarm performed by a cold-resume observer', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'contain cold observer reentry' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate process loss')
    ctx.on('autonomy/changed', async ({ operation, view }) => {
      if (operation !== 'resume') return
      await ctx.autonomy.markNeedsAttention({
        runId: view.id,
        generation: view.generation,
        revision: view.revision,
        sessionId: String(agent.id),
      }, 'cold observer rejected the rearm')
    })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: 'cold observer rejected the rearm',
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual([
      'start', 'resume', 'needs-attention',
    ])
    await ctx.fiber.dispose()
  })

  it('fails closed when bundle readiness changes after the recovery sidecar commits', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'guard the sidecar-to-Goal recovery window' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate process loss')
    ctx.goals.disarm(agent)
    let ready = true
    const readiness = {
      assertCurrent() {
        if (!ready) throw new Error('critical contribution changed')
      },
    }
    ctx.on('autonomy/changed', ({ operation }) => {
      if (operation === 'resume') ready = false
    })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal, readiness)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: expect.stringContaining('after sidecar recovery activation'),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual([
      'start', 'resume', 'needs-attention',
    ])
    await ctx.fiber.dispose()
  })

  it('fails closed when a recovery observer changes only the live Goal', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'guard the recovered sidecar-to-Goal window' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate process loss')
    ctx.goals.disarm(agent)
    ctx.on('autonomy/changed', ({ operation }) => {
      if (operation !== 'resume') return
      const current = ctx.goals.get(agent)
      if (current !== undefined) ctx.goals.clear(agent, current)
    })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: expect.stringContaining('live Goal changed during recovery observers'),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('recovers a missing runtime without rearming an already-armed Goal', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'reuse an already-armed recovered Goal' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate process loss')

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toEqual({ kind: 'recovered' })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'armed' })
    await ctx.fiber.dispose()
  })

  it('rejects recovery before activation when its admitted bundle is already stale', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'reject stale recovery admission' })
    await ctx.autonomy.start(agent, { goalId: goal.id })

    await expect(ctx.autonomy.activateRecovered(
      recoveryRef(latestSnapshot(ctx, agent)),
      agent,
      goal,
      { assertCurrent() { throw new Error('admission is stale') } },
    )).resolves.toMatchObject({
      kind: 'needs-attention', reason: expect.stringContaining('before recovery activation'),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('rechecks readiness while confirming an already-armed recovered Goal', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'confirm readiness around an armed Goal' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    let checks = 0

    await expect(ctx.autonomy.activateRecovered(
      recoveryRef(latestSnapshot(ctx, agent)),
      agent,
      goal,
      { assertCurrent() { if (++checks === 2) throw new Error('confirmation epoch changed') } },
    )).resolves.toMatchObject({
      kind: 'needs-attention', reason: expect.stringContaining('while confirming the recovered Goal'),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('rechecks readiness after the recovered Goal is synchronously rearmed', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'guard the final Goal rearm' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate process loss')
    ctx.goals.disarm(agent)
    let checks = 0

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal, {
      assertCurrent() {
        if (++checks === 3) throw new Error('Goal rearm epoch changed')
      },
    })).resolves.toMatchObject({
      kind: 'needs-attention', reason: expect.stringContaining('after recovered Goal rearm'),
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('disarms the Goal when a cold-resume observer advances the sidecar to pause', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'honor a newer cold observer pause' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate process loss')
    ctx.on('autonomy/changed', async ({ operation }) => {
      if (operation === 'resume') await ctx.autonomy.pause(agent, 'observer pause won')
    })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'superseded',
      reason: /changed during recovery observers/,
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'paused', activation: 'disarmed', reason: 'observer pause won',
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(ctx.autonomy.history(agent).map(record => record.operation)).toEqual([
      'start', 'resume', 'pause',
    ])
    await ctx.fiber.dispose()
  })

  it('does not automatically recover disabled or deliberately paused rows', async () => {
    const disabled = await createServiceHarness()
    const disabledGoal = disabled.ctx.goals.create(disabled.agent, { objective: 'manual recovery only' })
    await disabled.ctx.autonomy.start(disabled.agent, { goalId: disabledGoal.id })
    await expect(disabled.ctx.autonomy.activateRecovered(
      recoveryRef(latestSnapshot(disabled.ctx, disabled.agent)),
      disabled.agent,
      disabledGoal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    await disabled.ctx.fiber.dispose()

    const paused = await createServiceHarness({ autonomy: { autoResume: true } })
    const pausedGoal = paused.ctx.goals.create(paused.agent, { objective: 'respect pause' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: pausedGoal.id })
    await paused.ctx.autonomy.pause(paused.agent)
    await expect(paused.ctx.autonomy.activateRecovered(
      recoveryRef(latestSnapshot(paused.ctx, paused.agent)),
      paused.agent,
      pausedGoal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    await paused.ctx.fiber.dispose()
  })

  it('converges only the exact finalizing row through the recovery controller', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    expect(harness.ctx.autonomy.currentRuns()).toEqual([
      expect.objectContaining({ phase: 'finalizing', finalization: expect.objectContaining({ verdict: 'pass' }) }),
    ])
    const goal = harness.ctx.goals.get(harness.agent)
    if (goal === undefined) throw new Error('fixture Goal is missing')

    await expect(harness.ctx.autonomy.finalizeRecovered(
      expected,
      createTestAgent('wrong-finalization-agent'),
      goal,
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await expect(harness.ctx.autonomy.finalizeRecovered(
      { ...expected, revision: expected.revision - 1 },
      harness.agent,
      goal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    await expect(harness.ctx.autonomy.finalizeRecovered(
      expected,
      harness.agent,
      goal,
    )).resolves.toMatchObject({
      kind: 'finalized',
      run: { revision: expected.revision + 1 },
      notice: { summary: 'pass verification' },
    })
    await harness.ctx.fiber.dispose()

    const running = await createServiceHarness({ autonomy: { autoResume: true } })
    const runningGoal = running.ctx.goals.create(running.agent, { objective: 'not finalizing' })
    await running.ctx.autonomy.start(running.agent, { goalId: runningGoal.id })
    await expect(running.ctx.autonomy.finalizeRecovered(
      recoveryRef(latestSnapshot(running.ctx, running.agent)),
      running.agent,
      runningGoal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    await running.ctx.fiber.dispose()
  })

  it('reports finalization disagreement as needs-attention and propagates an unchanged failure', async () => {
    const drift = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(drift)
    await drift.ctx.autonomy.beginVerification(drift.agent, { summary: 'candidate', evidence: ['tests'] })
    await drift.ctx.autonomy.beginFinalization(drift.agent, verification('pass'))
    const driftExpected = recoveryRef(latestSnapshot(drift.ctx, drift.agent))
    const driftGoal = drift.ctx.goals.get(drift.agent)
    if (driftGoal === undefined) throw new Error('fixture Goal is missing')
    await expect(drift.ctx.autonomy.finalizeRecovered(
      driftExpected,
      drift.agent,
      { id: driftGoal.id, revision: driftGoal.revision + 1 },
    )).resolves.toMatchObject({ kind: 'needs-attention', reason: /Goal changed/ })
    await drift.ctx.fiber.dispose()

    const failed = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(failed)
    await failed.ctx.autonomy.beginVerification(failed.agent, { summary: 'candidate', evidence: ['tests'] })
    await failed.ctx.autonomy.beginFinalization(failed.agent, verification('pass'))
    const failedExpected = recoveryRef(latestSnapshot(failed.ctx, failed.agent))
    const failedGoal = failed.ctx.goals.get(failed.agent)
    if (failedGoal === undefined) throw new Error('fixture Goal is missing')
    vi.spyOn(failed.ctx.goals, 'complete').mockImplementation(() => { throw new Error('Goal store unavailable') })
    await expect(failed.ctx.autonomy.finalizeRecovered(
      failedExpected,
      failed.agent,
      failedGoal,
    )).rejects.toThrow(/Goal store unavailable/)
    expect(failed.ctx.autonomy.get(failed.agent)).toMatchObject({ phase: 'finalizing' })
    await failed.ctx.fiber.dispose()
  })

  it('returns superseded when finalization loses the sidecar compare-and-set', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(harness)
    await harness.ctx.autonomy.beginVerification(harness.agent, { summary: 'candidate', evidence: ['tests'] })
    await harness.ctx.autonomy.beginFinalization(harness.agent, verification('pass'))
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    const goal = harness.ctx.goals.get(harness.agent)
    const store = probe(harness.ctx.autonomy).store
    if (goal === undefined || store === undefined) throw new Error('fixture finalization state is missing')
    const originalAppend = store.append.bind(store)
    vi.spyOn(store, 'appendIfCurrent').mockImplementationOnce(async () => {
      const current = store.get(String(harness.agent.id))
      if (current?.finalization === undefined) throw new Error('fixture row is missing')
      const { finalization, ...withoutFinalization } = current
      await originalAppend('finalization-complete', Object.freeze({
        ...withoutFinalization,
        revision: current.revision + 1,
        updatedAt: current.updatedAt + 1,
        phase: 'completed',
        flow: {
          ...current.flow,
          revision: current.flow.revision + 1,
          stage: 'completed' as const,
          updatedAt: current.updatedAt + 1,
        },
        verificationHistory: [...current.verificationHistory, finalization],
        completionReported: false,
      }))
      return undefined
    })

    await expect(harness.ctx.autonomy.finalizeRecovered(expected, harness.agent, goal)).resolves.toMatchObject({
      kind: 'superseded',
    })
    await harness.ctx.fiber.dispose()
  })

  it('fails closed on Goal disagreement and validates attention compare-and-set input', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'detect disagreement' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const signal = ctx.autonomy.signal(agent)
    const operations: string[] = []
    ctx.on('autonomy/changed', ({ operation }) => void operations.push(operation))

    await expect(ctx.autonomy.activateRecovered(expected, agent, {
      id: 'different-goal' as GoalId,
      revision: goal.revision,
    })).resolves.toMatchObject({ kind: 'needs-attention', reason: /does not match/ })
    expect(ctx.autonomy.get(agent)).toMatchObject({
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: /does not match/,
    })
    expect(ctx.goals.get(agent)).toMatchObject({ activation: 'disarmed' })
    expect(signal.aborted).toBe(true)
    expect(operations).toContain('needs-attention')
    await expect(ctx.autonomy.markNeedsAttention(expected, 'duplicate')).resolves.toBeUndefined()
    expect(ctx.autonomy.get(agent)).toMatchObject({ reason: /does not match/ })
    await expect(ctx.autonomy.markNeedsAttention(
      { ...expected, runId: 'different-run' },
      'genuinely stale',
    )).rejects.toThrow(/stale/)
    await expect(ctx.autonomy.markNeedsAttention(
      recoveryRef(latestSnapshot(ctx, agent)),
      '   ',
    )).rejects.toThrow(/must not be empty/)
    await ctx.fiber.dispose()
  })

  it('converges concurrent needs-attention markers with the first reason and one revision', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    const beforeHistory = harness.ctx.autonomy.history(harness.agent).length
    const operations: string[] = []
    harness.ctx.on('autonomy/changed', ({ operation }) => void operations.push(operation))

    await expect(Promise.all([
      harness.ctx.autonomy.markNeedsAttention(expected, 'Goal reconciliation failed'),
      harness.ctx.autonomy.markNeedsAttention(expected, 'command fail-closed marker'),
    ])).resolves.toEqual([undefined, undefined])
    const attention = harness.ctx.autonomy.get(harness.agent)
    expect(attention).toMatchObject({
      revision: expected.revision + 1,
      phase: 'needs-attention',
      activation: 'disarmed',
      reason: 'Goal reconciliation failed',
    })
    expect(attention?.plan?.tasks[0]).toMatchObject({
      id: 'build',
      status: 'pending',
      attemptHistory: [expect.objectContaining({
        outcome: 'interrupted', reason: 'Goal reconciliation failed',
      })],
    })
    expect(harness.ctx.autonomy.history(harness.agent)).toHaveLength(beforeHistory + 1)
    expect(operations.filter(operation => operation === 'needs-attention')).toHaveLength(1)

    const current = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    await expect(harness.ctx.autonomy.markNeedsAttention(
      current,
      'later duplicate reason',
    )).resolves.toBeUndefined()
    expect(harness.ctx.autonomy.get(harness.agent)).toMatchObject({
      revision: current.revision,
      reason: 'Goal reconciliation failed',
    })
    await harness.ctx.fiber.dispose()
  })

  it.each([
    ['missing', undefined],
    ['different id', { id: 'different-goal' as GoalId }],
    ['different revision', { revision: 99 }],
    ['non-active phase', { phase: 'paused' as const, activation: 'disarmed' as const }],
  ] as const)('rejects an armed run whose live Goal is %s', async (_label, override) => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'validate armed recovery Goal' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const liveGoal = ctx.goals.get(agent)
    if (liveGoal === undefined) throw new Error('fixture Goal is missing')
    vi.spyOn(ctx.goals, 'get').mockReturnValue(override === undefined ? undefined : {
      ...liveGoal,
      ...override,
    })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: /live Goal changed/,
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('fails closed when a disarmed Goal on an armed run cannot be rearmed', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'rearm an armed run Goal' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    ctx.goals.disarm(agent)
    vi.spyOn(ctx.goals, 'resume').mockImplementation(() => { throw new Error('Goal CAS unavailable') })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: /Goal CAS unavailable/,
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('marks an expired crash-disarmed row for attention instead of guessing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { autoResume: true, defaultMaxActiveMs: 10, maxActiveMs: 10 },
    })
    const goal = ctx.goals.create(agent, { objective: 'expire during outage' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const snapshot = latestSnapshot(ctx, agent)
    const expected = recoveryRef(snapshot)
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate outage')
    ctx.goals.disarm(agent)
    if (snapshot.expiresAt === undefined) throw new Error('fixture run has no expiry')
    vi.setSystemTime(snapshot.expiresAt)

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: /expired/,
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'needs-attention', remainingActiveMs: 0 })
    await ctx.fiber.dispose()
  })

  it('contains Goal rearm failure and persists needs-attention on the activated revision', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'Goal rearm failure' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate outage')
    ctx.goals.disarm(agent)
    vi.spyOn(ctx.goals, 'resume').mockImplementation(() => { throw new Error('Goal log unavailable') })

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: /Goal log unavailable/,
    })
    expect(ctx.autonomy.get(agent)).toMatchObject({ revision: 3, phase: 'needs-attention' })
    expect(ctx.autonomy.history(agent).map(item => item.operation)).toEqual([
      'start', 'resume', 'needs-attention',
    ])
    await ctx.fiber.dispose()
  })

  it('reports both Goal rearm and attention persistence failures', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'aggregate recovery failure' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const runtime = probe(ctx.autonomy).runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    probe(ctx.autonomy).disarmRuntime(agent, runtime, 'simulate outage')
    ctx.goals.disarm(agent)
    vi.spyOn(ctx.goals, 'resume').mockImplementation(() => {
      const activatedRuntime = probe(ctx.autonomy).runtimes.get(agent)
      if (activatedRuntime !== undefined) {
        probe(ctx.autonomy).disarmRuntime(agent, activatedRuntime, 'concurrent recovery shutdown')
      }
      throw new Error('Goal resume failed')
    })
    vi.spyOn(ctx.autonomy, 'markNeedsAttention').mockRejectedValueOnce(new Error('sidecar failed'))

    await expect(ctx.autonomy.activateRecovered(expected, agent, goal)).rejects.toThrow(AggregateError)
    expect(ctx.autonomy.get(agent)).toMatchObject({ revision: 2, phase: 'running', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('distinguishes a failed recovery write, a competing write, and notification failure', async () => {
    const failed = await createServiceHarness({ autonomy: { autoResume: true } })
    const failedGoal = failed.ctx.goals.create(failed.agent, { objective: 'failed recovery write' })
    await failed.ctx.autonomy.start(failed.agent, { goalId: failedGoal.id })
    const failedExpected = recoveryRef(latestSnapshot(failed.ctx, failed.agent))
    const failedRuntime = probe(failed.ctx.autonomy).runtimes.get(failed.agent)
    const failedStore = probe(failed.ctx.autonomy).store
    if (failedRuntime === undefined || failedStore === undefined) throw new Error('fixture internals are missing')
    probe(failed.ctx.autonomy).disarmRuntime(failed.agent, failedRuntime, 'simulate outage')
    failed.ctx.goals.disarm(failed.agent)
    const failedAppend = vi.spyOn(failedStore, 'appendIfCurrent').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(failed.ctx.autonomy.activateRecovered(
      failedExpected,
      failed.agent,
      failedGoal,
    )).rejects.toThrow(/disk unavailable/)
    failedAppend.mockRestore()

    const originalAppend = failedStore.append.bind(failedStore)
    const racingAppend = vi.spyOn(failedStore, 'appendIfCurrent').mockImplementationOnce(async () => {
      const current = failedStore.get(String(failed.agent.id))
      if (current === undefined) throw new Error('fixture row is missing')
      await originalAppend('pause', Object.freeze({
        ...current,
        revision: current.revision + 1,
        updatedAt: current.updatedAt + 1,
        phase: 'paused',
        expiresAt: undefined,
        reason: 'concurrent user pause',
      }))
      return undefined
    })
    await expect(failed.ctx.autonomy.activateRecovered(
      failedExpected,
      failed.agent,
      failedGoal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    racingAppend.mockRestore()
    await failed.ctx.fiber.dispose()

    const notified = await createServiceHarness({ autonomy: { autoResume: true } })
    const notifiedGoal = notified.ctx.goals.create(notified.agent, { objective: 'notification failure' })
    await notified.ctx.autonomy.start(notified.agent, { goalId: notifiedGoal.id })
    const notifiedExpected = recoveryRef(latestSnapshot(notified.ctx, notified.agent))
    const notifiedRuntime = probe(notified.ctx.autonomy).runtimes.get(notified.agent)
    if (notifiedRuntime === undefined) throw new Error('fixture runtime is missing')
    probe(notified.ctx.autonomy).disarmRuntime(notified.agent, notifiedRuntime, 'simulate outage')
    notified.ctx.goals.disarm(notified.agent)
    notified.ctx.on('autonomy/changed', ({ operation }) => {
      if (operation === 'resume') throw new Error('observer failed')
    })
    const logged = vi.spyOn(notified.ctx.logger, 'error').mockImplementation(() => notified.ctx.logger)

    await expect(notified.ctx.autonomy.activateRecovered(
      notifiedExpected,
      notified.agent,
      notifiedGoal,
    )).resolves.toEqual({ kind: 'recovered' })
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/notification failed/))
    expect(notified.ctx.autonomy.get(notified.agent)).toMatchObject({ activation: 'armed' })
    await notified.ctx.fiber.dispose()
  })

  it('marks a detached current row without requiring a live Agent', async () => {
    const { ctx } = await createServiceHarness({ autonomy: { autoResume: true } })
    const detached = createTestAgent('detached-recovery-session')
    const unregister = ctx.agents.register(detached)
    const goal = ctx.goals.create(detached, { objective: 'detached recovery row' })
    await ctx.autonomy.start(detached, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, detached))
    unregister()

    await expect(ctx.autonomy.markNeedsAttention(expected, ' host process disappeared ')).resolves.toBeUndefined()
    expect(latestSnapshot(ctx, detached)).toMatchObject({
      phase: 'needs-attention',
      reason: 'host process disappeared',
    })
    await ctx.fiber.dispose()
  })

  it('fails a detached active row closed when the last critical contribution unloads', async () => {
    const { ctx } = await createServiceHarness({ autonomy: { autoResume: true } })
    const detached = createTestAgent('detached-readiness-session')
    const unregister = ctx.agents.register(detached)
    const goal = ctx.goals.create(detached, { objective: 'do not recover under a partial bundle' })
    await ctx.autonomy.start(detached, { goalId: goal.id })
    unregister()
    await ctx.plugin(AutopilotRecoveryReadiness)
    const disposers = new Map(RECOVERY_CRITICAL_CONTRIBUTIONS.map(contribution => [
      contribution,
      ctx.autopilotRecoveryReadiness.register(contribution),
    ]))

    disposers.get('visual-qa')?.()

    await vi.waitFor(() => {
      expect(latestSnapshot(ctx, detached)).toMatchObject({
        phase: 'needs-attention',
        reason: expect.stringContaining('contribution unloaded: visual-qa'),
      })
    })
    expect(ctx.agents.get(detached.id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('returns crash-interrupted task attempts to pending before activation', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const interrupted = latestSnapshot(harness.ctx, harness.agent)
    const expected = recoveryRef(interrupted)

    await expect(harness.ctx.autonomy.recoverInterruptedTasks(
      expected,
      harness.agent,
      'process crashed',
    )).resolves.toMatchObject({
      kind: 'recovered',
      taskIds: ['build'],
      run: { revision: expected.revision + 1 },
    })
    expect(harness.ctx.autonomy.get(harness.agent)?.plan?.tasks[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      attemptHistory: [expect.objectContaining({ outcome: 'interrupted', reason: 'process crashed' })],
    })
    const current = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    await expect(harness.ctx.autonomy.recoverInterruptedTasks(
      current,
      harness.agent,
      'second scan',
    )).resolves.toEqual({ kind: 'unchanged', run: current })
    await expect(harness.ctx.autonomy.recoverInterruptedTasks(
      expected,
      harness.agent,
      'stale scan',
    )).resolves.toMatchObject({ kind: 'superseded' })
    await expect(harness.ctx.autonomy.recoverInterruptedTasks(
      current,
      createTestAgent('wrong-task-recovery-agent'),
      'wrong owner',
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await harness.ctx.fiber.dispose()

    const noPlan = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = noPlan.ctx.goals.create(noPlan.agent, { objective: 'no task graph' })
    await noPlan.ctx.autonomy.start(noPlan.agent, { goalId: goal.id })
    const noPlanRef = recoveryRef(latestSnapshot(noPlan.ctx, noPlan.agent))
    await expect(noPlan.ctx.autonomy.recoverInterruptedTasks(
      noPlanRef,
      noPlan.agent,
      'process restarted',
    )).resolves.toEqual({ kind: 'unchanged', run: noPlanRef })
    await noPlan.ctx.fiber.dispose()
  })

  it('distinguishes task-recovery storage failure from a concurrent sidecar mutation', async () => {
    const harness = await startPlannedRun({ autonomy: { autoResume: true } })
    await harness.ctx.autonomy.claimTasks(harness.agent, ['build'])
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    const store = probe(harness.ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    const failed = vi.spyOn(store, 'appendIfCurrent').mockRejectedValueOnce(new Error('task store unavailable'))
    await expect(harness.ctx.autonomy.recoverInterruptedTasks(
      expected,
      harness.agent,
      'process restarted',
    )).rejects.toThrow(/task store unavailable/)
    failed.mockRestore()

    const originalAppend = store.append.bind(store)
    vi.spyOn(store, 'appendIfCurrent').mockImplementationOnce(async () => {
      const current = store.get(String(harness.agent.id))
      if (current === undefined) throw new Error('fixture row is missing')
      await originalAppend('pause', Object.freeze({
        ...current,
        revision: current.revision + 1,
        updatedAt: current.updatedAt + 1,
        phase: 'paused',
        expiresAt: undefined,
        reason: 'concurrent pause',
      }))
      return undefined
    })
    await expect(harness.ctx.autonomy.recoverInterruptedTasks(
      expected,
      harness.agent,
      'process restarted',
    )).resolves.toMatchObject({ kind: 'superseded' })
    await harness.ctx.fiber.dispose()
  })

  it('disarms runtime and Goal before a failed needs-attention write', async () => {
    const { ctx, agent } = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = ctx.goals.create(agent, { objective: 'fail closed before storage' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(ctx, agent))
    const signal = ctx.autonomy.signal(agent)
    const store = probe(ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    vi.spyOn(store, 'reduceCurrent').mockRejectedValueOnce(new Error('attention store unavailable'))

    await expect(ctx.autonomy.markNeedsAttention(expected, 'reconciliation failed')).rejects.toThrow(
      /attention store unavailable/,
    )
    expect(signal.aborted).toBe(true)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    await ctx.fiber.dispose()
  })

  it('validates interrupted lifecycle ownership, revisions, materialized starts, and stopped tombstones', async () => {
    const harness = await createServiceHarness({ autonomy: { autoResume: true } })
    const goal = harness.ctx.goals.create(harness.agent, { objective: 'settle lifecycle validation' })
    await harness.ctx.autonomy.start(harness.agent, { goalId: goal.id })
    const expected = recoveryRef(latestSnapshot(harness.ctx, harness.agent))
    await expect(harness.ctx.autonomy.settleInterruptedLifecycle(
      expected,
      createTestAgent('wrong-lifecycle-owner'),
      lifecycleIntent({ kind: 'pause' }),
    )).rejects.toMatchObject({ code: 'AUTONOMY_INVALID_TRANSITION' })
    await expect(harness.ctx.autonomy.settleInterruptedLifecycle(
      { ...expected, runId: 'superseded-run' },
      harness.agent,
      lifecycleIntent({ kind: 'pause' }),
    )).resolves.toMatchObject({ kind: 'superseded' })
    await expect(harness.ctx.autonomy.settleInterruptedLifecycle(
      expected,
      harness.agent,
      lifecycleIntent({ kind: 'start', objective: 'already materialized' }),
    )).resolves.toMatchObject({ kind: 'superseded', reason: /already materialized/ })

    harness.ctx.goals.disarm(harness.agent)
    harness.ctx.goals.clear(harness.agent, harness.ctx.goals.get(harness.agent)!)
    await expect(harness.ctx.autonomy.settleInterruptedLifecycle(
      expected,
      harness.agent,
      lifecycleIntent({ kind: 'pause' }),
    )).resolves.toMatchObject({ kind: 'needs-attention', reason: /does not match/ })
    await harness.ctx.fiber.dispose()

    const stopped = await createServiceHarness({ autonomy: { autoResume: true } })
    const stoppedGoal = stopped.ctx.goals.create(stopped.agent, { objective: 'already stopped' })
    await stopped.ctx.autonomy.start(stopped.agent, { goalId: stoppedGoal.id })
    await stopped.ctx.autonomy.revoke(stopped.agent, 'stop already durable')
    const stoppedRef = recoveryRef(latestSnapshot(stopped.ctx, stopped.agent))
    stopped.ctx.goals.disarm(stopped.agent)
    stopped.ctx.goals.clear(stopped.agent, stopped.ctx.goals.get(stopped.agent)!)
    await expect(stopped.ctx.autonomy.settleInterruptedLifecycle(
      stoppedRef,
      stopped.agent,
      lifecycleIntent({ kind: 'stop' }),
    )).resolves.toEqual({ kind: 'settled', run: stoppedRef })
    await stopped.ctx.fiber.dispose()
  })

  it('settles interrupted resume across finalizing, paused, running, drift, and persistence failure', async () => {
    const finalizing = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(finalizing)
    await finalizing.ctx.autonomy.beginVerification(finalizing.agent, {
      summary: 'candidate', evidence: ['tests'],
    })
    await finalizing.ctx.autonomy.beginFinalization(finalizing.agent, verification('pass'))
    const finalizingRef = recoveryRef(latestSnapshot(finalizing.ctx, finalizing.agent))
    const finalizingGoal = finalizing.ctx.goals.get(finalizing.agent)
    if (finalizingGoal === undefined) throw new Error('fixture Goal is missing')
    await expect(finalizing.ctx.autonomy.settleInterruptedLifecycle(
      finalizingRef,
      finalizing.agent,
      lifecycleIntent({ kind: 'resume' }),
    )).resolves.toMatchObject({ kind: 'settled', run: { revision: finalizingRef.revision + 1 } })
    expect(finalizing.ctx.autonomy.get(finalizing.agent)?.phase).toBe('completed')
    await finalizing.ctx.fiber.dispose()

    const paused = await createServiceHarness({
      autonomy: { autoResume: true, defaultMaxActiveMs: 1000, maxActiveMs: 20_000 },
    })
    const pausedGoal = paused.ctx.goals.create(paused.agent, { objective: 'resume interrupted pause' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: pausedGoal.id })
    await paused.ctx.autonomy.pause(paused.agent)
    paused.ctx.goals.disarm(paused.agent)
    const pausedRef = recoveryRef(latestSnapshot(paused.ctx, paused.agent))
    await expect(paused.ctx.autonomy.settleInterruptedLifecycle(
      pausedRef,
      paused.agent,
      lifecycleIntent({ kind: 'resume', maxActiveMs: 1000 }),
    )).resolves.toMatchObject({ kind: 'recovered' })
    expect(paused.ctx.goals.get(paused.agent)).toMatchObject({ activation: 'armed' })
    await paused.ctx.fiber.dispose()

    const running = await createServiceHarness({ autonomy: { autoResume: true } })
    const runningGoal = running.ctx.goals.create(running.agent, { objective: 'resume materialized grant' })
    await running.ctx.autonomy.start(running.agent, { goalId: runningGoal.id })
    const runningRuntime = probe(running.ctx.autonomy).runtimes.get(running.agent)
    if (runningRuntime === undefined) throw new Error('fixture runtime is missing')
    probe(running.ctx.autonomy).disarmRuntime(running.agent, runningRuntime, 'simulate crash')
    const runningRef = recoveryRef(latestSnapshot(running.ctx, running.agent))
    const goalResume = vi.spyOn(running.ctx.goals, 'resume')
    await expect(running.ctx.autonomy.settleInterruptedLifecycle(
      runningRef,
      running.agent,
      lifecycleIntent({ kind: 'resume', maxActiveMs: 2000 }),
    )).resolves.toMatchObject({ kind: 'recovered' })
    expect(goalResume).not.toHaveBeenCalled()
    await running.ctx.fiber.dispose()

    const drift = await createServiceHarness({ autonomy: { autoResume: true } })
    const driftGoal = drift.ctx.goals.create(drift.agent, { objective: 'disappearing resume Goal' })
    await drift.ctx.autonomy.start(drift.agent, { goalId: driftGoal.id })
    const driftRuntime = probe(drift.ctx.autonomy).runtimes.get(drift.agent)
    if (driftRuntime === undefined) throw new Error('fixture runtime is missing')
    probe(drift.ctx.autonomy).disarmRuntime(drift.agent, driftRuntime, 'simulate crash')
    drift.ctx.goals.disarm(drift.agent)
    const driftRef = recoveryRef(latestSnapshot(drift.ctx, drift.agent))
    const originalGet = drift.ctx.goals.get.bind(drift.ctx.goals)
    let getCalls = 0
    vi.spyOn(drift.ctx.goals, 'get').mockImplementation((...args) => {
      getCalls += 1
      return getCalls === 4 ? undefined : originalGet(...args)
    })
    await expect(drift.ctx.autonomy.settleInterruptedLifecycle(
      driftRef,
      drift.agent,
      lifecycleIntent({ kind: 'resume' }),
    )).resolves.toMatchObject({ kind: 'needs-attention', reason: /disappeared/ })
    await drift.ctx.fiber.dispose()

    const unflushed = await createServiceHarness({ autonomy: { autoResume: true } })
    const unflushedGoal = unflushed.ctx.goals.create(unflushed.agent, { objective: 'require durable resume' })
    await unflushed.ctx.autonomy.start(unflushed.agent, { goalId: unflushedGoal.id })
    await unflushed.ctx.autonomy.pause(unflushed.agent)
    unflushed.ctx.goals.disarm(unflushed.agent)
    const unflushedRef = recoveryRef(latestSnapshot(unflushed.ctx, unflushed.agent))
    vi.spyOn(unflushed.ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(unflushed.ctx.autonomy.settleInterruptedLifecycle(
      unflushedRef,
      unflushed.agent,
      lifecycleIntent({ kind: 'resume' }),
    )).rejects.toThrow(/requires configured session persistence/)
    await unflushed.ctx.fiber.dispose()
  })

  it('settles interrupted pause and stop without repeating durable mutations', async () => {
    const paused = await createServiceHarness({ autonomy: { autoResume: true } })
    const pausedGoal = paused.ctx.goals.create(paused.agent, { objective: 'recover pause command' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: pausedGoal.id })
    const pausedRef = recoveryRef(latestSnapshot(paused.ctx, paused.agent))
    await expect(paused.ctx.autonomy.settleInterruptedLifecycle(
      pausedRef,
      paused.agent,
      lifecycleIntent({ kind: 'pause' }),
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(paused.ctx.goals.get(paused.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    const alreadyPausedRef = recoveryRef(latestSnapshot(paused.ctx, paused.agent))
    await expect(paused.ctx.autonomy.settleInterruptedLifecycle(
      alreadyPausedRef,
      paused.agent,
      lifecycleIntent({ kind: 'pause' }),
    )).resolves.toEqual({ kind: 'settled', run: alreadyPausedRef })
    await paused.ctx.fiber.dispose()

    const stopped = await createServiceHarness({ autonomy: { autoResume: true } })
    const stoppedGoal = stopped.ctx.goals.create(stopped.agent, { objective: 'recover stop command' })
    await stopped.ctx.autonomy.start(stopped.agent, { goalId: stoppedGoal.id })
    const stoppedRef = recoveryRef(latestSnapshot(stopped.ctx, stopped.agent))
    await expect(stopped.ctx.autonomy.settleInterruptedLifecycle(
      stoppedRef,
      stopped.agent,
      lifecycleIntent({ kind: 'stop' }),
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(stopped.ctx.autonomy.get(stopped.agent)?.phase).toBe('revoked')
    expect(stopped.ctx.goals.get(stopped.agent)).toBeUndefined()
    await stopped.ctx.fiber.dispose()

    const durableStop = await createServiceHarness({ autonomy: { autoResume: true } })
    const durableGoal = durableStop.ctx.goals.create(durableStop.agent, { objective: 'finish Goal cleanup' })
    await durableStop.ctx.autonomy.start(durableStop.agent, { goalId: durableGoal.id })
    await durableStop.ctx.autonomy.revoke(durableStop.agent)
    const durableStopRef = recoveryRef(latestSnapshot(durableStop.ctx, durableStop.agent))
    await expect(durableStop.ctx.autonomy.settleInterruptedLifecycle(
      durableStopRef,
      durableStop.agent,
      lifecycleIntent({ kind: 'stop' }),
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(durableStop.ctx.goals.get(durableStop.agent)).toBeUndefined()
    await durableStop.ctx.fiber.dispose()

    const completedGoal = await createServiceHarness({ autonomy: { autoResume: true } })
    const completeBeforePause = completedGoal.ctx.goals.create(completedGoal.agent, {
      objective: 'Goal completed before pause intent settled',
    })
    await completedGoal.ctx.autonomy.start(completedGoal.agent, { goalId: completeBeforePause.id })
    completedGoal.ctx.goals.complete(completedGoal.agent, completeBeforePause)
    const completedGoalRef = recoveryRef(latestSnapshot(completedGoal.ctx, completedGoal.agent))
    await expect(completedGoal.ctx.autonomy.settleInterruptedLifecycle(
      completedGoalRef,
      completedGoal.agent,
      lifecycleIntent({ kind: 'pause' }),
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(completedGoal.ctx.goals.get(completedGoal.agent)?.phase).toBe('complete')
    await completedGoal.ctx.fiber.dispose()
  })

  it('converges safe sidecar phases to exact Goal pause, block, or clear operations', async () => {
    const paused = await createServiceHarness({ autonomy: { autoResume: true } })
    const pausedGoal = paused.ctx.goals.create(paused.agent, { objective: 'converge paused Goal' })
    await paused.ctx.autonomy.start(paused.agent, { goalId: pausedGoal.id })
    await paused.ctx.autonomy.pause(paused.agent, 'safe pause')
    const pausedRef = recoveryRef(latestSnapshot(paused.ctx, paused.agent))
    const currentPausedGoal = paused.ctx.goals.get(paused.agent)
    if (currentPausedGoal === undefined) throw new Error('fixture Goal is missing')
    await expect(paused.ctx.autonomy.convergeSafetyState(
      pausedRef,
      paused.agent,
      currentPausedGoal,
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(paused.ctx.goals.get(paused.agent)).toMatchObject({ phase: 'paused' })
    await expect(paused.ctx.autonomy.convergeSafetyState(
      { ...pausedRef, runId: 'superseded-run' },
      paused.agent,
      currentPausedGoal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    await paused.ctx.fiber.dispose()

    const attention = await createServiceHarness({ autonomy: { autoResume: true } })
    const attentionGoal = attention.ctx.goals.create(attention.agent, { objective: 'block attention Goal' })
    await attention.ctx.autonomy.start(attention.agent, { goalId: attentionGoal.id })
    const attentionStart = recoveryRef(latestSnapshot(attention.ctx, attention.agent))
    await attention.ctx.autonomy.markNeedsAttention(attentionStart, 'manual reconciliation required')
    const attentionRef = recoveryRef(latestSnapshot(attention.ctx, attention.agent))
    const liveAttentionGoal = attention.ctx.goals.get(attention.agent)
    if (liveAttentionGoal === undefined) throw new Error('fixture Goal is missing')
    await expect(attention.ctx.autonomy.convergeSafetyState(
      attentionRef,
      attention.agent,
      liveAttentionGoal,
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(attention.ctx.goals.get(attention.agent)).toMatchObject({ phase: 'blocked' })
    await attention.ctx.fiber.dispose()

    const fallback = await createServiceHarness({ autonomy: { autoResume: true } })
    const fallbackGoal = fallback.ctx.goals.create(fallback.agent, { objective: 'fallback attention reason' })
    await fallback.ctx.autonomy.start(fallback.agent, { goalId: fallbackGoal.id })
    const fallbackSnapshot = latestSnapshot(fallback.ctx, fallback.agent)
    const fallbackRef = recoveryRef(fallbackSnapshot)
    const fallbackStore = probe(fallback.ctx.autonomy).store
    if (fallbackStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(fallbackStore, 'get').mockReturnValue({ ...fallbackSnapshot, phase: 'needs-attention' })
    await expect(fallback.ctx.autonomy.convergeSafetyState(
      fallbackRef,
      fallback.agent,
      fallbackGoal,
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(fallback.ctx.goals.get(fallback.agent)).toMatchObject({
      phase: 'blocked',
      blockedReason: { message: 'Autopilot requires human reconciliation' },
    })
    await fallback.ctx.fiber.dispose()

    const revoked = await createServiceHarness({ autonomy: { autoResume: true } })
    const revokedGoal = revoked.ctx.goals.create(revoked.agent, { objective: 'clear revoked Goal' })
    await revoked.ctx.autonomy.start(revoked.agent, { goalId: revokedGoal.id })
    await revoked.ctx.autonomy.revoke(revoked.agent)
    const revokedRef = recoveryRef(latestSnapshot(revoked.ctx, revoked.agent))
    const liveRevokedGoal = revoked.ctx.goals.get(revoked.agent)
    if (liveRevokedGoal === undefined) throw new Error('fixture Goal is missing')
    await expect(revoked.ctx.autonomy.convergeSafetyState(
      revokedRef,
      revoked.agent,
      liveRevokedGoal,
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(revoked.ctx.goals.get(revoked.agent)).toBeUndefined()
    await revoked.ctx.fiber.dispose()

    const mismatch = await createServiceHarness({ autonomy: { autoResume: true } })
    const mismatchGoal = mismatch.ctx.goals.create(mismatch.agent, { objective: 'reject changed Goal' })
    await mismatch.ctx.autonomy.start(mismatch.agent, { goalId: mismatchGoal.id })
    await mismatch.ctx.autonomy.pause(mismatch.agent)
    const mismatchRef = recoveryRef(latestSnapshot(mismatch.ctx, mismatch.agent))
    await expect(mismatch.ctx.autonomy.convergeSafetyState(
      mismatchRef,
      mismatch.agent,
      { id: mismatchGoal.id, revision: mismatchGoal.revision + 1 },
    )).resolves.toMatchObject({ kind: 'needs-attention' })
    await mismatch.ctx.fiber.dispose()
  })

  it('converges only an exact completed sidecar and active Goal', async () => {
    const running = await createServiceHarness({ autonomy: { autoResume: true } })
    const runningGoal = running.ctx.goals.create(running.agent, { objective: 'not completed' })
    await running.ctx.autonomy.start(running.agent, { goalId: runningGoal.id })
    const runningRef = recoveryRef(latestSnapshot(running.ctx, running.agent))
    await expect(running.ctx.autonomy.convergeCompletedGoal(
      runningRef,
      running.agent,
      runningGoal,
    )).resolves.toMatchObject({ kind: 'superseded' })
    await running.ctx.fiber.dispose()

    const completed = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(completed)
    await completed.ctx.autonomy.beginVerification(completed.agent, {
      summary: 'candidate', evidence: ['tests'],
    })
    await completed.ctx.autonomy.complete(completed.agent, verification('pass'))
    const completedRef = recoveryRef(latestSnapshot(completed.ctx, completed.agent))
    const durableGoal = completed.ctx.goals.get(completed.agent)
    if (durableGoal === undefined) throw new Error('fixture Goal is missing')
    const activeGoal = { ...durableGoal, phase: 'active' as const }
    vi.spyOn(completed.ctx.goals, 'get').mockReturnValue(activeGoal)
    const complete = vi.spyOn(completed.ctx.goals, 'complete').mockReturnValue(durableGoal)
    await expect(completed.ctx.autonomy.convergeCompletedGoal(
      completedRef,
      completed.agent,
      activeGoal,
    )).resolves.toMatchObject({ kind: 'settled' })
    expect(complete).toHaveBeenCalledOnce()
    await completed.ctx.fiber.dispose()

    const changed = await startPlannedRun({ autonomy: { autoResume: true } })
    await completeTaskGraph(changed)
    await changed.ctx.autonomy.beginVerification(changed.agent, { summary: 'candidate', evidence: ['tests'] })
    await changed.ctx.autonomy.complete(changed.agent, verification('pass'))
    const changedRef = recoveryRef(latestSnapshot(changed.ctx, changed.agent))
    const changedGoal = changed.ctx.goals.get(changed.agent)
    if (changedGoal === undefined) throw new Error('fixture Goal is missing')
    await expect(changed.ctx.autonomy.convergeCompletedGoal(
      changedRef,
      changed.agent,
      { id: changedGoal.id, revision: changedGoal.revision + 1 },
    )).resolves.toMatchObject({ kind: 'needs-attention' })
    await changed.ctx.fiber.dispose()
  })
})

describe('AutonomyService defensive timer and persistence paths', () => {
  it('rejects concurrent safety mutations at their serialized store decision point', async () => {
    const attentionRace = await createServiceHarness({ autonomy: { autoResume: true } })
    const attentionGoal = attentionRace.ctx.goals.create(attentionRace.agent, { objective: 'attention race' })
    await attentionRace.ctx.autonomy.start(attentionRace.agent, { goalId: attentionGoal.id })
    const attentionRef = recoveryRef(latestSnapshot(attentionRace.ctx, attentionRace.agent))
    const attentionStore = probe(attentionRace.ctx.autonomy).store
    if (attentionStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(attentionStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      reduce({ ...latestSnapshot(attentionRace.ctx, attentionRace.agent), runId: 'concurrent-run' })
      return undefined
    })
    await expect(attentionRace.ctx.autonomy.markNeedsAttention(
      attentionRef,
      'concurrent attention',
    )).rejects.toThrow(/stale recovery run/)
    await attentionRace.ctx.fiber.dispose()

    const emptyAttention = await createServiceHarness({ autonomy: { autoResume: true } })
    const emptyGoal = emptyAttention.ctx.goals.create(emptyAttention.agent, { objective: 'missing reducer result' })
    await emptyAttention.ctx.autonomy.start(emptyAttention.agent, { goalId: emptyGoal.id })
    const emptyRef = recoveryRef(latestSnapshot(emptyAttention.ctx, emptyAttention.agent))
    const emptyStore = probe(emptyAttention.ctx.autonomy).store
    if (emptyStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(emptyStore, 'reduceCurrent').mockResolvedValueOnce(undefined)
    await expect(emptyAttention.ctx.autonomy.markNeedsAttention(
      emptyRef,
      'missing durable result',
    )).rejects.toThrow(/did not commit/)
    await emptyAttention.ctx.fiber.dispose()

    const pauseRace = await createServiceHarness()
    const pauseGoal = pauseRace.ctx.goals.create(pauseRace.agent, { objective: 'pause race' })
    await pauseRace.ctx.autonomy.start(pauseRace.agent, { goalId: pauseGoal.id })
    const pauseStore = probe(pauseRace.ctx.autonomy).store
    if (pauseStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(pauseStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      reduce(undefined)
      return undefined
    })
    await expect(pauseRace.ctx.autonomy.pause(pauseRace.agent)).rejects.toThrow(/changed before pause/)
    await pauseRace.ctx.fiber.dispose()

    const pausePhase = await createServiceHarness()
    const pausePhaseGoal = pausePhase.ctx.goals.create(pausePhase.agent, { objective: 'pause phase race' })
    await pausePhase.ctx.autonomy.start(pausePhase.agent, { goalId: pausePhaseGoal.id })
    const pausePhaseStore = probe(pausePhase.ctx.autonomy).store
    if (pausePhaseStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(pausePhaseStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      const current = latestSnapshot(pausePhase.ctx, pausePhase.agent)
      reduce({ ...current, phase: 'revoked', expiresAt: undefined })
      return undefined
    })
    await expect(pausePhase.ctx.autonomy.pause(pausePhase.agent)).rejects.toThrow(/cannot pause/)
    await pausePhase.ctx.fiber.dispose()

    const resumeRace = await createServiceHarness()
    const resumeGoal = resumeRace.ctx.goals.create(resumeRace.agent, { objective: 'resume race' })
    await resumeRace.ctx.autonomy.start(resumeRace.agent, { goalId: resumeGoal.id })
    await resumeRace.ctx.autonomy.pause(resumeRace.agent)
    const resumeStore = probe(resumeRace.ctx.autonomy).store
    if (resumeStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(resumeStore, 'appendIfCurrent').mockResolvedValueOnce(undefined)
    await expect(resumeRace.ctx.autonomy.resume(resumeRace.agent, resumeGoal.id)).rejects.toThrow(
      /changed before resume/,
    )
    await resumeRace.ctx.fiber.dispose()

    const revokeRace = await createServiceHarness()
    const revokeGoal = revokeRace.ctx.goals.create(revokeRace.agent, { objective: 'revoke race' })
    await revokeRace.ctx.autonomy.start(revokeRace.agent, { goalId: revokeGoal.id })
    const revokeStore = probe(revokeRace.ctx.autonomy).store
    if (revokeStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(revokeStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      reduce(undefined)
      return undefined
    })
    await expect(revokeRace.ctx.autonomy.revoke(revokeRace.agent)).rejects.toThrow(/changed before revoke/)
    await revokeRace.ctx.fiber.dispose()

    const revokePhase = await createServiceHarness()
    const revokePhaseGoal = revokePhase.ctx.goals.create(revokePhase.agent, { objective: 'revoke phase race' })
    await revokePhase.ctx.autonomy.start(revokePhase.agent, { goalId: revokePhaseGoal.id })
    const revokePhaseStore = probe(revokePhase.ctx.autonomy).store
    if (revokePhaseStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(revokePhaseStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      const current = latestSnapshot(revokePhase.ctx, revokePhase.agent)
      reduce({ ...current, phase: 'revoked', expiresAt: undefined })
      return undefined
    })
    await expect(revokePhase.ctx.autonomy.revoke(revokePhase.agent)).rejects.toThrow(/cannot revoke/)
    await revokePhase.ctx.fiber.dispose()
  })

  it('fails closed when verifier and finalization CAS operations lose their exact row', async () => {
    const missingGoal = await startPlannedRun()
    await completeTaskGraph(missingGoal)
    await missingGoal.ctx.autonomy.beginVerification(missingGoal.agent, {
      summary: 'candidate', evidence: ['tests'],
    })
    await missingGoal.ctx.autonomy.beginFinalization(missingGoal.agent, verification('pass'))
    const finalizingGoal = missingGoal.ctx.goals.get(missingGoal.agent)
    if (finalizingGoal === undefined) throw new Error('fixture Goal is missing')
    missingGoal.ctx.goals.clear(missingGoal.agent, finalizingGoal)
    await expect(missingGoal.ctx.autonomy.resume(
      missingGoal.agent,
      finalizingGoal.id,
    )).rejects.toThrow(/finalizing Goal is unavailable/)
    await missingGoal.ctx.fiber.dispose()

    const verifier = await startPlannedRun()
    await completeTaskGraph(verifier)
    await verifier.ctx.autonomy.beginVerification(verifier.agent, { summary: 'candidate', evidence: ['tests'] })
    const verifierStore = probe(verifier.ctx.autonomy).store
    if (verifierStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(verifierStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      reduce(undefined)
      return undefined
    })
    await expect(verifier.ctx.autonomy.verificationErrored(
      verifier.agent,
      verification('inconclusive'),
    )).rejects.toThrow(/changed before verifier error/)
    await verifier.ctx.fiber.dispose()

    const reservation = await startPlannedRun()
    await completeTaskGraph(reservation)
    await reservation.ctx.autonomy.beginVerification(reservation.agent, {
      summary: 'candidate', evidence: ['tests'],
    })
    const reservationStore = probe(reservation.ctx.autonomy).store
    if (reservationStore === undefined) throw new Error('fixture store is missing')
    vi.spyOn(reservationStore, 'appendIfCurrent').mockResolvedValueOnce(undefined)
    await expect(reservation.ctx.autonomy.beginFinalization(
      reservation.agent,
      verification('pass'),
    )).rejects.toThrow(/changed before finalization/)
    expect(reservation.ctx.goals.get(reservation.agent)).toMatchObject({ activation: 'disarmed' })
    await reservation.ctx.fiber.dispose()

    const completion = await startPlannedRun()
    await completeTaskGraph(completion)
    await completion.ctx.autonomy.beginVerification(completion.agent, {
      summary: 'candidate', evidence: ['tests'],
    })
    await completion.ctx.autonomy.beginFinalization(completion.agent, verification('pass'))
    const completionRef = recoveryRef(latestSnapshot(completion.ctx, completion.agent))
    const completionGoal = completion.ctx.goals.get(completion.agent)
    const completionStore = probe(completion.ctx.autonomy).store
    if (completionGoal === undefined || completionStore === undefined) throw new Error('fixture state is missing')
    vi.spyOn(completionStore, 'appendIfCurrent').mockImplementationOnce(async () => {
      await completion.ctx.autonomy.markNeedsAttention(completionRef, 'concurrent finalization safety marker')
      return undefined
    })
    await expect(completion.ctx.autonomy.finalizeCompletion(
      completion.agent,
      completionGoal,
    )).rejects.toThrow(/sidecar changed/)
    expect(completion.ctx.autonomy.get(completion.agent)?.phase).toBe('needs-attention')
    await completion.ctx.fiber.dispose()
  })

  it('re-arms safely, replaces existing timers, and ignores non-current runtime disposal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 1000, maxActiveMs: 2000 },
    })
    const goal = ctx.goals.create(agent, { objective: 'timer defenses' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const internals = probe(ctx.autonomy)
    const snapshot = latestSnapshot(ctx, agent)
    const firstSignal = ctx.autonomy.signal(agent)
    internals.armRuntime(agent, snapshot)
    expect(firstSignal.aborted).toBe(true)
    const current = internals.runtimes.get(agent)
    if (current === undefined) throw new Error('fixture runtime is missing')
    const timer = current.timer
    internals.scheduleExpiry(agent, snapshot, current)
    expect(current.timer).not.toBe(timer)

    const foreign: RuntimeProbe = {
      runId: snapshot.runId,
      goalId: snapshot.goalId as GoalId,
      activity: new AbortController(),
    }
    internals.disarmRuntime(agent, foreign, 'foreign runtime')
    expect(foreign.activity.signal.aborted).toBe(true)
    expect(internals.runtimes.get(agent)).toBe(current)
    await ctx.fiber.dispose()
  })

  it('ignores expiry callbacks whose session, run, or runtime identity is stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 100, maxActiveMs: 100 },
    })
    const goal = ctx.goals.create(agent, { objective: 'stale callbacks' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const internals = probe(ctx.autonomy)
    const stored = latestSnapshot(ctx, agent)
    const due = { ...stored, expiresAt: Date.now() }
    const missingAgent = createTestAgent('missing-timer-session')
    const missingRuntime: RuntimeProbe = {
      runId: stored.runId,
      goalId: stored.goalId as GoalId,
      activity: new AbortController(),
    }
    const wrongRun: RuntimeProbe = {
      runId: 'wrong-run',
      goalId: stored.goalId as GoalId,
      activity: new AbortController(),
    }
    const detached: RuntimeProbe = {
      runId: stored.runId,
      goalId: stored.goalId as GoalId,
      activity: new AbortController(),
    }
    internals.scheduleExpiry(missingAgent, due, missingRuntime)
    internals.scheduleExpiry(agent, due, wrongRun)
    internals.scheduleExpiry(agent, due, detached)
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.autonomy.get(agent)?.phase).toBe('running')
    await ctx.fiber.dispose()
  })

  it('reschedules an early direct expiry check without exhausting the run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { ctx, agent } = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 1000, maxActiveMs: 1000 },
    })
    const goal = ctx.goals.create(agent, { objective: 'early expiry check' })
    await ctx.autonomy.start(agent, { goalId: goal.id })
    const internals = probe(ctx.autonomy)
    const runtime = internals.runtimes.get(agent)
    if (runtime === undefined) throw new Error('fixture runtime is missing')
    await internals.expire(agent, latestSnapshot(ctx, agent), runtime)
    expect(ctx.autonomy.get(agent)).toMatchObject({ phase: 'running', activation: 'armed' })
    expect(runtime.timer).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('contains expiry races that extend, supersede, or verify the active row', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const extended = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 1000 },
    })
    const extendedGoal = extended.ctx.goals.create(extended.agent, { objective: 'expiry extension race' })
    await extended.ctx.autonomy.start(extended.agent, { goalId: extendedGoal.id })
    const extendedInternals = probe(extended.ctx.autonomy)
    const extendedRuntime = extendedInternals.runtimes.get(extended.agent)
    const extendedStore = extendedInternals.store
    if (extendedRuntime === undefined || extendedStore === undefined) throw new Error('fixture internals are missing')
    const due = { ...latestSnapshot(extended.ctx, extended.agent), expiresAt: Date.now() }
    vi.spyOn(extendedStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => reduce({
      ...latestSnapshot(extended.ctx, extended.agent),
      expiresAt: Date.now() + 500,
      remainingActiveMs: 500,
      maxActiveMs: 510,
    }) === undefined ? undefined : undefined)
    await extendedInternals.expire(extended.agent, due, extendedRuntime)
    expect(extended.ctx.autonomy.get(extended.agent)?.phase).toBe('running')
    expect(extendedInternals.runtimes.get(extended.agent)).toBeDefined()
    await extended.ctx.fiber.dispose()

    vi.setSystemTime(2000)
    const superseded = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
    })
    const supersededGoal = superseded.ctx.goals.create(superseded.agent, { objective: 'expiry superseded' })
    await superseded.ctx.autonomy.start(superseded.agent, { goalId: supersededGoal.id })
    const supersededInternals = probe(superseded.ctx.autonomy)
    const supersededRuntime = supersededInternals.runtimes.get(superseded.agent)
    const supersededStore = supersededInternals.store
    if (supersededRuntime === undefined || supersededStore === undefined) throw new Error('fixture internals are missing')
    vi.spyOn(supersededStore, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      const current = latestSnapshot(superseded.ctx, superseded.agent)
      const { expiresAt: _expiresAt, ...terminal } = current
      reduce({ ...terminal, phase: 'revoked' })
      return undefined
    })
    await supersededInternals.expire(
      superseded.agent,
      { ...latestSnapshot(superseded.ctx, superseded.agent), expiresAt: Date.now() },
      supersededRuntime,
    )
    expect(superseded.ctx.autonomy.get(superseded.agent)?.phase).toBe('running')
    await superseded.ctx.fiber.dispose()

    vi.setSystemTime(3000)
    const verifying = await startPlannedRun({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 100 },
      duration: 10,
    })
    await completeTaskGraph(verifying)
    await verifying.ctx.autonomy.beginVerification(verifying.agent, {
      summary: 'expire verifier', evidence: ['tests'],
    })
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => {
      expect(verifying.ctx.autonomy.get(verifying.agent)?.phase).toBe('exhausted')
    })
    await verifying.ctx.fiber.dispose()
  })

  it('persists lifecycle restart from verifying and ignores a superseded reducer result', async () => {
    const verifying = await startPlannedRun()
    await completeTaskGraph(verifying)
    await verifying.ctx.autonomy.beginVerification(verifying.agent, {
      summary: 'pause verifier on restart', evidence: ['tests'],
    })
    await probe(verifying.ctx.autonomy).pausePersistedRun(verifying.agent, 'session restarted')
    expect(verifying.ctx.autonomy.get(verifying.agent)).toMatchObject({ phase: 'paused' })
    await verifying.ctx.fiber.dispose()

    const superseded = await createServiceHarness()
    const goal = superseded.ctx.goals.create(superseded.agent, { objective: 'lifecycle reducer race' })
    await superseded.ctx.autonomy.start(superseded.agent, { goalId: goal.id })
    const store = probe(superseded.ctx.autonomy).store
    if (store === undefined) throw new Error('fixture store is missing')
    vi.spyOn(store, 'reduceCurrent').mockImplementationOnce(async (_sessionId, reduce) => {
      const current = latestSnapshot(superseded.ctx, superseded.agent)
      const { expiresAt: _expiresAt, ...terminal } = current
      reduce({ ...terminal, phase: 'revoked' })
      return undefined
    })
    await probe(superseded.ctx.autonomy).pausePersistedRun(superseded.agent, 'concurrent stop')
    expect(superseded.ctx.autonomy.get(superseded.agent)?.phase).toBe('running')
    await superseded.ctx.fiber.dispose()
  })

  it('contains durable expiry and lifecycle-pause write failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const expiry = await createServiceHarness({
      autonomy: { defaultMaxActiveMs: 10, maxActiveMs: 10 },
    })
    const expiryGoal = expiry.ctx.goals.create(expiry.agent, { objective: 'failed expiry write' })
    await expiry.ctx.autonomy.start(expiry.agent, { goalId: expiryGoal.id })
    const expiryInternals = probe(expiry.ctx.autonomy)
    const expiryStore = expiryInternals.store
    if (expiryStore === undefined) throw new Error('fixture store is missing')
    const expiryAppend = vi.spyOn(expiryStore, 'reduceCurrent').mockRejectedValueOnce(new Error('disk unavailable'))
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => { expect(expiry.agent.cancel).toHaveBeenCalled() })
    expect(expiryAppend).toHaveBeenCalled()
    expect(expiry.ctx.autonomy.get(expiry.agent)).toMatchObject({ phase: 'running', activation: 'disarmed' })
    expiryAppend.mockRestore()
    await expiry.ctx.fiber.dispose()

    vi.setSystemTime(2000)
    const lifecycle = await createServiceHarness()
    const lifecycleGoal = lifecycle.ctx.goals.create(lifecycle.agent, { objective: 'failed lifecycle write' })
    await lifecycle.ctx.autonomy.start(lifecycle.agent, { goalId: lifecycleGoal.id })
    const lifecycleInternals = probe(lifecycle.ctx.autonomy)
    const lifecycleStore = lifecycleInternals.store
    if (lifecycleStore === undefined) throw new Error('fixture store is missing')
    const lifecycleAppend = vi.spyOn(lifecycleStore, 'reduceCurrent').mockRejectedValueOnce(new Error('disk unavailable'))
    await lifecycleInternals.pausePersistedRun(lifecycle.agent, 'restart')
    expect(lifecycleAppend).toHaveBeenCalled()
    expect(lifecycle.ctx.autonomy.get(lifecycle.agent)?.phase).toBe('running')
    lifecycleAppend.mockRestore()
    await lifecycle.ctx.autonomy.revoke(lifecycle.agent)
    await lifecycleInternals.pausePersistedRun(lifecycle.agent, 'terminal no-op')
    await lifecycleInternals.pausePersistedRun(createTestAgent('missing-persisted-run'), 'missing no-op')
    await lifecycle.ctx.fiber.dispose()
  })

  it('honors the stale store disposer guard', async () => {
    const { ctx, autonomyFiber } = await createServiceHarness()
    probe(ctx.autonomy).store = undefined
    await autonomyFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('does not clear a newer recovery owner when an older provider scope disposes', async () => {
    const { ctx } = await createServiceHarness()
    ctx.provide('sessionPersistence', {
      inspect: vi.fn(),
      list: vi.fn(async () => []),
    } as never)
    await ctx.autonomy.startRecovery()
    probe(ctx.autonomy).recovery = { owner: 'newer recovery' }
    await ctx.fiber.dispose()
  })
})
