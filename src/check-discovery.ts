/** Read-only discovery of deployment-safe project verification commands. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Maximum number of checks one discovery result may return. */
export const MAX_PROJECT_CHECKS = 12

/** Stable identifiers accepted by explicit Autopilot check configuration. */
export const PROJECT_CHECK_IDS = Object.freeze([
  'js:check',
  'js:typecheck',
  'js:lint',
  'js:test',
  'js:build',
  'python:pytest',
  'python:ruff',
  'python:mypy',
  'rust:check',
  'rust:test',
  'go:vet',
  'go:test',
] as const)

/** One finite project check recipe identifier. */
export type ProjectCheckId = typeof PROJECT_CHECK_IDS[number]

/** Supported project manifest names. */
export type ProjectManifestName = 'package.json' | 'pyproject.toml' | 'Cargo.toml' | 'go.mod'

/** JavaScript package runners selected without using manifest script contents. */
export type JavaScriptRunner = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** One fixed command that may be passed to an argv-based or string-only shell service. */
export interface ProjectCheckSpec {
  readonly id: ProjectCheckId
  readonly label: string
  /** Canonical workspace root; never a manifest-provided path. */
  readonly cwd: string
  /** Complete argv, including the executable, assembled only from trusted literals. */
  readonly argv: readonly [string, ...string[]]
  /** Trusted string equivalent for DSH shell providers that do not accept argv. */
  readonly command: string
  readonly manifest: ProjectManifestName
}

/** A supported root manifest inspected during discovery. */
export interface ProjectManifest {
  readonly name: ProjectManifestName
  readonly path: string
  /** SHA-256 of the exact root-manifest bytes used for discovery. */
  readonly sha256: string
}

/** One expected root manifest from a durable verification baseline. */
export interface ProjectManifestDigest {
  readonly name: ProjectManifestName
  readonly sha256: string
}

/** Result of comparing current root manifests with a frozen baseline. */
export interface ProjectManifestValidation {
  readonly valid: boolean
  readonly findings: readonly string[]
}

/** Finite explicit configuration; arbitrary command strings are deliberately unsupported. */
export interface ExplicitProjectCheckConfig {
  readonly checks: readonly ProjectCheckId[]
}

/** Read-only project discovery input. */
export interface ProjectCheckDiscoveryOptions {
  readonly workspace: string
  readonly explicit?: ExplicitProjectCheckConfig
  readonly maxChecks?: number
}

interface ProjectCheckDiscoveryBase {
  readonly workspace: string
  readonly manifests: readonly ProjectManifest[]
  readonly checks: readonly ProjectCheckSpec[]
  readonly omitted: readonly ProjectCheckId[]
}

/** Stable result that distinguishes no project, automatic discovery, and explicit configuration. */
export type ProjectCheckDiscovery =
  | (ProjectCheckDiscoveryBase & {
    readonly kind: 'none'
    readonly reason: 'no-supported-project'
  })
  | (ProjectCheckDiscoveryBase & {
    readonly kind: 'discovered'
  })
  | (ProjectCheckDiscoveryBase & {
    readonly kind: 'explicit'
    readonly unavailable: readonly ProjectCheckId[]
  })

interface CheckRecipe {
  readonly id: ProjectCheckId
  readonly label: string
  readonly manifest: ProjectManifestName
  readonly script?: string
  readonly argv?: readonly [string, ...string[]]
  readonly pythonTool?: 'pytest' | 'ruff' | 'mypy'
}

const MANIFEST_NAMES = Object.freeze([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
] as const satisfies readonly ProjectManifestName[])

const LOCKFILE_RUNNERS = Object.freeze([
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
] as const satisfies readonly (readonly [string, JavaScriptRunner])[])

