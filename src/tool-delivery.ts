/** Explicit model tools for isolated start-work and fail-closed delivery planning. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { registerRecoveryContribution } from './recovery-coordinator.ts'

export const name = 'dsh-autopilot-tool-delivery'
export const inject = ['autopilotDelivery', 'tools']

function requireWorkspace(exec: ToolExecution): { readonly agent: Agent; readonly repository: string } {
  if (exec.agent === undefined) throw new Error('Autopilot delivery requires an Agent-backed session')
  const workspace = exec.agent.session.header.cwd
  if (workspace === undefined) throw new Error('Autopilot delivery requires a workspace-backed session')
  return { agent: exec.agent, repository: workspace }
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined) throw new Error(`autopilot_delivery requires ${label} for this action`)
  return value
}

function requiredText(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`autopilot_delivery requires ${label} for this action`)
  return value
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Register one structured tool with no arbitrary command, path, push, or PR execution input. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'autopilot_delivery',
    description: 'Create, inspect, checkpoint, plan, or clean an isolated Git worktree. Checkpoint verdicts are model-reported observations, not Autopilot verifier attestations. Status is read-only; every mutation including cleanup requires the snapshot\'s exact armed Autopilot parent. Planning records fixed argv only; this tool never commits, pushes, or opens pull requests.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'status', 'checkpoint', 'prepare', 'cleanup'],
      },
      expectedGeneration: { type: 'number' },
      expectedRevision: { type: 'number' },
      baseBranch: { type: 'string' },
      verificationVerdict: {
        type: 'string',
        enum: ['pass', 'fail', 'inconclusive', 'error'],
      },
      verificationSummary: { type: 'string' },
      verificationChecks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            passed: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
          },
        },
      },
      handoffSummary: { type: 'string' },
      handoffNextAction: { type: 'string' },
      commitMessage: { type: 'string' },
      remote: { type: 'string' },
      targetBranch: { type: 'string' },
      pullRequestTitle: { type: 'string' },
      pullRequestBody: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const { agent, repository } = requireWorkspace(exec)
      if (args.action === 'status') {
        return jsonValue({ status: await ctx.autopilotDelivery.status(repository) ?? null })
      }
      const expectedGeneration = requiredNumber(args.expectedGeneration, 'expectedGeneration')
      if (args.action === 'create') {
        return jsonValue({
          snapshot: await ctx.autopilotDelivery.create(agent, {
            repository,
            expectedGeneration,
            ...(args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch }),
          }),
        })
      }
      const expectedRevision = requiredNumber(args.expectedRevision, 'expectedRevision')
      if (args.action === 'checkpoint') {
        const hasVerification = args.verificationVerdict !== undefined
          || args.verificationSummary !== undefined || args.verificationChecks !== undefined
        const hasHandoff = args.handoffSummary !== undefined || args.handoffNextAction !== undefined
        return jsonValue({
          snapshot: await ctx.autopilotDelivery.checkpoint(agent, {
            repository,
            expectedGeneration,
            expectedRevision,
            ...(hasVerification ? {
              verification: {
                verdict: args.verificationVerdict
                  ?? (() => { throw new Error('checkpoint verification requires verificationVerdict') })(),
                summary: requiredText(args.verificationSummary, 'verificationSummary'),
                checks: args.verificationChecks ?? [],
              },
            } : {}),
            ...(hasHandoff ? {
              handoff: {
                summary: requiredText(args.handoffSummary, 'handoffSummary'),
                nextAction: requiredText(args.handoffNextAction, 'handoffNextAction'),
              },
            } : {}),
          }),
        })
      }
      if (args.action === 'prepare') {
        return jsonValue({
          snapshot: await ctx.autopilotDelivery.prepareDelivery(agent, {
            repository,
            expectedGeneration,
            expectedRevision,
            commitMessage: requiredText(args.commitMessage, 'commitMessage'),
            ...(args.remote === undefined ? {} : { remote: args.remote }),
            ...(args.targetBranch === undefined ? {} : { targetBranch: args.targetBranch }),
            ...(args.pullRequestTitle === undefined ? {} : { pullRequestTitle: args.pullRequestTitle }),
            ...(args.pullRequestBody === undefined ? {} : { pullRequestBody: args.pullRequestBody }),
          }),
        })
      }
      return jsonValue({
        snapshot: await ctx.autopilotDelivery.cleanup(agent, {
          repository,
          expectedGeneration,
          expectedRevision,
        }),
      })
    },
  })))
  registerRecoveryContribution(ctx, 'tool-delivery')
}
