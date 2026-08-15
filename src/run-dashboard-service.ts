/** Optional Cordis Host service for read-only Autopilot terminal dashboards. */
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import s from '@deepseek-ai/schemastery'
import {
  buildRunDashboardSnapshot,
  DEFAULT_RUN_DASHBOARD_INTERVAL_MS,
  DEFAULT_RUN_DASHBOARD_ROWS,
  DEFAULT_RUN_DASHBOARD_WIDTH,
  MAX_RUN_DASHBOARD_INTERVAL_MS,
  MAX_RUN_DASHBOARD_ROWS,
  MIN_RUN_DASHBOARD_INTERVAL_MS,
  readRunDashboards,
  renderRunDashboards,
  resolveRunDashboardConfig,
  RunDashboardWatch,
} from './run-dashboard.ts'
import type {
  OpenRunDashboardStores,
  ReadRunDashboardRequest,
  ResolvedRunDashboardConfig,
  RunDashboardConfig,
  RunDashboardScheduler,
  RunDashboardSnapshot,
} from './run-dashboard.ts'

/** Host defaults and presentation stream for explicit dashboard reads and watches. */
export interface AutopilotRunDashboardConfig extends RunDashboardConfig {
  /** Terminal stream selected only when a Host explicitly starts a watch. */
  readonly output?: 'stdout' | 'stderr'
}

/** Fully validated Host dashboard configuration. */
export interface ResolvedAutopilotRunDashboardConfig extends ResolvedRunDashboardConfig {
  readonly output: 'stdout' | 'stderr'
}

/** Per-call read overrides used by a direct-human command or Host integration. */
export interface AutopilotRunDashboardReadRequest extends ReadRunDashboardRequest {
  /** Presentation width used by {@link AutopilotRunDashboardService.render}. */
  readonly width?: number
}

/** Explicit Host watch overrides. No watch starts during plugin initialization. */
export interface AutopilotRunDashboardWatchRequest extends AutopilotRunDashboardReadRequest {
  readonly intervalMs?: number
  readonly clearScreen?: boolean
  readonly write?: (frame: string) => void
  readonly scheduler?: RunDashboardScheduler
  readonly onError?: (error: unknown) => void
}

/** Handle for one explicit read-only terminal watch. */
export interface AutopilotRunDashboardWatchHandle {
  /** Force a fresh durable read and emit its frame. */
  refresh(): Promise<readonly RunDashboardSnapshot[]>
  /** Stop future refreshes; safe to call repeatedly. */
  stop(): void
}

/** Test and embedding overrides; normal Cordis composition uses durable stores and a process stream. */
export interface AutopilotRunDashboardRuntime {
  readonly openStores?: OpenRunDashboardStores
  readonly write?: (frame: string) => void
  readonly scheduler?: RunDashboardScheduler
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotRunDashboard: AutopilotRunDashboardService
  }
}

/** Validate and materialize Host defaults without starting a polling loop. */
export function resolveAutopilotRunDashboardConfig(
  config: AutopilotRunDashboardConfig = {},
): ResolvedAutopilotRunDashboardConfig {
  const base = resolveRunDashboardConfig(config)
  const output = config.output ?? 'stderr'
  if (output !== 'stdout' && output !== 'stderr') {
    throw new Error('output must be stdout or stderr')
  }
  return Object.freeze({ ...base, output })
}

/** Host service exposing fresh durable reads, one-shot rendering, and opt-in watches. */
export class AutopilotRunDashboardService extends Service {
  static inject = ['agents', 'autonomy', 'goals']

  static Config: s<AutopilotRunDashboardConfig> = s.object({
    sessionId: s.string(),
    intervalMs: s.number().step(1).min(MIN_RUN_DASHBOARD_INTERVAL_MS)
      .max(MAX_RUN_DASHBOARD_INTERVAL_MS).default(DEFAULT_RUN_DASHBOARD_INTERVAL_MS),
    maxRows: s.number().step(1).min(1).max(MAX_RUN_DASHBOARD_ROWS)
      .default(DEFAULT_RUN_DASHBOARD_ROWS),
    width: s.number().step(1).min(40).max(240).default(DEFAULT_RUN_DASHBOARD_WIDTH),
    clearScreen: s.boolean().default(true),
    output: s.union(['stdout', 'stderr'] as const).default('stderr'),
  })

  /** Validated deployment-owned defaults. */
  readonly config: ResolvedAutopilotRunDashboardConfig

  private readonly openStores: OpenRunDashboardStores | undefined
  private readonly defaultWrite: (frame: string) => void
  private readonly defaultScheduler: RunDashboardScheduler | undefined
  private readonly watches = new Set<RunDashboardWatch>()