const RECIPES = Object.freeze([
  { id: 'js:check', label: 'JavaScript check', manifest: 'package.json', script: 'check' },
  { id: 'js:typecheck', label: 'JavaScript typecheck', manifest: 'package.json', script: 'typecheck' },
  { id: 'js:lint', label: 'JavaScript lint', manifest: 'package.json', script: 'lint' },
  { id: 'js:test', label: 'JavaScript tests', manifest: 'package.json', script: 'test' },
  { id: 'js:build', label: 'JavaScript build', manifest: 'package.json', script: 'build' },
  {
    id: 'python:pytest',
    label: 'Python tests',
    manifest: 'pyproject.toml',
    argv: ['python', '-m', 'pytest'],
    pythonTool: 'pytest',
  },
  {
    id: 'python:ruff',
    label: 'Python lint',
    manifest: 'pyproject.toml',
    argv: ['python', '-m', 'ruff', 'check', '.'],
    pythonTool: 'ruff',
  },
  {
    id: 'python:mypy',
    label: 'Python typecheck',
    manifest: 'pyproject.toml',
    argv: ['python', '-m', 'mypy', '.'],
    pythonTool: 'mypy',
  },
  {
    id: 'rust:check',
    label: 'Rust check',
    manifest: 'Cargo.toml',
    argv: ['cargo', 'check', '--all-targets'],
  },
  {
    id: 'rust:test',
    label: 'Rust tests',
    manifest: 'Cargo.toml',
    argv: ['cargo', 'test', '--all-targets'],
  },
  { id: 'go:vet', label: 'Go vet', manifest: 'go.mod', argv: ['go', 'vet', './...'] },
  { id: 'go:test', label: 'Go tests', manifest: 'go.mod', argv: ['go', 'test', './...'] },
] as const satisfies readonly CheckRecipe[])

const RECIPE_BY_ID = new Map<ProjectCheckId, CheckRecipe>(RECIPES.map(recipe => [recipe.id, recipe]))
const MAX_MANIFEST_BYTES = 1024 * 1024

type RootEntries = ReadonlyMap<string, import('node:fs').Dirent>

