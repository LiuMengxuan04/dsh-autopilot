/** Structural inspection of an unevaluated `dsh --dump-config` document. */
import { parseDocument } from 'yaml'

/** Severity of one readiness diagnostic. */
export type DoctorDiagnosticLevel = 'pass' | 'warn' | 'fail'

/** One human-readable readiness diagnostic. */
export interface DoctorDiagnostic {
  readonly level: DoctorDiagnosticLevel
  readonly message: string
}

interface LoaderRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly disabled?: unknown
}

interface InstalledModule {
  readonly id: string
  readonly name: string
}

interface RequiredService {
  readonly service: string
  readonly rowIds: readonly string[]
  readonly rowPrefixes?: readonly string[]
  readonly modules: (name: string) => boolean
}

interface RequiredComposition {
  readonly capability: string
  readonly requirements: readonly {
    readonly rowIds: readonly string[]
    readonly modules: (name: string) => boolean
  }[]
}

interface ResolvedValue<T> {
  readonly valid: boolean
  readonly value: T
  readonly source: 'configured' | 'default'
}

const DAY_MS = 24 * 60 * 60 * 1000
const LONG_RUN_DEFAULT_ACTIVE_MS = 7 * DAY_MS
const LONG_RUN_MAX_ACTIVE_MS = 30 * DAY_MS
const LONG_RUN_DEFAULT_ROUNDS = 1024
const LONG_RUN_MAX_ROUNDS = 4096

const SERVICE_DEFAULTS = Object.freeze({
  autoResume: false,
  selfModification: 'off',
  defaultMaxGoalRounds: 256,
  maxGoalRounds: 1024,
  defaultMaxActiveMs: LONG_RUN_DEFAULT_ACTIVE_MS,
  maxActiveMs: LONG_RUN_MAX_ACTIVE_MS,
  maxTasks: 256,
  maxTaskAttempts: 2048,
  maxEvidenceItems: 4096,
  maxSnapshotBytes: 524_288,
  maxAuditRecords: 8192,
  maxAuditBytes: 268_435_456,
  maxDynamicSourceChars: 262_144,
})

const INSTALLATION = Object.freeze<readonly InstalledModule[]>([
  { id: 'dsh-autopilot-service', name: 'dsh-autopilot/service' },
  { id: 'dsh-autopilot-notifications', name: 'dsh-autopilot/notification-service' },
  { id: 'dsh-autopilot-workflows', name: 'dsh-autopilot/workflow-service' },
  { id: 'dsh-autopilot-lifecycle-hooks', name: 'dsh-autopilot/lifecycle-hooks' },
  { id: 'dsh-autopilot-run-dashboard', name: 'dsh-autopilot/run-dashboard-service' },
  { id: 'dsh-autopilot-team', name: 'dsh-autopilot/team-service' },
  { id: 'dsh-autopilot-ralph', name: 'dsh-autopilot/ralph-service' },
  { id: 'dsh-autopilot-missions', name: 'dsh-autopilot/mission-service' },
  { id: 'dsh-autopilot-delivery', name: 'dsh-autopilot/delivery-service' },
  { id: 'dsh-autopilot-commands', name: 'dsh-autopilot/commands' },
  { id: 'dsh-autopilot-tools', name: 'dsh-autopilot/tools' },
  { id: 'dsh-autopilot-tool-delivery', name: 'dsh-autopilot/tool-delivery' },
  { id: 'dsh-autopilot-code-intelligence', name: 'dsh-autopilot/code-intelligence' },
  { id: 'dsh-autopilot-visual-qa', name: 'dsh-autopilot/visual-qa' },
  { id: 'dsh-autopilot-memory', name: 'dsh-autopilot/memory' },
  { id: 'dsh-autopilot-tool-memory', name: 'dsh-autopilot/tool-memory' },
  { id: 'dsh-autopilot-prompt-rules', name: 'dsh-autopilot/prompt-rules' },
  { id: 'dsh-autopilot-custom-commands', name: 'dsh-autopilot/custom-commands' },
  { id: 'dsh-autopilot-skills', name: 'dsh-autopilot/skills' },
  { id: 'dsh-autopilot-skill-mcp', name: 'dsh-autopilot/skill-mcp' },
  {
    id: 'dsh-autopilot-recovery-coordinator',
    name: 'dsh-autopilot/recovery-coordinator',
  },
])

