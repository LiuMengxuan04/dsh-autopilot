import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type ContinuableTeamService from '../../src/team-service.ts'
import type { ManagedContinuableStart } from '../../src/team-service.ts'
import type { TeamOrphanRecord, TeamThreadSnapshot } from '../../src/team-state.ts'
import * as teamTools from '../../src/tool-team.ts'
import { createTestAgent } from '../helpers.ts'

let callSequence = 0

function thread(overrides: Partial<TeamThreadSnapshot> = {}): TeamThreadSnapshot {
  return {
    version: 1,
    parentSessionId: 'parent',
    runId: 'run-1',
    generation: 2,
    runRevisionAtClaim: 3,
    maxAuditRecords: 8192,
    maxAuditBytes: 256 * 1024 * 1024,
    taskId: 'build',
    revision: 4,
    provider: 'spawn',
    label: 'dsh-autopilot-team:cnVuLTE:2:build',
    role: 'implementer',
    promptSha256: 'a'.repeat(64),
    phase: 'active',
    childSessionId: 'child',
    messages: [{
      sequence: 1,
      kind: 'initial',
      messageId: 'initial-message',
      contentSha256: 'a'.repeat(64),
      acceptedAt: 10,
    }],
    createdAt: 9,
    updatedAt: 10,
    ...overrides,
  }
}

function acceptedReportThread(): TeamThreadSnapshot {
  return thread({
    phase: 'settled',
    revision: 6,
    messages: [
      ...thread().messages,
      {
        sequence: 2,
        kind: 'report',
        messageId: 'report-message',
        contentSha256: 'b'.repeat(64),
        acceptedAt: 12,
      },
    ],
    report: {
      status: 'completed',
      summary: 'implemented',
      evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
      submittedAt: 11,
      messageId: 'report-message',
      acceptedAt: 12,
    },
    reason: 'prior interrupt',
    lastError: 'prior retry',
    updatedAt: 13,
  })
}

function orphan(overrides: Partial<TeamOrphanRecord> = {}): TeamOrphanRecord {
  return {
    version: 1,
    parentSessionId: 'parent',
    runId: 'run-1',
    generation: 2,
    childSessionId: 'orphan',
    observedAt: 20,
    reason: 'unattributed child',
    ...overrides,
  }
}

function executeTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
) {
  callSequence += 1
  return ctx.tools.execute({
    callId: CallId(`team-tool-${callSequence}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

function fakeTeam() {
  const base = thread()
  const reported = acceptedReportThread()
  return {
    start: vi.fn(async () => base),
    followup: vi.fn(async () => thread({
      pendingMessage: { kind: 'followup', contentSha256: 'c'.repeat(64), preparedAt: 14 },
    })),
    interrupt: vi.fn(async () => thread({ phase: 'interrupted', reason: 'paused', lastError: 'retry later' })),
    report: vi.fn(async () => reported),
    list: vi.fn(() => [base, reported]),
    orphans: vi.fn(() => [orphan(), orphan({
      childSessionId: 'rich-orphan',
      label: 'foreign',
      initialMessageId: 'unbound-message',
      parentId: 'parent',
      depth: 1,
    })]),
    reconcile: vi.fn(async () => ({
      inspected: 2,
      resumedSettlements: 1,
      orphaned: 1,
      issues: Object.freeze(['unattributed child']),
    })),
  }
}

async function setupParentTools() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const team = fakeTeam()
  ctx.provide('autopilotTeam', team as unknown as ContinuableTeamService)
  let childInstaller: ((childCtx: Context) => () => void) | undefined
  const registerContinuableSetup = vi.fn((installer: (childCtx: Context) => () => void) => {
    childInstaller = installer
    return ctx.effect(() => () => { childInstaller = undefined }, 'team-tool.testSetup')
  })
  ctx.provide('subagents', { registerContinuableSetup } as unknown as Context['subagents'])
  const startContinuable = vi.fn<ManagedContinuableStart>()
  const fiber = await ctx.plugin(teamTools, { startContinuable })
  await vi.waitFor(() => expect(ctx.tools.schemas().map(schema => schema.name)).toContain('autopilot_team_start'))
  return {
    ctx,
    team,
    fiber,
    startContinuable,
    registerContinuableSetup,
    childInstaller: () => childInstaller,
  }
}

describe('continuable team tools', () => {
  it('maps every parent mailbox action and revokes all registrations with its plugin fiber', async () => {
    const harness = await setupParentTools()
    const agent = createTestAgent('parent')

    const started = await executeTool(harness.ctx, 'autopilot_team_start', {
      taskId: 'build', role: 'implementer', prompt: 'implement it',
    }, agent)
    expect(started).toMatchObject({
      isError: false,
      value: {
        runId: 'run-1', generation: 2, taskId: 'build', childSessionId: 'child',
        messages: [{ messageId: 'initial-message' }],
      },
      content: [{ type: 'text', text: expect.stringContaining('"runId": "run-1"') }],
    })
    expect(harness.team.start).toHaveBeenCalledWith(agent, expect.objectContaining({
      taskId: 'build',
      role: 'implementer',
      prompt: 'implement it',
      startContinuable: harness.startContinuable,
    }))
    harness.team.start.mockResolvedValueOnce(thread({
      phase: 'starting', childSessionId: undefined, messages: [],
    }))
    const preparing = await executeTool(harness.ctx, 'autopilot_team_start', {
      taskId: 'build', role: 'implementer', prompt: 'retry projection',
    }, agent)
    expect(preparing.value).not.toHaveProperty('childSessionId')

    const sent = await executeTool(harness.ctx, 'autopilot_team_send', {
      taskId: 'build', message: 'continue',
    }, agent)
    expect(sent).toMatchObject({ value: { pending: { kind: 'followup', preparedAt: 14 } } })
    expect(harness.team.followup).toHaveBeenCalledWith(agent, expect.objectContaining({
      taskId: 'build', message: 'continue',
    }))

    const interrupted = await executeTool(harness.ctx, 'autopilot_team_interrupt', {
      taskId: 'build', reason: 'pause it',
    }, agent)
    expect(interrupted).toMatchObject({ value: {
      phase: 'interrupted', reason: 'paused', lastError: 'retry later',
    } })
    expect(harness.team.interrupt).toHaveBeenCalledWith(agent, 'build', 'pause it')

    const listed = await executeTool(harness.ctx, 'autopilot_team_list', {}, agent)
    expect(listed).toMatchObject({ value: {
      threads: [
        { taskId: 'build' },
        { report: { messageId: 'report-message', evidence: [{ kind: 'test' }] } },
      ],
      orphans: [
        { childSessionId: 'orphan' },
        {
          childSessionId: 'rich-orphan', label: 'foreign', initialMessageId: 'unbound-message',
          parentId: 'parent', depth: 1,
        },
      ],
    } })

    const reconciled = await executeTool(harness.ctx, 'autopilot_team_reconcile', {}, agent)
    expect(reconciled.value).toEqual({
      inspected: 2,
      resumedSettlements: 1,
      orphaned: 1,
      issues: ['unattributed child'],
    })
    expect(harness.registerContinuableSetup).toHaveBeenCalledOnce()
    expect(harness.childInstaller()).toBeTypeOf('function')

    const subjectless = await executeTool(harness.ctx, 'autopilot_team_list', {})
    expect(subjectless.isError).toBe(true)
    if (subjectless.isError) expect(subjectless.error.message).toContain('Agent-backed')

    await harness.fiber.dispose()
    expect(harness.ctx.tools.schemas().map(schema => schema.name)).not.toContain('autopilot_team_start')
    await harness.ctx.fiber.dispose()
    expect(harness.childInstaller()).toBeUndefined()
  })

  it('installs the child-only report channel, projects exact receipt ids, and removes its guidance', async () => {
    const parent = await setupParentTools()
    const childCtx = new Context()
    await childCtx.plugin(SystemPrompt)
    await childCtx.plugin(ToolRuntime)
    const dispose = parent.childInstaller()!(childCtx)
    const child = createTestAgent('child')

    const assembly = await childCtx.systemPrompt.assemble()
    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: 'tool:autopilot-team-report',
      text: expect.stringContaining('autopilot_team_report exactly once'),
    }))
    const reported = await executeTool(childCtx, 'autopilot_team_report', {
      status: 'completed',
      summary: 'implemented',
      evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
    }, child)
    expect(reported.value).toEqual({
      taskId: 'build', phase: 'settled', reportMessageId: 'report-message',
    })
    expect(parent.team.report).toHaveBeenCalledWith(child, {
      status: 'completed',
      summary: 'implemented',
      evidence: [{ kind: 'test', ref: 'pnpm test', summary: 'passed' }],
    }, expect.any(AbortSignal))

    parent.team.report.mockResolvedValueOnce(thread())
    const withoutReceipt = await executeTool(childCtx, 'autopilot_team_report', {
      status: 'failed', summary: 'failed', evidence: [],
    }, child)
    expect(withoutReceipt.value).toEqual({ taskId: 'build', phase: 'active' })
    const subjectless = await executeTool(childCtx, 'autopilot_team_report', {
      status: 'failed', summary: 'failed', evidence: [],
    })
    expect(subjectless.isError).toBe(true)

    dispose()
    expect(childCtx.tools.schemas().map(schema => schema.name)).not.toContain('autopilot_team_report')
    expect((await childCtx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:autopilot-team-report')
    await childCtx.fiber.dispose()
    await parent.ctx.fiber.dispose()
  })

  it('rolls prompt registration back and aggregates setup and cleanup failures', () => {
    const toolFailure = new Error('tool registration failed')
    const promptFailure = new Error('prompt rollback failed')
    const rollbackCtx = {
      systemPrompt: { section: vi.fn(() => () => { throw promptFailure }) },
      tools: { register: vi.fn(() => { throw toolFailure }) },
    } as unknown as Context
    let setupFailure: unknown
    try {
      teamTools.installTeamReportTool(rollbackCtx, new Context())
    } catch (error: unknown) {
      setupFailure = error
    }
    expect(setupFailure).toBeInstanceOf(AggregateError)
    expect((setupFailure as AggregateError).errors).toEqual([toolFailure, promptFailure])

    const disposeToolFailure = new Error('tool cleanup failed')
    const disposePromptFailure = new Error('prompt cleanup failed')
    const cleanupCtx = {
      systemPrompt: { section: vi.fn(() => () => { throw disposePromptFailure }) },
      tools: { register: vi.fn(() => () => { throw disposeToolFailure }) },
    } as unknown as Context
    const dispose = teamTools.installTeamReportTool(cleanupCtx, new Context())
    expect(() => dispose()).toThrow(AggregateError)
    try {
      dispose()
    } catch (error: unknown) {
      expect((error as AggregateError).errors).toEqual([disposeToolFailure, disposePromptFailure])
    }
  })

  it('rethrows a tool setup failure after a successful prompt rollback', () => {
    const toolFailure = new Error('tool registration failed')
    const disposeSection = vi.fn()
    const rollbackCtx = {
      systemPrompt: { section: vi.fn(() => disposeSection) },
      tools: { register: vi.fn(() => { throw toolFailure }) },
    } as unknown as Context
    expect(() => teamTools.installTeamReportTool(rollbackCtx, new Context())).toThrow(toolFailure)
    expect(disposeSection).toHaveBeenCalledOnce()
  })
})