  /**
   * @param ctx - Host context carrying the public Agent, Goal, and storage-domain services.
   * @param config - Read and terminal presentation defaults; none starts a watch.
   * @param runtime - Optional store, stream, and timer seams for embedding and tests.
   */
  constructor(
    ctx: Context,
    config: AutopilotRunDashboardConfig = {},
    runtime: AutopilotRunDashboardRuntime = {},
  ) {
    super(ctx, 'autopilotRunDashboard')
    this.config = resolveAutopilotRunDashboardConfig(config)
    this.openStores = runtime.openStores
    this.defaultScheduler = runtime.scheduler
    this.defaultWrite = runtime.write ?? ((frame) => {
      const stream = this.config.output === 'stdout' ? process.stdout : process.stderr
      stream.write(frame)
    })
    ctx.effect(() => () => {
      for (const watch of this.watches) watch.stop()
      this.watches.clear()
    }, 'dsh-autopilot.runDashboardWatches')
  }

  /** Take one fresh, read-only cut from the services that own each durable domain. */
  read(request: ReadRunDashboardRequest = {}): Promise<readonly RunDashboardSnapshot[]> {
    const sessionId = request.sessionId ?? this.config.sessionId
    const readRequest = {
      ...(sessionId === undefined ? {} : { sessionId }),
      maxRows: request.maxRows ?? this.config.maxRows,
      ...(request.observedAt === undefined ? {} : { observedAt: request.observedAt }),
    }
    if (this.openStores !== undefined) {
      return readRunDashboards(this.ctx, readRequest, this.openStores)
    }
    const resolved = resolveRunDashboardConfig(readRequest)
    const observedAt = request.observedAt ?? Date.now()
    const team = this.ctx.get('autopilotTeam')
    const ralph = this.ctx.get('autopilotRalph')
    const workflows = this.ctx.get('autopilotWorkflows')
    const notifications = this.ctx.get('autopilotNotifications')?.list() ?? Object.freeze([])
    const deliveries = this.ctx.get('autopilotDelivery')?.list() ?? Object.freeze([])
    const runs = this.ctx.autonomy.currentSnapshots().filter(run =>
      resolved.sessionId === undefined || run.sessionId === resolved.sessionId)
    return Promise.resolve(Object.freeze(runs.map((run) => {
      const agent = this.ctx.agents.get(SessionId(run.sessionId))
      const goal = agent === undefined ? undefined : this.ctx.goals.get(agent)
      return buildRunDashboardSnapshot({
        run,
        ...(goal === undefined ? {} : { goal }),
        team: team?.listRun(run.sessionId, run.runId, run.generation) ?? Object.freeze([]),
        ralph: ralph?.listRun(run.sessionId, run.runId, run.generation) ?? Object.freeze([]),
        workflows: workflows?.listRun(run.sessionId, run.runId, run.generation) ?? Object.freeze([]),
        notifications: notifications.filter(notification => notification.sessionId === run.sessionId
          && notification.runId === run.runId
          && notification.generation === run.generation),
        deliveries: deliveries.filter(delivery => delivery.parentSessionId === run.sessionId
          && delivery.parentRunId === run.runId
          && delivery.parentRunGeneration === run.generation),
      }, resolved.maxRows, observedAt)
    })))
  }

  /** Render one fresh durable cut without writing to a terminal. */
  async render(request: AutopilotRunDashboardReadRequest = {}): Promise<string> {
    const snapshots = await this.read(request)
    return renderRunDashboards(snapshots, request.width ?? this.config.width)
  }

  /** Start a polling loop only after an explicit Host call. */
  watch(request: AutopilotRunDashboardWatchRequest = {}): AutopilotRunDashboardWatchHandle {
    const sessionId = request.sessionId ?? this.config.sessionId
    const resolved = resolveRunDashboardConfig({
      ...(sessionId === undefined ? {} : { sessionId }),
      intervalMs: request.intervalMs ?? this.config.intervalMs,
      maxRows: request.maxRows ?? this.config.maxRows,
      width: request.width ?? this.config.width,
      clearScreen: request.clearScreen ?? this.config.clearScreen,
    })
    const scheduler = request.scheduler ?? this.defaultScheduler
    const watch = new RunDashboardWatch({
      read: () => this.read({
        ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
        maxRows: resolved.maxRows,
      }),
      write: request.write ?? this.defaultWrite,
      intervalMs: resolved.intervalMs,
      width: resolved.width,
      clearScreen: resolved.clearScreen,
      ...(scheduler === undefined ? {} : { scheduler }),
      ...(request.onError === undefined ? {} : { onError: request.onError }),
    })
    this.watches.add(watch)
    const stopWatch = watch.start()
    let stopped = false
    return Object.freeze({
      refresh: () => watch.refresh(),
      stop: () => {
        if (stopped) return
        stopped = true
        stopWatch()
        this.watches.delete(watch)
      },
    })
  }
}

export default AutopilotRunDashboardService