const exactModule = (expected: string): ((name: string) => boolean) => name => name === expected
const prefixedModule = (...prefixes: readonly string[]): ((name: string) => boolean) =>
  name => prefixes.some(prefix => name.startsWith(prefix))

const REQUIRED_SERVICES = Object.freeze<readonly RequiredService[]>([
  {
    service: 'storageDomain',
    rowIds: ['storage-domain', 'storageDomain'],
    modules: exactModule('@deepseek-ai/dsh-storage-domain'),
  },
  {
    service: 'sessionPersistence',
    rowIds: ['session-persistence', 'sessionPersistence'],
    rowPrefixes: ['session-persistence-'],
    modules: prefixedModule('@deepseek-ai/dsh-session-persistence'),
  },
  {
    service: 'agents',
    rowIds: ['agent', 'agents'],
    modules: exactModule('@deepseek-ai/dsh-agent'),
  },
  {
    service: 'sessions',
    rowIds: ['session', 'sessions'],
    modules: exactModule('@deepseek-ai/dsh-session'),
  },
  {
    service: 'commands',
    rowIds: ['commands'],
    modules: exactModule('@deepseek-ai/dsh-commands'),
  },
  {
    service: 'goals',
    rowIds: ['goal', 'goals'],
    modules: exactModule('@deepseek-ai/dsh-goal'),
  },
  {
    service: 'subagents',
    rowIds: ['subagent', 'subagents'],
    modules: exactModule('@deepseek-ai/dsh-subagent'),
  },
  {
    service: 'spawn subagent provider',
    rowIds: ['subagent-spawn-in-process'],
    modules: exactModule('@deepseek-ai/dsh-subagent-spawn-in-process'),
  },
  {
    service: 'shell',
    rowIds: ['shell', 'bash', 'bash-sandbox', 'pwsh', 'pwsh-sandbox'],
    modules: prefixedModule(
      '@deepseek-ai/dsh-bash-',
      '@deepseek-ai/dsh-pwsh-',
    ),
  },
  {
    service: 'systemPrompt',
    rowIds: ['system-prompt', 'systemPrompt'],
    modules: exactModule('@deepseek-ai/dsh-system-prompt'),
  },
  {
    service: 'tools',
    rowIds: ['tools'],
    modules: exactModule('@deepseek-ai/dsh-tools'),
  },
  {
    service: 'skills',
    rowIds: ['skill', 'skills'],
    modules: exactModule('@deepseek-ai/dsh-skill'),
  },
  {
    service: 'fs',
    rowIds: ['fs-local', 'fs-sandbox'],
    modules: prefixedModule(
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-fs-sandbox',
    ),
  },
])

const REQUIRED_COMPOSITIONS = Object.freeze<readonly RequiredComposition[]>([
  {
    capability: 'repository instructions',
    requirements: [{
      rowIds: ['agent-instructions'],
      modules: exactModule('@deepseek-ai/dsh-agent-instructions'),
    }],
  },
  {
    capability: 'write-before-read protection',
    requirements: [{
      rowIds: ['fs-observation-policy'],
      modules: exactModule('@deepseek-ai/dsh-fs-observation-policy'),
    }],
  },
  {
    capability: 'multimodal file analysis',
    requirements: [
      {
        rowIds: ['tool-fs'],
        modules: exactModule('@deepseek-ai/dsh-tool-fs'),
      },
      {
        rowIds: ['attachment-local', 'attachments'],
        modules: prefixedModule('@deepseek-ai/dsh-attachment-'),
      },
    ],
  },
])

