/** Recoverable Host-only Cordis lifecycle owned by one durable Autopilot run. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CordisDynamicPluginId } from '@deepseek-ai/dsh-cordis-host-runner'
import type {
  DynamicCordisDefineReceipt,
} from '@deepseek-ai/dsh-cordis-host-runner'
import type { DynamicExtensionVersion } from './run-state.ts'

/** Services a generated extension may not use because they control authority or orchestration. */
export const DEFAULT_FORBIDDEN_DYNAMIC_SERVICES = Object.freeze([
  'agents',
  'agentPresets',
  'approval',
  'autonomy',
  'commands',
  'dynamicCordisRunner',
  'goals',
  'interaction',
  'permissionPresets',
  'sessionPersistence',
  'storage',
  'storageDomain',
  'subagents',
  'workflowEngine',
])

/** Model request for one immutable Host-only extension version. */
export interface DynamicExtensionApplyRequest {
  readonly logicalId: string
  readonly name: string
  readonly purpose: string
  readonly hostCode: string
}

/** Process-local identity of one rehydratable active Host extension. */
export interface DynamicExtensionRuntime {
  readonly runId: string
  readonly logicalId: string
  readonly version: number
  readonly pluginId: string
  readonly packageId: string
  readonly pluginRunId: string
  readonly sourceSha256: string
}

/** Successful, inspected wrapper result returned to the model. */
export interface DynamicExtensionApplyResult extends DynamicExtensionRuntime {
  readonly status: 'running'
  readonly handlers: readonly string[]
  readonly recovered: boolean
}

/** Stable SHA-256 over exactly the source executed by the Host runner. */
export function dynamicSourceSha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

/** Reject direct references to authority-bearing services before evaluating source. */
export function scanDynamicSource(source: string, forbiddenServices: readonly string[]): void {
  for (const service of forbiddenServices) {
    const escaped = service.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const directName = new RegExp(`(?:['"]${escaped}['"]|\\b${escaped}\\b)`, 'u')
    if (directName.test(source)) {
      throw new Error(
        `Host extension source references forbidden service "${service}". `
        + 'This trusted-code lint catches direct mistakes only; it is not a capability sandbox or security boundary.',
      )
    }
  }
}

/** Mint a valid semantic DSH dynamic Plugin prefix from a logical id. */
function pluginPrefix(logicalId: string): string {
  const letters = logicalId.replace(/[^a-z]/gu, '')
  return `${letters}dsh`.slice(0, Math.max(3, Math.min(6, letters.length)))
}

/** Key process-local runtime state by one owning Agent and logical id. */
function runtimeKey(runId: string, logicalId: string): string {
  return `${runId}\u0000${logicalId}`
}

/** Stable runner metadata that lets a replacement controller identify its own Packages. */
function runtimePurpose(runId: string, extension: DynamicExtensionVersion): string {
  return `${extension.purpose}\n[dsh-autopilot:${runId}:${extension.logicalId}:${extension.version}:${extension.sourceSha256}]`
}

/** Own wrapper-defined runtime identities and reconstruct them from durable source after a restart. */
export class DynamicExtensionController {
  private readonly runtimes = new Map<Agent, Map<string, DynamicExtensionRuntime>>()

  constructor(
    private readonly ctx: Context,
    private readonly forbiddenServices: readonly string[] = DEFAULT_FORBIDDEN_DYNAMIC_SERVICES,
  ) {}

