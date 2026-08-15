import { describe, expect, it } from 'vitest'
import {
  applyManagedWorkflowTask,
  claimManagedWorkflow,
  failManagedWorkflow,
  finishManagedWorkflow,
  finishManagedWorkflowCancel,
  isManagedWorkflowTerminal,
  managedWorkflowAuditRecordSchema,
  managedWorkflowIdentity,
  managedWorkflowRunIdentity,
  managedWorkflowSnapshotSchema,
  managedWorkflowTaskOutcomeSchema,
  ManagedWorkflowStateError,
  markManagedWorkflowUncertain,
  prepareManagedWorkflow,
  requestManagedWorkflowCancel,
  settleManagedWorkflow,
  startManagedWorkflow,
  WORKFLOW_STATE_VERSION,
} from '../../src/workflow-state.ts'
import type {
  ManagedWorkflowSnapshot,
  ManagedWorkflowTaskOutcome,
} from '../../src/workflow-state.ts'

const completed: ManagedWorkflowTaskOutcome = {
  taskId: 'build',
  status: 'completed',
  summary: 'built',
  evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
}

function prepared(overrides: Partial<ManagedWorkflowSnapshot> = {}): ManagedWorkflowSnapshot {
  return prepareManagedWorkflow({
    workflowId: '3bbcee75-cecc-4e9f-a431-2ad84fd7d964',
    parentSessionId: 'parent',
    runId: 'run-1',
    generation: 2,
    goalId: 'goal-1',
    maxAuditRecords: 100,
    maxAuditBytes: 1_000_000,
    profileId: 'fanout',
    profileSha256: 'a'.repeat(64),
    argsSha256: 'b'.repeat(64),
    taskIds: ['build'],
    maxTotalAgents: 2,
    subagentsStartedBefore: 3,
    ...overrides,
  }, 100)
}

function running(): ManagedWorkflowSnapshot {
  return startManagedWorkflow(claimManagedWorkflow(prepared(), 9, 110), 'engine-1', 120)
}