function diagnostic(level: DoctorDiagnosticLevel, message: string): DoctorDiagnostic {
  return Object.freeze({ level, message })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loaderRow(value: unknown, index: number): LoaderRow {
  if (!isRecord(value)) throw new Error(`Loader entry ${index + 1} is not a mapping`)
  const id = value['id']
  const name = value['name']
  const config = value['config']
  if (id !== undefined && typeof id !== 'string') {
    throw new Error(`Loader entry ${index + 1} has a non-string id`)
  }
  if (name !== undefined && typeof name !== 'string') {
    throw new Error(`Loader entry ${index + 1} has a non-string module name`)
  }
  if (config !== undefined && !isRecord(config) && !Array.isArray(config)) {
    throw new Error(`Loader entry ${index + 1} has an invalid config`)
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(isRecord(config) ? { config } : {}),
    ...(value['disabled'] === undefined ? {} : { disabled: value['disabled'] }),
  }
}

function parseRows(config: string): readonly LoaderRow[] {
  const document = parseDocument(config, { strict: true })
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message)
  const value: unknown = document.toJS()
  if (!Array.isArray(value)) throw new Error('resolved profile is not a top-level Loader entry array')
  return Object.freeze(value.map(loaderRow))
}

function activeRows(rows: readonly LoaderRow[]): readonly LoaderRow[] {
  return rows.filter(row => row.disabled !== true)
}

function countModule(rows: readonly LoaderRow[], name: string): number {
  return rows.filter(row => row.name === name).length
}

