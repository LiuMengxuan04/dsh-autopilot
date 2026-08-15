import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import MissionService, { MissionServiceError } from '../../src/mission-service.ts'
import type { MissionRunPolicy } from '../../src/mission-service.ts'
import { parseMissionMarkdown } from '../../src/mission-state.ts'
import type { MissionSnapshot } from '../../src/mission-state.ts'
import { DurableMissionStore } from '../../src/mission-store.ts'
import type { AutonomyLeaseView } from '../../src/service.ts'
import {
  createServiceHarness,
  createTestAgent,
  TestSubagentProvider,
} from '../helpers.ts'

const review = [
  { role: 'metis' as const, verdict: 'advice' as const, summary: 'clear', findings: [], recommendations: [] },
  { role: 'momus' as const, verdict: 'advice' as const, summary: 'executable', findings: [], recommendations: [] },
  { role: 'oracle' as const, verdict: 'advice' as const, summary: 'sound', findings: [], recommendations: [] },
]

async function harness(config = {}, prepareInterview = true) {
  const base = await createServiceHarness({ autonomy: { maxSubagents: 16, maxEvidenceItems: 16 } })
  await base.ctx.plugin(SystemPrompt)
  await base.ctx.plugin(ToolRuntime)
  await base.ctx.plugin(SubagentRuntime)
  const provider = new TestSubagentProvider()
  base.ctx.effect(() => base.ctx.subagents.registerProvider(provider), 'mission.testProvider')
  const missionFiber = await base.ctx.plugin(MissionService, config)
  const goal = base.ctx.goals.create(base.agent, { objective: 'run the release mission' })
  await base.ctx.autonomy.start(base.agent, { goalId: goal.id })
  if (prepareInterview) {
    await base.ctx.autonomy.recordInterview(base.agent, {
      summary: 'The release queue and repository constraints are understood.',
      decisions: ['Run every prompt in source order.'],
      openQuestions: [],
    })
  }
  const policy = (): MissionRunPolicy => ({
    routes: [],
    routingPreference: 'declared',
    toolAllowlist: ['bash'],
    startSubagent: base.ctx.subagents.start.bind(base.ctx.subagents),
    signal: new AbortController().signal,
  })
  return { ...base, provider, missionFiber, goal, policy }
}

function durableStore(base: Awaited<ReturnType<typeof harness>>): DurableMissionStore {
  return (base.ctx.autopilotMissions as unknown as { readonly store: DurableMissionStore }).store
}

function request(continueOnError?: boolean) {
  return {
    source: { path: '/repo/release.md', sha256: 'a'.repeat(64), bytes: 120 },
    tasks: parseMissionMarkdown('- [ ] Audit\n- [ ] Fix\n- [ ] Verify', {
      maxTasks: 8, maxPromptChars: 100, maxTotalPromptChars: 300,
    }),
    ...(continueOnError === undefined ? {} : { continueOnError }),
  }
}

async function planAndHarden(base: Awaited<ReturnType<typeof harness>>, continueOnError = false) {
  const mission = await base.ctx.autopilotMissions.plan(base.agent, request(continueOnError))
  const reviewing = await base.ctx.autonomy.beginPlanReview(base.agent)
  await base.ctx.autonomy.settlePlanReview(base.agent, reviewing.plan!.revision, review)
  return mission
}