  /** Apply one model-proposed immutable version, with durable intent before side effects. */
  async apply(
    agent: Agent,
    request: DynamicExtensionApplyRequest,
    signal: AbortSignal,
  ): Promise<DynamicExtensionApplyResult> {
    scanDynamicSource(request.hostCode, this.forbiddenServices)
    const sourceSha256 = dynamicSourceSha256(request.hostCode)
    const reserved = await this.ctx.autonomy.beginDynamicExtension(agent, { ...request, sourceSha256 })
    const extension = reserved.extension
    const previous = reserved.view.dynamicExtensions
      .filter(candidate => candidate.logicalId === extension.logicalId && candidate.status === 'active')
      .sort((left, right) => right.version - left.version)[0]
    try {
      const result = await this.activate(agent, reserved.view.id, extension, signal, false)
      await this.ctx.autonomy.settleDynamicExtension(agent, extension.logicalId, extension.version, { ok: true })
      return result
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      let rollbackError: unknown
      try {
        await this.rollback(agent, reserved.view.id, extension.logicalId, previous, signal)
      } catch (errorDuringRollback: unknown) {
        rollbackError = errorDuringRollback
      }
      const durableReason = rollbackError === undefined
        ? reason
        : `${reason}; rollback failed: ${String(rollbackError)}`
      try {
        await this.ctx.autonomy.settleDynamicExtension(
          agent,
          extension.logicalId,
          extension.version,
          { ok: false, reason: durableReason },
        )
      } catch (settleError: unknown) {
        this.ctx.logger.error(`dsh-autopilot: could not persist failed dynamic extension: ${String(settleError)}`)
      }
      if (rollbackError !== undefined) {
        let pauseError: unknown
        try {
          await this.ctx.autonomy.pause(agent, durableReason)
        } catch (errorDuringPause: unknown) {
          pauseError = errorDuringPause
        }
        throw new AggregateError(
          pauseError === undefined ? [error, rollbackError] : [error, rollbackError, pauseError],
          durableReason,
        )
      }
      throw error
    }
  }