function findUniqueRow(rows: readonly LoaderRow[], id: string): LoaderRow | undefined {
  const matches = rows.filter(row => row.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

function resolvedBoolean(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean,
): ResolvedValue<boolean> {
  const configured = config[key]
  if (configured === undefined) return { valid: true, value: fallback, source: 'default' }
  return {
    valid: typeof configured === 'boolean',
    value: typeof configured === 'boolean' ? configured : fallback,
    source: 'configured',
  }
}

function resolvedNumber(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): ResolvedValue<number> {
  const configured = config[key]
  if (configured === undefined) return { valid: true, value: fallback, source: 'default' }
  return {
    valid: typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0,
    value: typeof configured === 'number' ? configured : fallback,
    source: 'configured',
  }
}

function resolvedString(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): ResolvedValue<string> {
  const configured = config[key]
  if (configured === undefined) return { valid: true, value: fallback, source: 'default' }
  return {
    valid: typeof configured === 'string',
    value: typeof configured === 'string' ? configured : fallback,
    source: 'configured',
  }
}

function installationDiagnostics(rows: readonly LoaderRow[]): readonly DoctorDiagnostic[] {
  return INSTALLATION.map((expected) => {
    const idMatches = rows.filter(row => row.id === expected.id)
    const moduleCount = countModule(rows, expected.name)
    const correctPair = idMatches.length === 1
      && idMatches[0]!.name === expected.name
      && idMatches[0]!.disabled !== true
    return correctPair && moduleCount === 1
      ? diagnostic('pass', `installation: "${expected.id}" resolves exactly once to "${expected.name}"`)
      : diagnostic(
          'fail',
          `installation: expected "${expected.id}" -> "${expected.name}" exactly once; `
            + `found ${idMatches.length} row(s), ${moduleCount} module occurrence(s)`,
        )
  })
}

function serviceConfigurationDiagnostics(row: LoaderRow | undefined): readonly DoctorDiagnostic[] {
  if (row === undefined) {
    return [
      diagnostic('fail', 'service policy: cannot inspect the unique dsh-autopilot-service row'),
      diagnostic('fail', 'long-run rounds: cannot inspect the unique dsh-autopilot-service row'),
      diagnostic('fail', 'long-run duration: cannot inspect the unique dsh-autopilot-service row'),
      diagnostic('fail', 'durable limits: cannot inspect the unique dsh-autopilot-service row'),
    ]
  }
  const config = row.config ?? {}
  const autoResume = resolvedBoolean(config, 'autoResume', SERVICE_DEFAULTS.autoResume)
  const selfModification = resolvedString(
    config,
    'selfModification',
    SERVICE_DEFAULTS.selfModification,
  )
  const policyValid = autoResume.valid
    && selfModification.valid
    && ['off', 'host-only', 'client-approved'].includes(selfModification.value)
  const policy = policyValid
    ? diagnostic(
        'pass',
        `service policy: autoResume=${String(autoResume.value)} (${autoResume.source}, `
          + `${autoResume.value ? 'automatic' : 'manual'} cold recovery); `
          + `selfModification=${selfModification.value} (${selfModification.source})`,
      )
    : diagnostic(
        'fail',
        'service policy: autoResume must resolve to a boolean and selfModification must resolve to '
          + 'off, host-only, or client-approved',
      )

  const defaultRounds = resolvedNumber(
    config,
    'defaultMaxGoalRounds',
    SERVICE_DEFAULTS.defaultMaxGoalRounds,
  )
  const maxRounds = resolvedNumber(config, 'maxGoalRounds', SERVICE_DEFAULTS.maxGoalRounds)
  const roundsValid = defaultRounds.valid
    && maxRounds.valid
    && defaultRounds.value >= LONG_RUN_DEFAULT_ROUNDS
    && maxRounds.value >= LONG_RUN_MAX_ROUNDS
    && defaultRounds.value <= maxRounds.value
  const rounds = roundsValid
    ? diagnostic(
        'pass',
        `long-run rounds: default ${defaultRounds.value}, deployment ceiling ${maxRounds.value}`,
      )
    : diagnostic(
        'fail',
        `long-run rounds: require default >=${LONG_RUN_DEFAULT_ROUNDS}, ceiling >=${LONG_RUN_MAX_ROUNDS}, `
          + 'and default <= ceiling',
      )

  const defaultActive = resolvedNumber(
    config,
    'defaultMaxActiveMs',
    SERVICE_DEFAULTS.defaultMaxActiveMs,
  )
  const maxActive = resolvedNumber(config, 'maxActiveMs', SERVICE_DEFAULTS.maxActiveMs)
  const durationValid = defaultActive.valid
    && maxActive.valid
    && defaultActive.value >= LONG_RUN_DEFAULT_ACTIVE_MS
    && maxActive.value >= LONG_RUN_MAX_ACTIVE_MS
    && defaultActive.value <= maxActive.value
  const duration = durationValid
    ? diagnostic(
        'pass',
        `long-run duration: default ${defaultActive.value}ms, deployment ceiling ${maxActive.value}ms`,
      )
    : diagnostic(
        'fail',
        `long-run duration: require default >=${LONG_RUN_DEFAULT_ACTIVE_MS}ms, `
          + `ceiling >=${LONG_RUN_MAX_ACTIVE_MS}ms, and default <= ceiling`,
      )
  const durable = {
    maxTasks: resolvedNumber(config, 'maxTasks', SERVICE_DEFAULTS.maxTasks),
    maxTaskAttempts: resolvedNumber(config, 'maxTaskAttempts', SERVICE_DEFAULTS.maxTaskAttempts),
    maxEvidenceItems: resolvedNumber(config, 'maxEvidenceItems', SERVICE_DEFAULTS.maxEvidenceItems),
    maxSnapshotBytes: resolvedNumber(config, 'maxSnapshotBytes', SERVICE_DEFAULTS.maxSnapshotBytes),
    maxAuditRecords: resolvedNumber(config, 'maxAuditRecords', SERVICE_DEFAULTS.maxAuditRecords),
    maxAuditBytes: resolvedNumber(config, 'maxAuditBytes', SERVICE_DEFAULTS.maxAuditBytes),
    maxDynamicSourceChars: resolvedNumber(
      config,
      'maxDynamicSourceChars',
      SERVICE_DEFAULTS.maxDynamicSourceChars,
    ),
  }
  const durableValid = Object.values(durable).every(value => value.valid)
    && durable.maxAuditBytes.value >= durable.maxSnapshotBytes.value
  const durableLimits = durableValid
    ? diagnostic(
        'pass',
        `durable limits: tasks ${durable.maxTasks.value}, attempts ${durable.maxTaskAttempts.value}, `
          + `evidence ${durable.maxEvidenceItems.value}, snapshot ${durable.maxSnapshotBytes.value}B, `
          + `audit ${durable.maxAuditRecords.value} records/${durable.maxAuditBytes.value}B, `
          + `dynamic source ${durable.maxDynamicSourceChars.value} chars`,
      )
    : diagnostic(
        'fail',
        'durable limits: every content ceiling must be a positive safe integer and maxAuditBytes '
          + 'must be at least maxSnapshotBytes',
      )
  return [policy, rounds, duration, durableLimits]
}

function fixedCheckCount(config: Readonly<Record<string, unknown>>): number | undefined {
  const checks = config['checks'] ?? []
  const projectChecks = config['projectChecks'] ?? []
  if (!Array.isArray(checks) || !Array.isArray(projectChecks)) return undefined
  const validChecks = checks.every(check => isRecord(check)
    && typeof check['name'] === 'string'
    && check['name'].trim().length > 0
    && typeof check['command'] === 'string'
    && check['command'].trim().length > 0)
  const validProjectChecks = projectChecks.every(check =>
    typeof check === 'string' && check.trim().length > 0)
  if (!validChecks || !validProjectChecks) return undefined
  return checks.length + projectChecks.length
}

function toolsConfigurationDiagnostic(row: LoaderRow | undefined): DoctorDiagnostic {
  if (row === undefined) {
    return diagnostic('fail', 'verification policy: cannot inspect the unique dsh-autopilot-tools row')
  }
  const config = row.config ?? {}
  const discovery = resolvedBoolean(config, 'autoDiscoverChecks', true)
  const fixedCount = fixedCheckCount(config)
  if (!discovery.valid || fixedCount === undefined || (!discovery.value && fixedCount === 0)) {
    return diagnostic(
      'fail',
      'verification policy: configure autoDiscoverChecks=true, deployment-fixed checks, or projectChecks',
    )
  }
  if (discovery.value && fixedCount === 0) {
    return diagnostic(
      'warn',
      'verification policy: automatic project-check discovery is enabled without a deployment-fixed check; '
        + 'repositories with no recognized recipe may reach reviewer verification without a deterministic check',
    )
  }
  return diagnostic(
    'pass',
    `verification policy: auto discovery ${discovery.value ? 'enabled' : 'disabled'}; `
      + `${fixedCount} deployment-fixed check selection(s)`,
  )
}

function visualQaDiagnostics(row: LoaderRow | undefined): readonly DoctorDiagnostic[] {
  if (row === undefined) {
    return [
      diagnostic('fail', 'Visual QA origins: cannot inspect the unique dsh-autopilot-visual-qa row'),
      diagnostic('fail', 'Visual QA browser: cannot inspect the unique dsh-autopilot-visual-qa row'),
    ]
  }
  const config = row.config ?? {}
  const allowed = config['allowedOrigins']
  let origins: DoctorDiagnostic
  if (allowed === undefined) {
    origins = diagnostic(
      'warn',
      'Visual QA origins: only the no-port localhost defaults are allowed; configure exact origins including development ports',
    )
  } else if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((value) => {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:')
        && url.origin === value && url.username.length === 0 && url.password.length === 0
    } catch {
      return false
    }
  })) {
    origins = diagnostic('fail', 'Visual QA origins: allowedOrigins must contain exact HTTP(S) origins')
  } else {
    origins = diagnostic('pass', `Visual QA origins: ${allowed.length} exact deployment origin(s) configured`)
  }
  const channel = config['channel']
  const executablePath = config['executablePath']
  const channelValid = channel === undefined || typeof channel === 'string'
  const executableValid = executablePath === undefined
    || (typeof executablePath === 'string' && executablePath.trim().length > 0)
  const browser = !channelValid || !executableValid || (channel !== undefined && executablePath !== undefined)
    ? diagnostic('fail', 'Visual QA browser: configure at most one valid channel or executablePath')
    : channel === undefined && executablePath === undefined
      ? diagnostic(
          'warn',
          'Visual QA browser: no system channel or executablePath is configured; install Playwright Chromium before first use',
        )
      : diagnostic(
          'pass',
          `Visual QA browser: deployment selects ${channel === undefined ? 'an executablePath' : `channel ${channel}`}`,
        )
  return [origins, browser]
}

