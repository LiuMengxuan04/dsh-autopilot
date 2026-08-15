import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedSubagentStart } from '../../src/managed-subagents.ts'
import { RALPH_STATE_VERSION } from '../../src/ralph-state.ts'
import type { RalphSnapshot } from '../../src/ralph-state.ts'
import * as ralphTool from '../../src/tool-ralph.ts'
import { createTestAgent } from '../helpers.ts'

let callSequence = 0

function snapshot(overrides: Partial<RalphSnapshot> = {}): RalphSnapshot {
  return {
    version: RALPH_STATE_VERSION,
    parentSessionId: 'parent',
    runId: 'run',
    generation: 1,
    goalId: 'goal',
    taskId: 'leaf',
    revision: 5,
    phase: 'completed',
    instruction: 'finish',
    policySha256: 'a'.repeat(64),
    maxRounds: 3,
    maxHandoffChars: 100,
    maxSummaryChars: 100,
    maxEvidenceItems: 4,
    reservedThroughRound: 1,
    rounds: [{
      number: 1,
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
      childSessionId: 'child',
      summary: 'done',
      handoff: 'final note',
      evidence: [{ kind: 'test', ref: 'test', summary: 'passed' }],
    }],
    handoff: 'final note',
    createdAt: 1,
    updatedAt: 2,
    reason: 'done',
    ...overrides,
  }
}

function execute(ctx: Context, name: string, args: unknown, agent?: Agent) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`ralph-tool-${callSequence}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

describe('Ralph fixed tool surface', () => {
  it('registers only fixed start, resume, status, and cancel controls with managed provenance', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const row = snapshot()
    const service = {
      start: vi.fn(async () => row),
      resume: vi.fn(async () => row),
      status: vi.fn((): RalphSnapshot | undefined => row),
      cancel: vi.fn(async () => row),
    }
    Object.defineProperty(ctx, 'autopilotRalph', { configurable: true, value: service })
    const managed = vi.fn() as unknown as ManagedSubagentStart
    ralphTool.apply(ctx, { startSubagent: managed })
    const agent = createTestAgent('ralph-tool-parent')

    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'autopilot_ralph_cancel',
      'autopilot_ralph_resume',
      'autopilot_ralph_start',
      'autopilot_ralph_status',
    ])
    expect(await execute(ctx, 'autopilot_ralph_start', {
      taskId: 'leaf', instruction: 'finish', maxRounds: 2,
    }, agent)).toMatchObject({ isError: false, value: { phase: 'completed', roundsStarted: 1 } })
    expect(service.start).toHaveBeenCalledWith(agent, expect.objectContaining({
      taskId: 'leaf', instruction: 'finish', maxRounds: 2, startSubagent: managed,
    }))
    expect(await execute(ctx, 'autopilot_ralph_resume', { taskId: 'leaf', maxRounds: 2 }, agent))
      .toMatchObject({ isError: false })
    expect(await execute(ctx, 'autopilot_ralph_start', {
      taskId: 'leaf', instruction: 'use default ceiling',
    }, agent)).toMatchObject({ isError: false })
    expect(await execute(ctx, 'autopilot_ralph_resume', { taskId: 'leaf' }, agent))
      .toMatchObject({ isError: false })
    expect(await execute(ctx, 'autopilot_ralph_status', { taskId: 'leaf' }, agent))
      .toMatchObject({ isError: false, value: { rounds: [{ childSessionId: 'child', handoff: 'final note' }] } })
    expect(await execute(ctx, 'autopilot_ralph_cancel', {
      taskId: 'leaf', reason: 'stop leaf',
    }, agent)).toMatchObject({ isError: false })
    expect(service.cancel).toHaveBeenCalledWith(agent, 'leaf', 'stop leaf')

    service.status.mockReturnValueOnce(undefined)
    expect(await execute(ctx, 'autopilot_ralph_status', { taskId: 'missing' }, agent))
      .toMatchObject({ value: { status: 'missing', taskId: 'missing' } })
    expect((await execute(ctx, 'autopilot_ralph_status', { taskId: 'leaf' })).isError).toBe(true)
    expect(ralphTool.ralphJson(snapshot({
      handoff: undefined,
      reason: undefined,
      rounds: [{ number: 1, status: 'starting', startedAt: 1, evidence: [] }],
    }))).toMatchObject({ rounds: [{ number: 1, status: 'starting' }] })
    await ctx.fiber.dispose()
  })
})