describe('managed workflow state', () => {
  it('records intent, claim, run, task settlement, and clean completion', () => {
    const first = prepared()
    expect(first).toMatchObject({ version: 1, revision: 1, phase: 'prepared', outcomes: [] })
    expect(Object.isFrozen(first.taskIds)).toBe(true)
    expect(managedWorkflowIdentity(first)).toBe(first.workflowId)
    expect(managedWorkflowRunIdentity(first)).toBe('parent\u0000run-1\u00002')
    expect(isManagedWorkflowTerminal(first.phase)).toBe(false)

    const claimed = claimManagedWorkflow(first, 9, 110)
    const active = startManagedWorkflow(claimed, ' engine-1 ', 120)
    const settling = settleManagedWorkflow(active, {
      stopReason: 'completed',
      agentsStarted: 1,
      targetPhase: 'completed',
      outcomes: [completed],
    }, 130)
    expect(settling).toMatchObject({
      phase: 'settling', engineRunId: 'engine-1', engineAgentsStarted: 1,
      outcomes: [{ taskId: 'build', status: 'completed' }],
    })
    expect(Object.isFrozen(settling.outcomes[0]?.evidence)).toBe(true)
    const applied = applyManagedWorkflowTask(settling, 'build', 140)
    const finished = finishManagedWorkflow(applied, 150)
    expect(finished).toMatchObject({ phase: 'completed', settledTaskIds: ['build'] })
    expect(isManagedWorkflowTerminal(finished.phase)).toBe(true)
    expect(managedWorkflowAuditRecordSchema.parse({
      version: WORKFLOW_STATE_VERSION,
      operation: 'finish',
      time: finished.updatedAt,
      snapshot: finished,
    }).snapshot).toEqual(finished)
  })

  it('records partial failure, cancellation, pre-start failure, and uncertainty', () => {
    const partial = settleManagedWorkflow(running(), {
      stopReason: 'completed',
      agentsStarted: 1,
      targetPhase: 'partial-failure',
      outcomes: [{ taskId: 'build', status: 'failed', summary: 'failed', evidence: [] }],
      reason: 'one task failed',
    }, 130)
    expect(finishManagedWorkflow(applyManagedWorkflowTask(partial, 'build', 140), 150))
      .toMatchObject({ phase: 'partial-failure', reason: 'one task failed' })

    const cancelling = requestManagedWorkflowCancel(running(), ' operator paused ', 130)
    expect(cancelling).toMatchObject({ phase: 'cancelling', reason: 'operator paused' })
    expect(requestManagedWorkflowCancel(cancelling, 'again', 140)).toBe(cancelling)
    expect(finishManagedWorkflowCancel(cancelling, 'cancelled', 150))
      .toMatchObject({ phase: 'cancelled', reason: 'cancelled' })

    expect(failManagedWorkflow(prepared(), ' engine unavailable ', 110))
      .toMatchObject({ phase: 'error', reason: 'engine unavailable' })
    const uncertain = markManagedWorkflowUncertain(running(), ' process restarted ', 130)
    expect(uncertain).toMatchObject({ phase: 'uncertain', reason: 'process restarted' })
    expect(markManagedWorkflowUncertain(uncertain, 'again', 140)).toBe(uncertain)

    const errorSettlement = settleManagedWorkflow(running(), {
      stopReason: 'error',
      agentsStarted: 0,
      targetPhase: 'error',
      outcomes: [{ taskId: 'build', status: 'failed', summary: 'bad output', evidence: [] }],
      reason: 'bad output',
    }, 130)
    expect(finishManagedWorkflow(applyManagedWorkflowTask(errorSettlement, 'build', 140), 150))
      .toMatchObject({ phase: 'error', reason: 'bad output' })
  })

  it('rejects invalid local transitions and bounded text', () => {
    const first = prepared()
    const active = running()
    const settling = settleManagedWorkflow(active, {
      stopReason: 'completed', agentsStarted: 1, targetPhase: 'completed', outcomes: [completed],
    }, 130)
    expect(() => claimManagedWorkflow(active, 10, 140)).toThrow(ManagedWorkflowStateError)
    expect(() => startManagedWorkflow(first, 'engine', 110)).toThrow(/requires claimed/u)
    expect(() => startManagedWorkflow(claimManagedWorkflow(first, 9, 110), ' ', 120)).toThrow(/engine run id/u)
    expect(() => settleManagedWorkflow(first, {
      stopReason: 'completed', agentsStarted: 0, targetPhase: 'completed', outcomes: [completed],
    }, 120)).toThrow(/requires running/u)
    expect(() => applyManagedWorkflowTask(settling, 'other', 140)).toThrow(/no outcome/u)
    const applied = applyManagedWorkflowTask(settling, 'build', 140)
    expect(() => applyManagedWorkflowTask(applied, 'build', 150)).toThrow(/already settled/u)
    expect(() => finishManagedWorkflow(settling, 140)).toThrow(/before every/u)
    expect(() => requestManagedWorkflowCancel(
      finishManagedWorkflow(applied, 150), 'x', 160,
    )).toThrow(/terminal workflow/u)
    expect(() => finishManagedWorkflowCancel(
      finishManagedWorkflow(applied, 150), 'x', 160,
    )).toThrow(/requires prepared/u)
    expect(() => failManagedWorkflow(
      finishManagedWorkflow(applied, 150), 'x', 160,
    )).toThrow(/terminal workflow/u)
    expect(() => requestManagedWorkflowCancel(active, ' ', 130)).toThrow(/cancellation reason/u)
    expect(() => markManagedWorkflowUncertain(active, 'x'.repeat(8_193), 130)).toThrow(/uncertainty reason/u)
  })

  it('rejects malformed snapshots and result outcomes', () => {
    const first = prepared()
    const active = running()
    const settling = settleManagedWorkflow(active, {
      stopReason: 'completed', agentsStarted: 1, targetPhase: 'completed', outcomes: [completed],
    }, 130)
    const finished = finishManagedWorkflow(applyManagedWorkflowTask(settling, 'build', 140), 150)
    const malformed = [
      { ...first, taskIds: ['build', 'build'] },
      { ...first, taskIds: ['build', 'test', 'docs'], maxTotalAgents: 2 },
      { ...first, updatedAt: 99 },
      { ...first, claimedRunRevision: 2 },
      { ...claimManagedWorkflow(first, 2, 110), claimedRunRevision: undefined },
      { ...active, engineRunId: undefined },
      { ...active, engineStopReason: 'completed' },
      { ...active, phase: 'error', reason: undefined },
      { ...active, phase: 'running', reason: 'not allowed' },
      { ...active, outcomes: [{ ...completed, taskId: 'other' }] },
      { ...active, outcomes: [completed, completed] },
      { ...active, outcomes: [completed], settledTaskIds: ['other'] },
      { ...settling, engineAgentsStarted: undefined },
      { ...finished, settledTaskIds: [] },
    ]
    for (const snapshot of malformed) expect(() => managedWorkflowSnapshotSchema.parse(snapshot)).toThrow()

    expect(() => managedWorkflowTaskOutcomeSchema.parse({ ...completed, evidence: [] }))
      .toThrow(/require evidence/u)
    expect(() => managedWorkflowTaskOutcomeSchema.parse({ ...completed, status: 'failed', evidence: [] }))
      .not.toThrow()
  })
})