function serviceDiagnostics(rows: readonly LoaderRow[]): readonly DoctorDiagnostic[] {
  const candidates = activeRows(rows)
  return REQUIRED_SERVICES.map((required) => {
    const found = candidates.some(row =>
      (row.id !== undefined && required.rowIds.includes(row.id))
      || (row.id !== undefined && required.rowPrefixes?.some(prefix => row.id!.startsWith(prefix)) === true)
      || (row.name !== undefined && required.modules(row.name)))
    return found
      ? diagnostic('pass', `required service: ${required.service} has an active Loader provider row`)
      : diagnostic('fail', `required service: ${required.service} has no active Loader provider row`)
  })
}

function compositionDiagnostics(rows: readonly LoaderRow[]): readonly DoctorDiagnostic[] {
  return REQUIRED_COMPOSITIONS.map((composition) => {
    const matched = composition.requirements.map(requirement => rows.find(row =>
      (row.id !== undefined && requirement.rowIds.includes(row.id))
      || (row.name !== undefined && requirement.modules(row.name))))
    if (matched.some(row => row === undefined)) {
      return diagnostic('fail', `native composition: ${composition.capability} is unavailable`)
    }
    if (matched.every(row => row?.disabled !== true)) {
      return diagnostic('pass', `native composition: ${composition.capability} is active`)
    }
    return diagnostic(
      'warn',
      `native composition: ${composition.capability} is disabled on the Host plane; `
        + 'the selected Agent preset must provide it',
    )
  })
}

