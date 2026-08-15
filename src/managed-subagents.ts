/** Async provenance for subagents started by the Autopilot orchestrator. */
import { AsyncLocalStorage } from 'node:async_hooks'
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

/** Start function shared by task and reviewer orchestration. */
export type ManagedSubagentStart = (
  provider: string,
  request: SubagentStartRequest,
) => Promise<SubagentRun>

/** Start function shared by continuable team orchestration. */
export type ManagedContinuableStart = (spec: ContinuableStartSpec) => Promise<ContinuableStart>

/** Start function shared by deployment-fixed managed workflows. */
export type ManagedWorkflowEngineStart = (request: WorkflowStartRequest) => WorkflowRun

/**
 * Tags one native subagent start across awaited provider work.
 *
 * The DSH lifecycle event is emitted before `SubagentRuntime.start()` returns.
 * Async-local provenance therefore lets the observer distinguish a managed
 * task or reviewer from an unrelated same-process caller without depending on
 * deployment-configurable tool names.
 */
export class ManagedSubagentStarts {
  private readonly parent = new AsyncLocalStorage<Agent>()

  /**
   * Start one child while retaining its exact authorizing parent in the
   * synchronous `subagent/start` lifecycle publication.
   * @param runtime - Native DSH subagent service.
   * @param provider - Selected DSH subagent transport.
   * @param request - Complete one-shot child request.
   * @returns The published child run.
   */
  start(
    runtime: SubagentRuntime,
    provider: string,
    request: SubagentStartRequest,
  ): Promise<SubagentRun> {
    return this.parent.run(request.parent, () => runtime.start(provider, request))
  }

  /**
   * Start one continuable child under the same parent provenance used by
   * one-shot task and reviewer dispatch.
   * @param runtime - Native DSH subagent service.
   * @param spec - Complete continuable-child creation request.
   * @returns The durable child and accepted initial-message identities.
   */
  startContinuable(
    runtime: SubagentRuntime,
    spec: ContinuableStartSpec,
  ): Promise<ContinuableStart> {
    return this.parent.run(spec.request.parent, () => runtime.startContinuable(spec))
  }

  /**
   * Test whether the current lifecycle publication belongs to this
   * orchestrator and exact parent.
   * @param parent - Parent whose scoped lifecycle listener is running.
   * @returns Whether the active async call chain was opened by {@link start}.
   */
  owns(parent: Agent): boolean {
    return this.parent.getStore() === parent
  }

  /**
   * Bind the native service into the callback consumed by orchestrators.
   * @param runtime - Native DSH subagent service.
   * @returns A managed start callback retaining async provenance.
   */
  bind(runtime: SubagentRuntime): ManagedSubagentStart {
    return (provider, request) => this.start(runtime, provider, request)
  }

  /**
   * Bind the native continuable-child service under managed provenance.
   * @param runtime - Native DSH subagent service.
   * @returns A managed continuable-start callback.
   */
  bindContinuable(runtime: SubagentRuntime): ManagedContinuableStart {
    return spec => this.startContinuable(runtime, spec)
  }

  /**
   * Bind a workflow engine under the same parent provenance as direct children.
   * Every internal workflow child inherits this async-local owner.
   * @param engine - Native DSH workflow engine.
   * @returns A managed workflow-start callback.
   */
  bindWorkflow(engine: WorkflowEngine): ManagedWorkflowEngineStart {
    return request => this.parent.run(request.parent, () => engine.start(request))
  }
}