interface RootFileContent {
  readonly text: string
  readonly sha256: string
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  if (workspace.length === 0) throw new Error('Autopilot check workspace must not be empty')
  const canonical = await realpath(resolve(workspace))
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Autopilot check workspace is not a directory: ${canonical}`)
  }
  return canonical
}

async function rootEntries(workspace: string): Promise<RootEntries> {
  return new Map((await readdir(workspace, { withFileTypes: true })).map(entry => [entry.name, entry]))
}

function manifestPath(workspace: string, name: string): string {
  return join(workspace, name)
}

async function readRootFile(
  workspace: string,
  entries: RootEntries,
  name: string,
): Promise<RootFileContent | undefined> {
  const entry = entries.get(name)
  if (entry === undefined) return undefined
  if (!entry.isFile()) throw new Error(`Autopilot check manifest must be a regular file: ${name}`)
  const path = manifestPath(workspace, name)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (metadata.size > MAX_MANIFEST_BYTES) {
      throw new Error(`Autopilot check manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${name}`)
    }
    const bytes = await handle.readFile()
    return Object.freeze({
      text: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  } finally {
    await handle.close()
  }
}

function packageRunner(packageJson: Record<string, unknown>, entries: RootEntries): JavaScriptRunner {
  const declared = packageJson.packageManager
  if (typeof declared === 'string') {
    for (const runner of ['pnpm', 'npm', 'yarn', 'bun'] as const) {
      if (declared === runner || declared.startsWith(`${runner}@`)) return runner
    }
  }
  for (const [name, runner] of LOCKFILE_RUNNERS) {
    if (entries.get(name)?.isFile() === true) return runner
  }
  return 'npm'
}

function packageScriptArgv(runner: JavaScriptRunner, script: string): readonly [string, ...string[]] {
  return [runner, 'run', script]
}

const PYTHON_TOOL_PATTERNS = Object.freeze({
  pytest: Object.freeze([
    /^\s*\[{1,2}\s*tool\.pytest(?:\.|\s*\])/u,
    /["']pytest(?:\[[^"']*\])?(?:\s*[<>=!~^].*)?["']/u,
    /^\s*pytest\s*=/u,
  ]),
  ruff: Object.freeze([
    /^\s*\[{1,2}\s*tool\.ruff(?:\.|\s*\])/u,
    /["']ruff(?:\[[^"']*\])?(?:\s*[<>=!~^].*)?["']/u,
    /^\s*ruff\s*=/u,
  ]),
  mypy: Object.freeze([
    /^\s*\[{1,2}\s*tool\.mypy(?:\.|\s*\])/u,
    /["']mypy(?:\[[^"']*\])?(?:\s*[<>=!~^].*)?["']/u,
    /^\s*mypy\s*=/u,
  ]),
})

function pythonTools(pyproject: string): ReadonlySet<'pytest' | 'ruff' | 'mypy'> {
  const tools = new Set<'pytest' | 'ruff' | 'mypy'>()
  for (const originalLine of pyproject.split(/\r?\n/u)) {
    const line = originalLine.replace(/#.*$/u, '')
    for (const tool of ['pytest', 'ruff', 'mypy'] as const) {
      if (PYTHON_TOOL_PATTERNS[tool].some(pattern => pattern.test(line))) tools.add(tool)
    }
  }
  return tools
}

function explicitRecipes(config: ExplicitProjectCheckConfig): readonly CheckRecipe[] {
  const recipes: CheckRecipe[] = []
  const seen = new Set<ProjectCheckId>()
  for (const id of config.checks) {
    const recipe = RECIPE_BY_ID.get(id)
    if (recipe === undefined) {
      throw new Error(`Unsupported explicit Autopilot check id: ${String(id)}`)
    }
    if (!seen.has(id)) {
      recipes.push(recipe)
      seen.add(id)
    }
  }
  return recipes
}

function resolveLimit(value: number | undefined): number {
  const limit = value ?? MAX_PROJECT_CHECKS
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECT_CHECKS) {
    throw new Error(`Autopilot maxChecks must be an integer from 1 to ${MAX_PROJECT_CHECKS}`)
  }
  return limit
}

function availableRecipe(
  recipe: CheckRecipe,
  manifests: ReadonlySet<ProjectManifestName>,
  scripts: ReadonlySet<string>,
  tools: ReadonlySet<'pytest' | 'ruff' | 'mypy'>,
): boolean {
  if (!manifests.has(recipe.manifest)) return false
  if (recipe.script !== undefined) return scripts.has(recipe.script)
  if (recipe.pythonTool !== undefined) return tools.has(recipe.pythonTool)
  return true
}

function commandSpec(
  recipe: CheckRecipe,
  workspace: string,
  runner: JavaScriptRunner,
): ProjectCheckSpec {
  const argv = recipe.script === undefined
    ? recipe.argv!
    : packageScriptArgv(runner, recipe.script)
  return Object.freeze({
    id: recipe.id,
    label: recipe.label,
    cwd: workspace,
    argv: Object.freeze([...argv]) as unknown as readonly [string, ...string[]],
    command: argv.join(' '),
    manifest: recipe.manifest,
  })
}

/**
 * Inspect only supported root manifests and return finite, non-executed check commands.
 *
 * The function never accepts a command, argument, script name, or working directory
 * from model output. Explicit configuration selects only stable recipe identifiers.
 *
 * @param options - Canonical workspace, optional finite configuration, and result cap.
 * @returns An immutable discovery result whose command strings use trusted templates.
 */
export async function discoverProjectChecks(
  options: ProjectCheckDiscoveryOptions,
): Promise<ProjectCheckDiscovery> {
  const workspace = await canonicalWorkspace(options.workspace)
  const entries = await rootEntries(workspace)
  const contents = new Map<ProjectManifestName, string>()
  const manifestRows: ProjectManifest[] = []
  for (const name of MANIFEST_NAMES) {
    const content = await readRootFile(workspace, entries, name)
    if (content !== undefined) {
      contents.set(name, content.text)
      manifestRows.push(Object.freeze({
        name,
        path: manifestPath(workspace, name),
        sha256: content.sha256,
      }))
    }
  }
  const manifests = new Set(contents.keys())
  const rawPackage = contents.get('package.json')
  const packageJson = rawPackage === undefined
    ? {}
    : ownRecord(JSON.parse(rawPackage))
  if (packageJson === undefined) {
    throw new Error('Autopilot package.json must contain a JSON object')
  }
  const scriptsRecord = ownRecord(packageJson?.scripts)
  const scripts = new Set(Object.entries(scriptsRecord ?? {})
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name]) => name))
  const tools = pythonTools(contents.get('pyproject.toml') ?? '')
  const runner = packageRunner(packageJson, entries)
  const requested = options.explicit === undefined ? RECIPES : explicitRecipes(options.explicit)
  const available = requested.filter(recipe => availableRecipe(recipe, manifests, scripts, tools))
  const unavailable = requested.filter(recipe => !availableRecipe(recipe, manifests, scripts, tools))
    .map(recipe => recipe.id)
  const limit = resolveLimit(options.maxChecks)
  const selected = available.slice(0, limit)
  const omitted = available.slice(limit).map(recipe => recipe.id)
  const base = {
    workspace,
    manifests: Object.freeze(manifestRows),
    checks: Object.freeze(selected.map(recipe => commandSpec(recipe, workspace, runner))),
    omitted: Object.freeze(omitted),
  }
  if (options.explicit !== undefined) {
    return Object.freeze({ ...base, kind: 'explicit', unavailable: Object.freeze(unavailable) })
  }
  if (manifests.size === 0) {
    return Object.freeze({ ...base, kind: 'none', reason: 'no-supported-project' })
  }
  return Object.freeze({ ...base, kind: 'discovered' })
}

/**
 * Compare current supported root manifests with the exact bytes used for discovery.
 *
 * Missing, replaced, non-regular, oversized, unreadable, or changed manifests are
 * reported as deterministic findings rather than accepted through rediscovery.
 *
 * @param workspace - Canonical workspace recorded in the durable baseline.
 * @param expected - Frozen manifest names and digests.
 * @returns An immutable validation result suitable for the independent verifier.
 */
export async function validateProjectManifests(
  workspace: string,
  expected: readonly ProjectManifestDigest[],
): Promise<ProjectManifestValidation> {
  const findings: string[] = []
  let canonical: string
  try {
    canonical = await canonicalWorkspace(workspace)
  } catch (error: unknown) {
    return Object.freeze({
      valid: false,
      findings: Object.freeze([`verification workspace is unavailable: ${String(error)}`]),
    })
  }
  if (canonical !== workspace) {
    findings.push(`verification workspace identity changed: expected ${workspace}, found ${canonical}`)
  }
  let entries: RootEntries
  try {
    entries = await rootEntries(canonical)
  } catch (error: unknown) {
    /* v8 ignore next -- only an external directory race can fail after canonicalWorkspace succeeded. */
    return Object.freeze({
      valid: false,
      findings: Object.freeze([...findings, `verification workspace cannot be inspected: ${String(error)}`]),
    })
  }
  for (const manifest of expected) {
    try {
      const content = await readRootFile(canonical, entries, manifest.name)
      if (content === undefined) {
        findings.push(`verification manifest ${manifest.name} was removed after the baseline was frozen`)
      } else {
        const actual = content.sha256
        if (actual !== manifest.sha256) {
          findings.push(
            `verification manifest ${manifest.name} changed after the baseline was frozen `
            + `(expected sha256 ${manifest.sha256}, found ${actual})`,
          )
        }
      }
    } catch (error: unknown) {
      findings.push(`verification manifest ${manifest.name} cannot be validated: ${String(error)}`)
    }
  }
  return Object.freeze({ valid: findings.length === 0, findings: Object.freeze(findings) })
}