describe('mission service', () => {
  it('plans a durable dry run and executes every prompt sequentially with DAG evidence', async () => {
    const base = await harness()
    const planned = await planAndHarden(base)
    expect(planned).toMatchObject({ phase: 'planned', continueOnError: false })
    expect(base.ctx.autonomy.get(base.agent)?.plan?.tasks).toMatchObject([
      { id: planned.dagTaskId, status: 'pending' },
    ])

    const completed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy())
    expect(completed.phase).toBe('passed')
    expect(completed.tasks.map(task => task.status)).toEqual(['passed', 'passed', 'passed'])
    expect(base.provider.requests.map(item => item.label)).toEqual([
      `autopilot-mission-${planned.missionId}-task-001`,
      `autopilot-mission-${planned.missionId}-task-002`,
      `autopilot-mission-${planned.missionId}-task-003`,
    ])
    expect(base.ctx.autonomy.get(base.agent)).toMatchObject({
      subagentsStarted: 3,
      plan: { tasks: [{ status: 'completed' }] },
    })
    expect(base.ctx.autopilotMissions.status(base.agent, planned.missionId)?.revision).toBe(completed.revision)
    expect(base.ctx.autopilotMissions.listRun(String(base.agent.id), completed.runId, completed.generation))
      .toHaveLength(1)
    expect(base.ctx.autopilotMissions.history(String(base.agent.id)).length).toBeGreaterThan(6)
  })

  it('stops on first failure, skips later prompts, then resumes every retryable task', async () => {
    const base = await harness()
    const planned = await planAndHarden(base)
    base.provider.outcomes.push({
      output: [], stopReason: 'completed',
      structured: { status: 'failed', summary: 'first attempt failed', evidence: [] },
    })
    const failed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy())
    expect(failed.phase).toBe('failed')
    expect(failed.tasks.map(task => task.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(base.ctx.autonomy.get(base.agent)?.plan?.tasks[0]?.status).toBe('failed')

    const passed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy())
    expect(passed.phase).toBe('passed')
    expect(passed.tasks.map(task => task.attempts.length)).toEqual([2, 1, 1])
    expect(base.ctx.autonomy.get(base.agent)?.plan?.tasks[0]?.status).toBe('completed')
  })

  it('continues after failure when configured and preserves operator blockers', async () => {
    const base = await harness()
    const planned = await planAndHarden(base, true)
    base.provider.outcomes.push({
      output: [], stopReason: 'completed',
      structured: { status: 'failed', summary: 'audit failed', evidence: [] },
    })
    const failed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy())
    expect(failed.tasks.map(task => task.status)).toEqual(['failed', 'passed', 'passed'])
    const marked = await base.ctx.autopilotMissions.mark(base.agent, {
      missionId: planned.missionId,
      taskId: 'task-002',
      status: 'needs-human-review',
      reason: 'release owner must approve',
    })
    expect(marked.phase).toBe('needs-human-review')
    expect(marked.tasks[1]).toMatchObject({ status: 'needs-human-review', reason: 'release owner must approve' })
    await expect(base.ctx.autopilotMissions.mark(base.agent, {
      missionId: planned.missionId,
      taskId: 'missing', status: 'blocked', reason: 'no',
    })).rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_MISSING' })
  })

  it('reruns a passed or operator-blocked task and restores a passing summary', async () => {
    const base = await harness()
    const planned = await planAndHarden(base)
    await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy())
    await base.ctx.autopilotMissions.mark(base.agent, {
      missionId: planned.missionId,
      taskId: 'task-002', status: 'blocked', reason: 'manual hold',
    })
    const rerun = await base.ctx.autopilotMissions.rerun(
      base.agent, planned.missionId, 'task-002', base.policy(),
    )
    expect(rerun.phase).toBe('passed')
    expect(rerun.tasks[1]).toMatchObject({ status: 'passed' })
    expect(rerun.tasks[1]?.attempts).toHaveLength(2)
    expect(base.ctx.autonomy.get(base.agent)?.plan?.tasks[0]?.status).toBe('completed')
  })

  it('fails loud on invalid config, stale authority, duplicate planning, and invalid worker output', async () => {
    expect(() => new MissionService(new Context(), { maxTasks: 0 })).toThrow(/positive safe integer/u)
    expect(() => new MissionService(new Context(), { maxPromptChars: 10, maxTotalPromptChars: 5 }))
      .toThrow(/must not exceed/u)
    expect(() => new MissionService(new Context(), { role: '' })).toThrow(MissionServiceError)

    const base = await harness()
    const planned = await base.ctx.autopilotMissions.plan(base.agent, request())
    expect(await base.ctx.autopilotMissions.plan(base.agent, request())).toBe(planned)
    await expect(base.ctx.autopilotMissions.plan(base.agent, {
      ...request(), source: { ...request().source, sha256: 'b'.repeat(64) },
    })).rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })
    await base.ctx.autonomy.beginPlanReview(base.agent)
    const reviewing = base.ctx.autonomy.get(base.agent)!
    await base.ctx.autonomy.settlePlanReview(base.agent, reviewing.plan!.revision, review)
    base.provider.outcomes.push({ output: [], stopReason: 'completed', structured: { nope: true } })
    const failed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy())
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('invalid') })
    const goal = base.ctx.goals.get(base.agent)!
    base.ctx.goals.disarm(base.agent)
    await expect(base.ctx.autopilotMissions.resume(base.agent, planned.missionId, base.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })
    expect(goal.id).toBe(planned.goalId)
  })

  it('records blocked/cleanup-failed workers and rejects inherited-context providers', async () => {
    const base = await harness()
    const planned = await planAndHarden(base)
    const blockedRun = {
      id: 'blocked-child' as never,
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'refusal' as const }),
      dispose: vi.fn(async () => { throw new Error('dispose failed') }),
    }
    const failed = await base.ctx.autopilotMissions.rerun(base.agent, planned.missionId, 'task-001', {
      ...base.policy(),
      startSubagent: vi.fn(async () => blockedRun),
    })
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('cleanup failed') })

    vi.spyOn(base.ctx.subagents, 'getProvider').mockReturnValue({ inheritsParentContext: true } as never)
    await expect(base.ctx.autopilotMissions.rerun(base.agent, planned.missionId, 'task-002', base.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_INVALID' })
  })

  it('fails closed across planning gates, cross-store persistence failure, and unavailable storage', async () => {
    expect(new MissionService(new Context()).limits).toMatchObject({ role: 'executor' })
    const preInterview = await harness({}, false)
    await expect(preInterview.ctx.autopilotMissions.plan(preInterview.agent, request()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })
    expect(preInterview.ctx.autopilotMissions.status(createTestAgent('mission-without-run'), 'missing')).toBeUndefined()

    const occupied = await harness()
    await occupied.ctx.autonomy.setPlan(occupied.agent, ['existing plan'], [{
      id: 'existing', title: 'Existing', description: 'Existing work', acceptanceCriteria: ['done'], dependencies: [],
    }])
    await expect(occupied.ctx.autopilotMissions.plan(occupied.agent, request()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })

    const failed = await harness()
    vi.spyOn(DurableMissionStore.prototype, 'append').mockRejectedValueOnce(new Error('mission backend unavailable'))
    await expect(failed.ctx.autopilotMissions.plan(failed.agent, request())).rejects.toThrow(/backend unavailable/u)
    expect(failed.ctx.autonomy.get(failed.agent)).toMatchObject({ phase: 'needs-attention', activation: 'disarmed' })
    expect(failed.ctx.goals.get(failed.agent)?.activation).toBe('disarmed')

    const service = failed.ctx.autopilotMissions
    await failed.missionFiber.dispose()
    expect(() => service.history(String(failed.agent.id))).toThrow(/store is unavailable/u)

    const disarmed = await harness()
    vi.spyOn(DurableMissionStore.prototype, 'append').mockImplementationOnce(async () => {
      disarmed.ctx.goals.disarm(disarmed.agent)
      throw new Error('failed after Goal disarm')
    })
    await expect(disarmed.ctx.autopilotMissions.plan(disarmed.agent, request())).rejects.toThrow(/Goal disarm/u)
    expect(disarmed.ctx.autonomy.get(disarmed.agent)?.phase).toBe('needs-attention')

    const replaced = await harness()
    ;(replaced.ctx.autopilotMissions as unknown as { store: DurableMissionStore | undefined }).store = undefined
    await replaced.missionFiber.dispose()
  })

  it('rejects every untrusted plan-input limit before creating a DAG', async () => {
    const base = await harness({ maxTasks: 2, maxPromptChars: 4, maxTotalPromptChars: 6, maxSourceBytes: 10 })
    const valid = {
      source: { path: '/r/m.md', sha256: 'a'.repeat(64), bytes: 2 },
      tasks: [{ id: 'task-001', prompt: 'okay' }],
      continueOnError: false,
    }
    const invalid = [
      { ...valid, source: { ...valid.source, bytes: 0 } },
      { ...valid, source: { ...valid.source, bytes: 11 } },
      { ...valid, source: { ...valid.source, sha256: 'bad' } },
      { ...valid, source: { ...valid.source, path: '' } },
      { ...valid, tasks: [] },
      { ...valid, tasks: [valid.tasks[0]!, { id: 'task-002', prompt: 'two' }, { id: 'task-003', prompt: 'tri' }] },
      { ...valid, tasks: [{ id: 'wrong', prompt: 'okay' }] },
      { ...valid, tasks: [{ id: 'task-001', prompt: '' }] },
      { ...valid, tasks: [{ id: 'task-001', prompt: 'large' }] },
      { ...valid, tasks: [{ id: 'task-001', prompt: 'four' }, { id: 'task-002', prompt: 'four' }] },
    ]
    for (const input of invalid) {
      await expect(base.ctx.autopilotMissions.plan(base.agent, input)).rejects.toMatchObject({
        code: 'AUTOPILOT_MISSION_INVALID',
      })
    }
    expect(base.ctx.autonomy.get(base.agent)?.plan).toBeUndefined()
  })

  it('enforces attention, execution, task, and Goal identity gates', async () => {
    const beforeReview = await harness()
    const planned = await beforeReview.ctx.autopilotMissions.plan(beforeReview.agent, request())
    await expect(beforeReview.ctx.autopilotMissions.resume(beforeReview.agent, planned.missionId, beforeReview.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })
    await expect(beforeReview.ctx.autopilotMissions.resume(beforeReview.agent, 'missing-12345678', beforeReview.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })

    const base = await harness()
    const current = await planAndHarden(base)
    await expect(base.ctx.autopilotMissions.resume(base.agent, 'missing-12345678', base.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_MISSING' })
    await expect(base.ctx.autopilotMissions.rerun(base.agent, current.missionId, 'missing', base.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_MISSING' })
    const attention = await durableStore(base).append('attention', {
      ...current,
      revision: current.revision + 1,
      phase: 'needs-attention',
      reason: 'operator reconciliation required',
      updatedAt: current.updatedAt + 1,
    })
    await expect(base.ctx.autopilotMissions.resume(base.agent, attention.missionId, base.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_UNCERTAIN' })
    await expect(base.ctx.autopilotMissions.rerun(base.agent, attention.missionId, 'task-001', base.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_UNCERTAIN' })

    const otherGoal = { ...base.ctx.autonomy.get(base.agent)!, goalId: 'other-goal' as never }
    expect(() => (base.ctx.autopilotMissions as unknown as {
      requireMission(parent: typeof base.agent, lease: typeof otherGoal, missionId: string): MissionSnapshot
    }).requireMission(base.agent, otherGoal, attention.missionId)).toThrow(/different Goal/u)
  })

  it('handles cancellation, reservation drift, running marks, and missing envelopes', async () => {
    const cancelled = await harness()
    const planned = await planAndHarden(cancelled)
    const abort = new AbortController()
    abort.abort()
    const untouched = await cancelled.ctx.autopilotMissions.resume(cancelled.agent, planned.missionId, {
      ...cancelled.policy(), signal: abort.signal,
    })
    expect(untouched.phase).toBe('planned')
    expect(cancelled.provider.requests).toHaveLength(0)

    const running = await harness()
    const runningPlan = await planAndHarden(running)
    const runningSnapshot = await durableStore(running).append('task-start', {
      ...runningPlan,
      revision: runningPlan.revision + 1,
      phase: 'running',
      tasks: runningPlan.tasks.map((task, index) => index === 0
        ? { ...task, status: 'running' as const, updatedAt: runningPlan.updatedAt + 1 }
        : task),
      updatedAt: runningPlan.updatedAt + 1,
    })
    await expect(running.ctx.autopilotMissions.mark(running.agent, {
      missionId: runningSnapshot.missionId, taskId: 'task-001', status: 'blocked', reason: 'hold',
    })).rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_CONFLICT' })
    expect(await running.ctx.autopilotMissions.resume(running.agent, runningSnapshot.missionId, running.policy()))
      .toMatchObject({ phase: 'passed' })

    const missingEnvelope = await harness()
    const missingPlan = await planAndHarden(missingEnvelope)
    const lease = missingEnvelope.ctx.autonomy.get(missingEnvelope.agent)!
    const { plan: _plan, ...leaseWithoutPlan } = lease
    await expect((missingEnvelope.ctx.autopilotMissions as unknown as {
      prepareEnvelope(parent: typeof missingEnvelope.agent, lease: AutonomyLeaseView, snapshot: MissionSnapshot): Promise<MissionSnapshot>
    }).prepareEnvelope(missingEnvelope.agent, leaseWithoutPlan, missingPlan))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_UNCERTAIN' })

    const drift = await harness()
    const driftPlan = await planAndHarden(drift)
    const original = drift.ctx.autonomy.recordSubagentStarts.bind(drift.ctx.autonomy)
    vi.spyOn(drift.ctx.autonomy, 'recordSubagentStarts').mockImplementationOnce(async (agent, count) => ({
      ...await original(agent, count), generation: driftPlan.generation + 1,
    }))
    await expect(drift.ctx.autopilotMissions.resume(drift.agent, driftPlan.missionId, drift.policy()))
      .rejects.toMatchObject({ code: 'AUTOPILOT_MISSION_UNCERTAIN' })
  })

  it('settles blocked and last-task failures without inventing later work', async () => {
    const blocked = await harness()
    const blockedPlan = await planAndHarden(blocked)
    blocked.provider.outcomes.push({ output: [], stopReason: 'refusal' })
    expect(await blocked.ctx.autopilotMissions.resume(blocked.agent, blockedPlan.missionId, blocked.policy()))
      .toMatchObject({ phase: 'blocked', tasks: [{ status: 'blocked' }, { status: 'skipped' }, { status: 'skipped' }] })
    expect(blocked.ctx.autonomy.get(blocked.agent)?.plan?.tasks[0]).toMatchObject({ status: 'blocked' })

    const last = await harness()
    const lastPlan = await planAndHarden(last)
    last.provider.outcomes.push(
      { output: [], stopReason: 'completed', structured: {
        status: 'completed', summary: 'first', evidence: [{ kind: 'test', ref: 'one', summary: 'passed' }],
      } },
      { output: [], stopReason: 'completed', structured: {
        status: 'completed', summary: 'second', evidence: [{ kind: 'test', ref: 'two', summary: 'passed' }],
      } },
      { output: [], stopReason: 'max-tokens' },
    )
    const failed = await last.ctx.autopilotMissions.resume(last.agent, lastPlan.missionId, last.policy())
    expect(failed.tasks.map(task => task.status)).toEqual(['passed', 'passed', 'failed'])
  })

  it('applies economy routing and normalizes worker failures without fallback shopping', async () => {
    const base = await harness({ role: 'executor', persona: ' default mission persona ' })
    const planned = await planAndHarden(base, true)
    const unrenderable = { [Symbol.toPrimitive]() { throw new Error('cannot render') } }
    const controller = new AbortController()
    const starts = vi.fn(base.ctx.subagents.start.bind(base.ctx.subagents))
    base.ctx.tools.register(defineTool({
      name: 'bash', description: 'fixture bash', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute: async () => null,
    }))
    base.ctx.tools.register(defineTool({
      name: 'secret', description: 'fixture secret', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute: async () => null,
    }))
    base.provider.outcomes.push(
      { startError: unrenderable },
      { output: [], stopReason: 'completed', structured: [] },
      { output: [], stopReason: 'completed', structured: {
        status: 'completed', summary: 'bad evidence', evidence: ['bad'],
      } },
    )
    const failed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, {
      routes: [{
        role: 'executor', subagentProvider: 'missing', provider: 'costly', model: 'large', costWeight: 10,
        fallbacks: [
          { subagentProvider: 'spawn', provider: 'cheap', model: 'small', persona: 'cheap worker', costWeight: 1 },
          { subagentProvider: 'spawn' },
          { subagentProvider: 'spawn' },
        ],
      }],
      routingPreference: 'economy',
      toolAllowlist: [],
      startSubagent: starts,
      signal: controller.signal,
    })
    expect(failed.phase).toBe('failed')
    expect(failed.tasks.map(task => task.reason)).toEqual([
      expect.stringContaining('<unrenderable thrown value>'),
      expect.stringContaining('invalid'),
      expect.stringContaining('invalid'),
    ])
    expect(starts.mock.calls.every(call => call[0] === 'spawn')).toBe(true)
    expect(base.provider.requests[0]).toMatchObject({
      persona: 'cheap worker', agentOptions: { provider: 'cheap', model: 'small' },
      toolFilter: { allow: ['bash'] },
    })
  })

  it('contains aborted starts, malformed evidence fields, and declared partial model routes', async () => {
    const base = await harness({ persona: 'explicit default' })
    const planned = await planAndHarden(base, true)
    const controller = new AbortController()
    const start = vi.fn(async () => {
      controller.abort()
      throw new Error('cancelled during start')
    })
    const aborted = await base.ctx.autopilotMissions.rerun(base.agent, planned.missionId, 'task-001', {
      routes: [{ role: 'executor', subagentProvider: 'spawn', provider: 'only-provider' }],
      routingPreference: 'declared', toolAllowlist: ['bash'], startSubagent: start, signal: controller.signal,
    })
    expect(aborted.tasks[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('cancelled') })

    base.provider.outcomes.push(
      { output: [], stopReason: 'completed', structured: {
        status: 'completed', summary: 'bad kind', evidence: [{ kind: 'invalid', ref: 'x', summary: 'x' }],
      } },
      { output: [], stopReason: 'completed', structured: {
        status: 'completed', summary: 'bad ref', evidence: [{ kind: 'test', ref: '', summary: 'x' }],
      } },
      { output: [], stopReason: 'completed', structured: {
        status: 'completed', summary: 'bad summary', evidence: [{ kind: 'test', ref: 'x', summary: '' }],
      } },
    )
    const malformed = await base.ctx.autopilotMissions.resume(base.agent, planned.missionId, {
      routes: [{ role: 'executor', subagentProvider: 'spawn', model: 'only-model' }],
      routingPreference: 'declared', toolAllowlist: ['bash'],
      startSubagent: base.ctx.subagents.start.bind(base.ctx.subagents), signal: new AbortController().signal,
    })
    expect(malformed.tasks.map(task => task.status)).toEqual(['blocked', 'failed', 'failed'])
  })
})
