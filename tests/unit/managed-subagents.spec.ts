import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentRun,
  SubagentRuntime,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type {
  WorkflowEngine,
  WorkflowRun,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { ManagedSubagentStarts } from '../../src/managed-subagents.ts'

function agent(id: string): Agent {
  return { id } as unknown as Agent
}

function run(id: string): SubagentRun {
  return {
    id: id as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' }),
    async dispose() {},
  }
}

function request(parent: Agent): SubagentStartRequest {
  return {
    parent,
    prompt: [{ type: 'text', text: 'work' }],
    signal: new AbortController().signal,
  }
}

function continuableRequest(parent: Agent): ContinuableStartSpec {
  return {
    provider: 'spawn',
    label: 'continuable child',
    request: {
      parent,
      prompt: [{ type: 'text', text: 'continue work' }],
    },
    signal: new AbortController().signal,
  }
}

describe('ManagedSubagentStarts', () => {
  it('retains exact parent provenance through awaited provider work and unwinds afterward', async () => {
    const starts = new ManagedSubagentStarts()
    const parent = agent('parent')
    const child = run('child')
    const start = vi.fn(async () => {
      expect(starts.owns(parent)).toBe(true)
      await Promise.resolve()
      expect(starts.owns(parent)).toBe(true)
      return child
    })
    const runtime = { start } as unknown as SubagentRuntime
    const input = request(parent)

    expect(starts.owns(parent)).toBe(false)
    await expect(starts.start(runtime, 'spawn', input)).resolves.toBe(child)
    expect(start).toHaveBeenCalledWith('spawn', input)
    await expect(starts.bind(runtime)('spawn', input)).resolves.toBe(child)
    expect(starts.owns(parent)).toBe(false)
  })

  it('isolates concurrent parents and clears provenance after rejection', async () => {
    const starts = new ManagedSubagentStarts()
    const left = agent('left')
    const right = agent('right')
    const observed: string[] = []
    const runtime = {
      async start(_provider: string, input: SubagentStartRequest): Promise<SubagentRun> {
        await Promise.resolve()
        observed.push(starts.owns(input.parent) ? String(input.parent.id) : 'missing')
        if (input.parent === right) throw new Error('provider failed')
        return run('left-child')
      },
    } as unknown as SubagentRuntime

    const settled = await Promise.allSettled([
      starts.start(runtime, 'spawn', request(left)),
      starts.start(runtime, 'spawn', request(right)),
    ])
    expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(observed).toEqual(['left', 'right'])
    expect(starts.owns(left)).toBe(false)
    expect(starts.owns(right)).toBe(false)
  })

  it('shares exact parent provenance with continuable child creation', async () => {
    const starts = new ManagedSubagentStarts()
    const parent = agent('continuable-parent')
    const input = continuableRequest(parent)
    const child = {
      childId: 'continuable-child',
      messageId: 'initial-message',
    } as unknown as ContinuableStart
    const startContinuable = vi.fn(async () => {
      expect(starts.owns(parent)).toBe(true)
      await Promise.resolve()
      expect(starts.owns(parent)).toBe(true)
      return child
    })
    const runtime = { startContinuable } as unknown as SubagentRuntime

    await expect(starts.startContinuable(runtime, input)).resolves.toBe(child)
    await expect(starts.bindContinuable(runtime)(input)).resolves.toBe(child)
    expect(startContinuable).toHaveBeenCalledTimes(2)
    expect(startContinuable).toHaveBeenCalledWith(input)
    expect(starts.owns(parent)).toBe(false)
  })

  it('shares exact parent provenance with every managed workflow start', () => {
    const starts = new ManagedSubagentStarts()
    const parent = agent('workflow-parent')
    const workflow = { id: 'workflow-run' } as unknown as WorkflowRun
    const start = vi.fn((input: WorkflowStartRequest) => {
      expect(input.parent).toBe(parent)
      expect(starts.owns(parent)).toBe(true)
      return workflow
    })
    const engine = { start } as unknown as WorkflowEngine
    const input = {
      script: 'return null',
      meta: { name: 'managed', description: 'managed workflow' },
      parent,
    }

    expect(starts.bindWorkflow(engine)(input)).toBe(workflow)
    expect(start).toHaveBeenCalledWith(input)
    expect(starts.owns(parent)).toBe(false)
  })
})