function dynamicRunnerDiagnostic(
  rows: readonly LoaderRow[],
  serviceRow: LoaderRow | undefined,
): DoctorDiagnostic {
  if (serviceRow === undefined) {
    return diagnostic('fail', 'dynamic runner: cannot resolve selfModification without the service row')
  }
  const mode = resolvedString(
    serviceRow.config ?? {},
    'selfModification',
    SERVICE_DEFAULTS.selfModification,
  )
  if (!mode.valid || !['off', 'host-only', 'client-approved'].includes(mode.value)) {
    return diagnostic('fail', 'dynamic runner: selfModification mode is invalid')
  }
  const present = activeRows(rows).some(row =>
    row.id === 'cordis-host-runner'
    || row.id === 'dynamic-cordis-runner'
    || row.name === '@deepseek-ai/dsh-cordis-host-runner')
  if (mode.value === 'off') {
    return diagnostic(
      'pass',
      `dynamic runner: optional while selfModification=off (${present ? 'present' : 'not installed'})`,
    )
  }
  return present
    ? diagnostic('pass', `dynamic runner: available for selfModification=${mode.value}`)
    : diagnostic('fail', `dynamic runner: required for selfModification=${mode.value}, but no active provider row exists`)
}

/** Inspect one composed DSH profile without evaluating its `!!js` expressions. */
export function inspectResolvedProfile(config: string): readonly DoctorDiagnostic[] {
  let rows: readonly LoaderRow[]
  try {
    rows = parseRows(config)
  } catch (error: unknown) {
    return [diagnostic(
      'fail',
      `resolved profile YAML cannot be inspected: ${String(error)}`,
    )]
  }
  const serviceRow = findUniqueRow(rows, 'dsh-autopilot-service')
  const toolsRow = findUniqueRow(rows, 'dsh-autopilot-tools')
  const visualQaRow = findUniqueRow(rows, 'dsh-autopilot-visual-qa')
  return Object.freeze([
    ...installationDiagnostics(rows),
    ...serviceConfigurationDiagnostics(serviceRow),
    toolsConfigurationDiagnostic(toolsRow),
    ...visualQaDiagnostics(visualQaRow),
    ...serviceDiagnostics(rows),
    ...compositionDiagnostics(rows),
    dynamicRunnerDiagnostic(rows, serviceRow),
  ])
}
