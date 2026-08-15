import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { inspectResolvedProfile } from '../../src/doctor-config.ts'

const AUTOPILOT_ROWS = [
  ['dsh-autopilot-service', 'dsh-autopilot/service'],
  ['dsh-autopilot-notifications', 'dsh-autopilot/notification-service'],
  ['dsh-autopilot-workflows', 'dsh-autopilot/workflow-service'],
  ['dsh-autopilot-lifecycle-hooks', 'dsh-autopilot/lifecycle-hooks'],
  ['dsh-autopilot-run-dashboard', 'dsh-autopilot/run-dashboard-service'],
  ['dsh-autopilot-team', 'dsh-autopilot/team-service'],
  ['dsh-autopilot-ralph', 'dsh-autopilot/ralph-service'],
  ['dsh-autopilot-missions', 'dsh-autopilot/mission-service'],
  ['dsh-autopilot-delivery', 'dsh-autopilot/delivery-service'],
  ['dsh-autopilot-commands', 'dsh-autopilot/commands'],
  ['dsh-autopilot-tools', 'dsh-autopilot/tools'],
  ['dsh-autopilot-tool-delivery', 'dsh-autopilot/tool-delivery'],
  ['dsh-autopilot-code-intelligence', 'dsh-autopilot/code-intelligence'],
  ['dsh-autopilot-visual-qa', 'dsh-autopilot/visual-qa'],
  ['dsh-autopilot-memory', 'dsh-autopilot/memory'],
  ['dsh-autopilot-tool-memory', 'dsh-autopilot/tool-memory'],
  ['dsh-autopilot-prompt-rules', 'dsh-autopilot/prompt-rules'],
  ['dsh-autopilot-custom-commands', 'dsh-autopilot/custom-commands'],
  ['dsh-autopilot-skills', 'dsh-autopilot/skills'],
  ['dsh-autopilot-skill-mcp', 'dsh-autopilot/skill-mcp'],
  ['dsh-autopilot-recovery-coordinator', 'dsh-autopilot/recovery-coordinator'],
] as const

const REQUIRED_ROWS = [
  ['storage-domain', '@deepseek-ai/dsh-storage-domain'],
  ['session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'],
  ['agent', '@deepseek-ai/dsh-agent'],
  ['session', '@deepseek-ai/dsh-session'],
  ['commands', '@deepseek-ai/dsh-commands'],
  ['goal', '@deepseek-ai/dsh-goal'],
  ['subagent', '@deepseek-ai/dsh-subagent'],
  ['subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-spawn-in-process'],
  ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox'],
  ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
  ['tools', '@deepseek-ai/dsh-tools'],
  ['skill', '@deepseek-ai/dsh-skill'],
  ['fs-sandbox', '@deepseek-ai/dsh-fs-sandbox'],
  ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
  ['fs-observation-policy', '@deepseek-ai/dsh-fs-observation-policy'],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['attachment-local', '@deepseek-ai/dsh-attachment-local'],
] as const

interface ProfileOptions {
  readonly serviceConfig?: readonly string[]
  readonly toolsConfig?: readonly string[]
  readonly visualQaConfig?: readonly string[]
  readonly dynamicRunner?: 'absent' | 'active' | 'disabled'
  readonly autopilotRows?: readonly (readonly [string, string])[]
  readonly requiredRows?: readonly (readonly [string, string])[]
}

function profile(options: ProfileOptions = {}): string {
  const serviceConfig = options.serviceConfig ?? [
    'autoResume: true',
    'selfModification: off',
    'defaultMaxGoalRounds: 1024',
    'maxGoalRounds: 4096',
    'defaultMaxActiveMs: 604800000',
    'maxActiveMs: 2592000000',
  ]
  const toolsConfig = options.toolsConfig ?? [
    'autoDiscoverChecks: false',
    'projectChecks: [js:test]',
  ]
  const visualQaConfig = options.visualQaConfig ?? [
    'allowedOrigins: [http://127.0.0.1:4173]',
    'channel: msedge',
  ]
  const autopilotRows = (options.autopilotRows ?? AUTOPILOT_ROWS).map(([id, name]) => [
    id,
    name,
    id === 'dsh-autopilot-service'
      ? serviceConfig
      : id === 'dsh-autopilot-tools'
        ? toolsConfig
        : id === 'dsh-autopilot-visual-qa'
          ? visualQaConfig
        : id === 'dsh-autopilot-notifications'
          ? ['enabled: false']
          : undefined,
  ] as const)
  const rows = [
    ...autopilotRows,
    ...(options.requiredRows ?? REQUIRED_ROWS),
  ] as const
  const rendered = rows.flatMap(([id, name, config]) => [
    `- id: ${id}`,
    `  name: '${name}'`,
    ...(config === undefined || config.length === 0
      ? []
      : ['  config:', ...config.map(line => `    ${line}`)]),
  ])
  if (options.dynamicRunner === 'active') {
    rendered.push('- id: cordis-host-runner', "  name: '@deepseek-ai/dsh-cordis-host-runner'")
  } else if (options.dynamicRunner === 'disabled') {
    rendered.push(
      '- id: cordis-host-runner',
      "  name: '@deepseek-ai/dsh-cordis-host-runner'",
      '  disabled: true',
    )
  }
  return `${rendered.join('\n')}\n`
}