  /** Reserve removal, retract the process-local contribution, then settle durable state. */
  async remove(agent: Agent, logicalId: string, reason: string): Promise<void> {
    const current = this.ctx.autonomy.get(agent)
    const pending = current?.dynamicExtensions.filter(extension => extension.logicalId === logicalId
      && extension.status === 'removing') ?? []
    const removal = pending.length > 0 && current !== undefined
      ? { view: current, extensions: pending }
      : await this.ctx.autonomy.beginDynamicExtensionRemoval(agent, logicalId, reason)
    const runtime = this.runtimes.get(agent)?.get(runtimeKey(removal.view.id, logicalId))
    const pluginIds = this.markedPluginIds(agent, removal.view.id, removal.extensions)
    if (runtime !== undefined) pluginIds.add(runtime.pluginId)
    if (pluginIds.size === 0) {
      await this.ctx.autonomy.settleDynamicExtensionRemoval(agent, logicalId, { ok: true })
      return
    }
    try {
      for (const pluginId of pluginIds) {
        await this.ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(pluginId))
      }
    } catch (error: unknown) {
      const failure = `dynamic extension removal failed: ${String(error)}`
      let settleError: unknown
      try {
        await this.ctx.autonomy.settleDynamicExtensionRemoval(
          agent,
          logicalId,
          { ok: false, reason: failure },
        )
      } catch (errorDuringSettle: unknown) {
        settleError = errorDuringSettle
      }
      let pauseError: unknown
      try {
        await this.ctx.autonomy.pause(agent, failure)
      } catch (errorDuringPause: unknown) {
        pauseError = errorDuringPause
      }
      const failures = [error, ...(settleError === undefined ? [] : [settleError]), ...(pauseError === undefined ? [] : [pauseError])]
      throw failures.length === 1 ? error : new AggregateError(failures, failure)
    }
    await this.ctx.autonomy.settleDynamicExtensionRemoval(agent, logicalId, { ok: true })
    if (runtime !== undefined) this.deleteRuntime(agent, runtime)
  }

  /** Recreate active or interrupted Host versions before the next model step. */
  async ensureRehydrated(agent: Agent): Promise<void> {
    const lease = this.ctx.autonomy.get(agent)
    if (lease === undefined || lease.activation !== 'armed' || lease.phase !== 'running') return
    const removing = new Set(lease.dynamicExtensions
      .filter(extension => extension.status === 'removing')
      .map(extension => extension.logicalId))
    for (const logicalId of removing) {
      await this.remove(agent, logicalId, 'resume pending dynamic extension cleanup')
    }
    const currentLease = this.ctx.autonomy.get(agent)
    if (currentLease === undefined || currentLease.activation !== 'armed' || currentLease.phase !== 'running') return
    const latest = new Map<string, DynamicExtensionVersion>()
    for (const extension of currentLease.dynamicExtensions) {
      if (extension.status !== 'active' && extension.status !== 'applying') continue
      const current = latest.get(extension.logicalId)
      if (current === undefined || extension.version > current.version) latest.set(extension.logicalId, extension)
    }
    for (const extension of latest.values()) {
      try {
        const existing = this.runtimes.get(agent)?.get(runtimeKey(currentLease.id, extension.logicalId))
          ?? this.adoptActiveRuntime(agent, currentLease.id, extension)
        if (existing?.version === extension.version && existing.sourceSha256 === extension.sourceSha256) {
          if (extension.status === 'applying') {
            await this.ctx.autonomy.settleDynamicExtension(agent, extension.logicalId, extension.version, { ok: true })
          }
          continue
        }
        if (existing !== undefined) {
          await this.ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(existing.pluginId))
          this.deleteRuntime(agent, existing)
        }
        await this.activate(agent, currentLease.id, extension, this.ctx.autonomy.signal(agent), true)
        if (extension.status === 'applying') {
          await this.ctx.autonomy.settleDynamicExtension(agent, extension.logicalId, extension.version, { ok: true })
        }
      } catch (error: unknown) {
        const reason = `dynamic extension recovery failed for ${extension.logicalId}@${extension.version}: ${String(error)}`
        if (extension.status === 'applying') {
          await this.ctx.autonomy.settleDynamicExtension(
            agent,
            extension.logicalId,
            extension.version,
            { ok: false, reason },
          )
        }
        await this.ctx.autonomy.pause(agent, reason)
        throw new Error(reason)
      }
    }
  }

  /** Retract every runtime contribution for a paused or terminal run. */
  async cleanup(agent: Agent, runId: string): Promise<void> {
    const runtimes = this.runtimes.get(agent)
    const durable = this.ctx.autonomy.get(agent)
    const effectiveRunId = runId.length === 0 ? durable?.id ?? '' : runId
    const marked = durable === undefined || effectiveRunId.length === 0
      ? new Set<string>()
      : this.markedPluginIds(agent, effectiveRunId, durable.dynamicExtensions)
    for (const runtime of runtimes?.values() ?? []) {
      if (runId.length === 0 || runtime.runId === runId) marked.add(runtime.pluginId)
    }
    if (marked.size === 0) return
    const failures: unknown[] = []
    for (const pluginId of marked) {
      try {
        await this.ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(pluginId))
      } catch (error: unknown) {
        failures.push(error)
        continue
      }
      for (const runtime of runtimes?.values() ?? []) {
        if (runtime.pluginId === pluginId) this.deleteRuntime(agent, runtime)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to retract ${failures.length} dynamic extension contribution(s)`)
    }
  }

  /** Retract every process-local contribution owned by this controller. */
  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const agent of this.runtimes.keys()) {
      try {
        await this.cleanup(agent, '')
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to dispose dynamic extension controller')
    }
  }

  /** Read detached process-local identities for status and tests. */
  list(agent: Agent): readonly DynamicExtensionRuntime[] {
    return Object.freeze([...(this.runtimes.get(agent)?.values() ?? [])].map(runtime => Object.freeze({ ...runtime })))
  }

  private async activate(
    agent: Agent,
    runId: string,
    extension: DynamicExtensionVersion,
    signal: AbortSignal,
    recovered: boolean,
  ): Promise<DynamicExtensionApplyResult> {
    if (dynamicSourceSha256(extension.hostCode) !== extension.sourceSha256) {
      throw new Error(`dynamic extension ${extension.logicalId}@${extension.version} source hash does not match its audit record`)
    }
    scanDynamicSource(extension.hostCode, this.forbiddenServices)
    const key = runtimeKey(runId, extension.logicalId)
    const existing = this.runtimes.get(agent)?.get(key)
    const receipt: DynamicCordisDefineReceipt = this.ctx.dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: existing === undefined
        ? { kind: 'new', idPrefix: pluginPrefix(extension.logicalId) }
        : { kind: 'existing', pluginId: CordisDynamicPluginId(existing.pluginId) },
      name: extension.name,
      purpose: runtimePurpose(runId, extension),
      code: { host: extension.hostCode },
    })
    let response
    try {
      response = await this.ctx.dynamicCordisRunner.run(
        agent,
        receipt.pluginId,
        receipt.packageId,
        existing === undefined ? 'run' : 'update',
        signal,
      )
    } catch (error: unknown) {
      if (existing === undefined) await this.ctx.dynamicCordisRunner.undefine(agent, receipt.pluginId)
      throw error
    }
    if (!response.ok || response.status !== 'running' || response.waitingFor.length > 0) {
      if (existing === undefined) await this.ctx.dynamicCordisRunner.undefine(agent, receipt.pluginId)
      throw new Error(response.ok
        ? `Host extension is waiting for unavailable services: ${response.waitingFor.join(', ')}`
        : response.message)
    }
    const snapshot = this.ctx.dynamicCordisRunner.snapshot(agent)
      .find(candidate => candidate.pluginId === receipt.pluginId)
    if (snapshot?.activeRun?.packageId !== receipt.packageId) {
      if (existing === undefined) await this.ctx.dynamicCordisRunner.undefine(agent, receipt.pluginId)
      throw new Error('Host extension activation did not produce the inspected active Package')
    }
    const runtime: DynamicExtensionRuntime = Object.freeze({
      runId,
      logicalId: extension.logicalId,
      version: extension.version,
      pluginId: String(receipt.pluginId),
      packageId: String(receipt.packageId),
      pluginRunId: String(response.pluginRunId),
      sourceSha256: extension.sourceSha256,
    })
    const runtimes = this.runtimes.get(agent) ?? new Map<string, DynamicExtensionRuntime>()
    runtimes.set(key, runtime)
    this.runtimes.set(agent, runtimes)
    return Object.freeze({
      ...runtime,
      status: 'running',
      handlers: Object.freeze([...snapshot.activeRun.handlers]),
      recovered,
    })
  }

  private async rollback(
    agent: Agent,
    runId: string,
    logicalId: string,
    previous: DynamicExtensionVersion | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const runtime = this.runtimes.get(agent)?.get(runtimeKey(runId, logicalId))
    if (runtime !== undefined) {
      await this.ctx.dynamicCordisRunner.undefine(agent, CordisDynamicPluginId(runtime.pluginId))
      this.deleteRuntime(agent, runtime)
    }
    if (previous !== undefined) {
      await this.activate(agent, runId, previous, signal, true)
    }
  }

  private deleteRuntime(agent: Agent, runtime: DynamicExtensionRuntime): void {
    const runtimes = this.runtimes.get(agent)
    runtimes?.delete(runtimeKey(runtime.runId, runtime.logicalId))
    if (runtimes?.size === 0) this.runtimes.delete(agent)
  }

  /** Adopt the exact active Package left by an earlier controller instance. */
  private adoptActiveRuntime(
    agent: Agent,
    runId: string,
    extension: DynamicExtensionVersion,
  ): DynamicExtensionRuntime | undefined {
    const candidates = this.ctx.dynamicCordisRunner.snapshot(agent).filter((row) => {
      if (row.activeRun === undefined) return false
      const inspected = this.ctx.dynamicCordisRunner.inspectPackage(agent, row.pluginId, row.activeRun.packageId)
      return inspected.name === extension.name
        && inspected.purpose === runtimePurpose(runId, extension)
        && inspected.code.host === extension.hostCode
        && inspected.code.client === undefined
    })
    if (candidates.length > 1) {
      throw new Error(`multiple active Host Plugins claim ${extension.logicalId}@${extension.version}`)
    }
    const row = candidates[0]
    if (row?.activeRun === undefined) return undefined
    const runtime: DynamicExtensionRuntime = Object.freeze({
      runId,
      logicalId: extension.logicalId,
      version: extension.version,
      pluginId: String(row.pluginId),
      packageId: String(row.activeRun.packageId),
      pluginRunId: String(row.activeRun.pluginRunId),
      sourceSha256: extension.sourceSha256,
    })
    const runtimes = this.runtimes.get(agent) ?? new Map<string, DynamicExtensionRuntime>()
    runtimes.set(runtimeKey(runId, extension.logicalId), runtime)
    this.runtimes.set(agent, runtimes)
    return runtime
  }

  /** Find every runner Plugin carrying an exact durable marker for these versions. */
  private markedPluginIds(
    agent: Agent,
    runId: string,
    extensions: readonly DynamicExtensionVersion[],
  ): Set<string> {
    const pluginIds = new Set<string>()
    for (const row of this.ctx.dynamicCordisRunner.snapshot(agent)) {
      for (const candidate of row.packages) {
        const inspected = this.ctx.dynamicCordisRunner.inspectPackage(agent, row.pluginId, candidate.packageId)
        const matches = extensions.some(extension => inspected.name === extension.name
          && inspected.purpose === runtimePurpose(runId, extension)
          && inspected.code.host === extension.hostCode
          && inspected.code.client === undefined)
        if (matches) pluginIds.add(String(row.pluginId))
      }
    }
    return pluginIds
  }
}