function bundledAutopilotRows(): readonly (readonly [string, string])[] {
  const document = parseDocument(
    readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'),
    { strict: true },
  )
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message)
  const operations = document.toJS() as readonly {
    readonly insert?: readonly {
      readonly id?: unknown
      readonly name?: unknown
    }[]
  }[]
  return operations.flatMap(operation => operation.insert ?? [])
    .filter((row): row is { readonly id: string; readonly name: string } =>
      typeof row.id === 'string'
      && row.id.startsWith('dsh-autopilot-')
      && typeof row.name === 'string')
    .map(row => [row.id, row.name] as const)
}

function levels(config: string): readonly string[] {
  return inspectResolvedProfile(config).map(item => item.level)
}

function messages(config: string, level?: string): readonly string[] {
  return inspectResolvedProfile(config)
    .filter(item => level === undefined || item.level === level)
    .map(item => item.message)
}

describe('doctor resolved-profile inspection', () => {
  it('passes a structurally complete profile and treats the off-mode runner as optional', () => {
    const result = inspectResolvedProfile(profile())

    expect(result.every(item => item.level === 'pass')).toBe(true)
    expect(result).toContainEqual({
      level: 'pass',
      message: 'dynamic runner: optional while selfModification=off (not installed)',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.every(Object.isFrozen)).toBe(true)
  })

  it('keeps the required installation manifest synchronized with the semantic bundle patch', () => {
    expect(bundledAutopilotRows()).toEqual(AUTOPILOT_ROWS)

    const installation = inspectResolvedProfile(profile())
      .filter(item => item.message.startsWith('installation:'))

    expect(installation).toHaveLength(AUTOPILOT_ROWS.length)
    expect(installation).toEqual(AUTOPILOT_ROWS.map(([id, name]) => ({
      level: 'pass',
      message: `installation: "${id}" resolves exactly once to "${name}"`,
    })))
  })

  it.each(AUTOPILOT_ROWS)('fails when bundled row %s is absent', (missingId) => {
    const autopilotRows = AUTOPILOT_ROWS.filter(([id]) => id !== missingId)

    expect(messages(profile({ autopilotRows }), 'fail')).toContainEqual(
      expect.stringContaining(`"${missingId}"`),
    )
  })

  it.each(AUTOPILOT_ROWS)('fails when bundled row %s is paired with another module', (id) => {
    const autopilotRows = AUTOPILOT_ROWS.map(([rowId, name]) =>
      [rowId, rowId === id ? 'not-dsh-autopilot/a-decoy' : name] as const)

    expect(messages(profile({ autopilotRows }), 'fail')).toContainEqual(
      expect.stringContaining(`"${id}"`),
    )
  })

  it('parses unresolved !!js scalars and quoted module names without substring matches', () => {
    const config = profile({
      requiredRows: [
        ...REQUIRED_ROWS.filter(([id]) => id !== 'tools'),
        ['not-tools', '@deepseek-ai/dsh-tools-extra'],
      ],
      toolsConfig: ['autoDiscoverChecks: !!js process.env.AUTO_CHECKS'],
    })

    expect(messages(config, 'fail')).toEqual(expect.arrayContaining([
      expect.stringContaining('verification policy'),
      'required service: tools has no active Loader provider row',
    ]))
  })

  it('ignores structurally valid Loader rows that carry neither an id nor a module name', () => {
    const config = `${profile()}- disabled: true\n`

    expect(messages(config, 'fail')).toEqual([])
  })

  it.each([
    ['syntax error', '- id: [\n', 'resolved profile YAML cannot be inspected:'],
    ['non-array document', 'id: row\nname: module\n', 'top-level Loader entry array'],
    ['non-mapping entry', '- scalar\n', 'Loader entry 1 is not a mapping'],
    ['non-string id', '- id: 1\n  name: module\n', 'non-string id'],
    ['non-string name', '- id: row\n  name: 1\n', 'non-string module name'],
    ['invalid config', '- id: row\n  name: module\n  config: 1\n', 'invalid config'],
  ])('fails cleanly for %s', (_case, config, expected) => {
    expect(inspectResolvedProfile(config)).toEqual([
      { level: 'fail', message: expect.stringContaining(expected) },
    ])
  })

  it('requires every Autopilot installation row and module to be one correctly paired occurrence', () => {
    const config = profile().replace(
      "- id: dsh-autopilot-commands\n  name: 'dsh-autopilot/commands'",
      "- id: dsh-autopilot-commands\n  name: 'dsh-autopilot/tools'",
    )

    expect(messages(config, 'fail')).toEqual(expect.arrayContaining([
      expect.stringContaining('dsh-autopilot-commands'),
      expect.stringContaining('dsh-autopilot-tools'),
    ]))
  })

  it('rejects a uniquely installed but explicitly disabled Autopilot row', () => {
    const config = profile().replace(
      "- id: dsh-autopilot-skills\n  name: 'dsh-autopilot/skills'",
      "- id: dsh-autopilot-skills\n  name: 'dsh-autopilot/skills'\n  disabled: true",
    )

    expect(messages(config, 'fail')).toContainEqual(expect.stringContaining('dsh-autopilot-skills'))
  })

  it('fails service-dependent checks when the service row is duplicated', () => {
    const duplicate = `${profile()}- id: dsh-autopilot-service\n  name: dsh-autopilot/service\n`

    expect(messages(duplicate, 'fail')).toEqual(expect.arrayContaining([
      expect.stringContaining('installation:'),
      'service policy: cannot inspect the unique dsh-autopilot-service row',
      'long-run rounds: cannot inspect the unique dsh-autopilot-service row',
      'long-run duration: cannot inspect the unique dsh-autopilot-service row',
      'durable limits: cannot inspect the unique dsh-autopilot-service row',
      'dynamic runner: cannot resolve selfModification without the service row',
    ]))
  })

  it.each([
    [['autoResume: yes', 'selfModification: off'], 'service policy'],
    [['autoResume: true', 'selfModification: unsafe'], 'service policy'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxGoalRounds: 1023',
      'maxGoalRounds: 4096',
    ], 'long-run rounds'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxGoalRounds: 4097',
      'maxGoalRounds: 4096',
    ], 'long-run rounds'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxGoalRounds: nope',
      'maxGoalRounds: 4096',
    ], 'long-run rounds'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxActiveMs: 604799999',
      'maxActiveMs: 2592000000',
    ], 'long-run duration'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxActiveMs: 2592000001',
      'maxActiveMs: 2592000000',
    ], 'long-run duration'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxActiveMs: nope',
      'maxActiveMs: 2592000000',
    ], 'long-run duration'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxGoalRounds: 1024',
      'maxGoalRounds: 4096',
      'defaultMaxActiveMs: 604800000',
      'maxActiveMs: 2592000000',
      'maxTasks: nope',
    ], 'durable limits'],
    [[
      'autoResume: true',
      'selfModification: off',
      'defaultMaxGoalRounds: 1024',
      'maxGoalRounds: 4096',
      'defaultMaxActiveMs: 604800000',
      'maxActiveMs: 2592000000',
      'maxSnapshotBytes: 2048',
      'maxAuditBytes: 1024',
    ], 'durable limits'],
  ])('rejects unsafe or short service configuration %#', (serviceConfig, expected) => {
    expect(messages(profile({ serviceConfig }), 'fail')).toContainEqual(expect.stringContaining(expected))
  })

  it('reports manual cold recovery as a supported non-warning policy', () => {
    const result = inspectResolvedProfile(profile({ serviceConfig: [
      'autoResume: false',
      'selfModification: off',
      'defaultMaxGoalRounds: 1024',
      'maxGoalRounds: 4096',
      'defaultMaxActiveMs: 604800000',
      'maxActiveMs: 2592000000',
    ] }))

    expect(result).toContainEqual({
      level: 'pass',
      message: 'service policy: autoResume=false (configured, manual cold recovery); '
        + 'selfModification=off (configured)',
    })
    expect(result.every(item => item.level === 'pass')).toBe(true)
  })

  it('applies service defaults before evaluating readiness', () => {
    const result = messages(profile({ serviceConfig: [] }))

    expect(result).toContainEqual(expect.stringContaining('service policy'))
    expect(result).toContainEqual(expect.stringContaining('long-run rounds'))
    expect(result).toContain('long-run duration: default 604800000ms, deployment ceiling 2592000000ms')
  })

  it('warns only when check discovery has no deployment-fixed selection', () => {
    const result = inspectResolvedProfile(profile({ toolsConfig: ['autoDiscoverChecks: true'] }))

    expect(result.filter(item => item.level === 'warn')).toEqual([{
      level: 'warn',
      message: expect.stringContaining('automatic project-check discovery'),
    }])
    expect(result.some(item => item.level === 'fail')).toBe(false)
  })

  it('reports explicit Visual QA provisioning and warns for the shipped safe defaults', () => {
    const configured = inspectResolvedProfile(profile())
    expect(configured).toContainEqual({
      level: 'pass',
      message: 'Visual QA origins: 1 exact deployment origin(s) configured',
    })
    expect(configured).toContainEqual({
      level: 'pass',
      message: 'Visual QA browser: deployment selects channel msedge',
    })

    const executable = inspectResolvedProfile(profile({
      visualQaConfig: ['allowedOrigins: [https://example.test]', 'executablePath: /browser'],
    }))
    expect(executable).toContainEqual({
      level: 'pass',
      message: 'Visual QA browser: deployment selects an executablePath',
    })

    const defaults = inspectResolvedProfile(profile({ visualQaConfig: [] }))
    expect(defaults.filter(item => item.level === 'warn')).toEqual([
      { level: 'warn', message: expect.stringContaining('no-port localhost defaults') },
      { level: 'warn', message: expect.stringContaining('install Playwright Chromium') },
    ])
    expect(defaults.some(item => item.level === 'fail')).toBe(false)
  })

  it.each([
    [['allowedOrigins: []'], 'allowedOrigins'],
    [['allowedOrigins: [42]'], 'allowedOrigins'],
    [['allowedOrigins: [not-an-origin]'], 'allowedOrigins'],
    [['allowedOrigins: [ftp://example.test]', 'channel: chrome'], 'allowedOrigins'],
    [['allowedOrigins: [https://example.test/path]', 'channel: chrome'], 'allowedOrigins'],
    [['allowedOrigins: [https://example.test]', 'channel: 42'], 'configure at most one'],
    [['allowedOrigins: [https://example.test]', "executablePath: ''"], 'configure at most one'],
    [[
      'allowedOrigins: [https://example.test]',
      'channel: chrome',
      'executablePath: /browser',
    ], 'configure at most one'],
  ] as const)('fails invalid Visual QA readiness %#', (visualQaConfig, expected) => {
    expect(messages(profile({ visualQaConfig }), 'fail')).toContainEqual(expect.stringContaining(expected))
  })

  it.each([
    [['autoDiscoverChecks: false'], 'configure autoDiscoverChecks=true'],
    [['autoDiscoverChecks: no', 'checks: []'], 'configure autoDiscoverChecks=true'],
    [['autoDiscoverChecks: true', 'checks: invalid'], 'configure autoDiscoverChecks=true'],
    [['autoDiscoverChecks: true', 'projectChecks: invalid'], 'configure autoDiscoverChecks=true'],
    [['autoDiscoverChecks: true', 'checks: [invalid]'], 'configure autoDiscoverChecks=true'],
    [[
      'autoDiscoverChecks: true',
      'checks:',
      '  - name: ""',
      '    command: pnpm test',
    ], 'configure autoDiscoverChecks=true'],
    [[
      'autoDiscoverChecks: true',
      'checks:',
      '  - name: test',
      '    command: ""',
    ], 'configure autoDiscoverChecks=true'],
    [['autoDiscoverChecks: true', 'projectChecks: [""]'], 'configure autoDiscoverChecks=true'],
  ])('fails an unusable verification policy %#', (toolsConfig, expected) => {
    expect(messages(profile({ toolsConfig }), 'fail')).toContainEqual(expect.stringContaining(expected))
  })

  it('accepts direct fixed checks without automatic discovery', () => {
    expect(messages(profile({
      toolsConfig: [
        'autoDiscoverChecks: false',
        'checks:',
        '  - name: deployment-test',
        '    command: pnpm test',
      ],
    }))).toContain('verification policy: auto discovery disabled; 1 deployment-fixed check selection(s)')
  })

  it('accepts fixed project recipes together with automatic discovery', () => {
    expect(messages(profile({
      toolsConfig: [
        'autoDiscoverChecks: true',
        'projectChecks: [js:test]',
      ],
    }))).toContain('verification policy: auto discovery enabled; 1 deployment-fixed check selection(s)')
  })

  it('applies the automatic-discovery default when the tools config is omitted', () => {
    expect(messages(profile({ toolsConfig: [] }), 'warn')).toContainEqual(
      expect.stringContaining('automatic project-check discovery'),
    )
  })

  it('fails tools policy inspection when the tools row is duplicated', () => {
    const duplicate = `${profile()}- id: dsh-autopilot-tools\n  name: dsh-autopilot/tools\n`

    expect(messages(duplicate, 'fail')).toContain(
      'verification policy: cannot inspect the unique dsh-autopilot-tools row',
    )
  })

  it('recognizes service evidence by canonical row id or exact module family and rejects disabled rows', () => {
    const byIds = REQUIRED_ROWS.map(([id]) => [id, 'custom/provider'] as const)
    expect(messages(profile({ requiredRows: byIds }), 'fail')).toEqual([])

    const disabled = profile().replace(
      "- id: goal\n  name: '@deepseek-ai/dsh-goal'",
      "- id: goal\n  name: '@deepseek-ai/dsh-goal'\n  disabled: true",
    )
    expect(messages(disabled, 'fail')).toContain('required service: goals has no active Loader provider row')
  })

  it('does not mistake shellEnv for a shell executor provider', () => {
    const withoutShell = REQUIRED_ROWS.filter(([id]) => id !== 'bash-sandbox')
    const config = `${profile({ requiredRows: withoutShell })}- id: shell-env\n  name: '@deepseek-ai/dsh-shell-env'\n`

    expect(messages(config, 'fail')).toContain('required service: shell has no active Loader provider row')
  })

  it.each([
    ['agent-instructions', 'repository instructions'],
    ['fs-observation-policy', 'write-before-read protection'],
    ['tool-fs', 'multimodal file analysis'],
    ['attachment-local', 'multimodal file analysis'],
  ])('fails when native composition row %s is unavailable', (rowId, capability) => {
    const requiredRows = REQUIRED_ROWS.filter(([id]) => id !== rowId)

    expect(messages(profile({ requiredRows }), 'fail')).toContain(
      `native composition: ${capability} is unavailable`,
    )
  })

  it('warns when an Agent-plane native composition is declared but disabled on the Host', () => {
    const disabled = profile().replace(
      "- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'",
      "- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n  disabled: true",
    )

    expect(messages(disabled, 'warn')).toContain(
      'native composition: repository instructions is disabled on the Host plane; '
        + 'the selected Agent preset must provide it',
    )
    expect(messages(disabled, 'fail')).toEqual([])
  })

  it.each(['host-only', 'client-approved'])('requires the dynamic runner in %s mode', (mode) => {
    const serviceConfig = [
      'autoResume: true',
      `selfModification: ${mode}`,
      'defaultMaxGoalRounds: 1024',
      'maxGoalRounds: 4096',
      'defaultMaxActiveMs: 604800000',
      'maxActiveMs: 2592000000',
    ]

    expect(messages(profile({ serviceConfig }), 'fail')).toContainEqual(expect.stringContaining('dynamic runner'))
    expect(messages(profile({ serviceConfig, dynamicRunner: 'disabled' }), 'fail'))
      .toContainEqual(expect.stringContaining('dynamic runner'))
    expect(messages(profile({ serviceConfig, dynamicRunner: 'active' }), 'fail')).toEqual([])
  })

  it('reports an invalid dynamic mode independently of service readiness', () => {
    const serviceConfig = [
      'autoResume: true',
      'selfModification: 1',
      'defaultMaxGoalRounds: 1024',
      'maxGoalRounds: 4096',
      'defaultMaxActiveMs: 604800000',
      'maxActiveMs: 2592000000',
    ]

    expect(messages(profile({ serviceConfig }), 'fail')).toContain('dynamic runner: selfModification mode is invalid')
  })

  it('reports an installed optional runner while dynamic modification is off', () => {
    expect(messages(profile({ dynamicRunner: 'active' }))).toContain(
      'dynamic runner: optional while selfModification=off (present)',
    )
    expect(levels(profile({ dynamicRunner: 'active' }))).not.toContain('fail')
  })
})
