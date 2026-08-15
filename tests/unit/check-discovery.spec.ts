import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_CHECKS,
  discoverProjectChecks,
  validateProjectManifests,
} from '../../src/check-discovery.ts'
import type { ProjectCheckId } from '../../src/check-discovery.ts'

const temporaryRoots: string[] = []

async function workspace(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-checks-'))
  const canonical = await realpath(root)
  temporaryRoots.push(canonical)
  for (const [name, content] of Object.entries(files)) await writeFile(join(canonical, name), content)
  return canonical
}

function packageJson(options: {
  readonly packageManager?: unknown
  readonly scripts?: unknown
} = {}): string {
  return JSON.stringify(options)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('project check discovery', () => {
  it('distinguishes an empty workspace from an explicitly empty configuration', async () => {
    const root = await workspace()

    await expect(discoverProjectChecks({ workspace: root })).resolves.toEqual({
      kind: 'none',
      reason: 'no-supported-project',
      workspace: root,
      manifests: [],
      checks: [],
      omitted: [],
    })
    await expect(discoverProjectChecks({ workspace: root, explicit: { checks: [] } })).resolves.toEqual({
      kind: 'explicit',
      workspace: root,
      manifests: [],
      checks: [],
      omitted: [],
      unavailable: [],
    })
  })

  it('discovers every supported ecosystem in a stable bounded order', async () => {
    const root = await workspace({
      'package.json': packageJson({
        packageManager: 'pnpm@11.7.0',
        scripts: {
          check: 'arbitrary project code',
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'vitest run',
          build: 'tsc',
          empty: '',
          numeric: 3,
        },
      }),
      'pyproject.toml': [
        '[tool.pytest.ini_options]',
        'addopts = "-q"',
        'dependencies = ["ruff>=0.6"]',
        'mypy = "^1.11"',
      ].join('\n'),
      'Cargo.toml': '[package]\nname = "demo"\n',
      'go.mod': 'module example.test/demo\n',
    })

    const result = await discoverProjectChecks({ workspace: root })

    expect(result.kind).toBe('discovered')
    expect(result.manifests).toEqual([
      { name: 'package.json', path: join(root, 'package.json'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { name: 'pyproject.toml', path: join(root, 'pyproject.toml'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { name: 'Cargo.toml', path: join(root, 'Cargo.toml'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { name: 'go.mod', path: join(root, 'go.mod'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ])
    expect(result.checks.map(check => check.id)).toEqual([
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
    ])
    expect(result.checks.map(check => check.command)).toEqual([
      'pnpm run check',
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run test',
      'pnpm run build',
      'python -m pytest',
      'python -m ruff check .',
      'python -m mypy .',
      'cargo check --all-targets',
      'cargo test --all-targets',
      'go vet ./...',
      'go test ./...',
    ])
    expect(result.checks.every(check => check.cwd === root)).toBe(true)
    expect(result.checks.every(check => check.command === check.argv.join(' '))).toBe(true)
    expect(result.omitted).toEqual([])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.checks)).toBe(true)
    expect(result.checks.every(check => Object.isFrozen(check) && Object.isFrozen(check.argv))).toBe(true)
  })

  it.each([
    ['pnpm@10.0.0', undefined, 'pnpm'],
    ['npm', undefined, 'npm'],
    ['yarn@4.0.0', undefined, 'yarn'],
    ['bun@1.2.0', undefined, 'bun'],
    ['unknown@1', 'pnpm-lock.yaml', 'pnpm'],
    [42, 'yarn.lock', 'yarn'],
    [undefined, 'bun.lock', 'bun'],
    [undefined, 'bun.lockb', 'bun'],
    [undefined, 'package-lock.json', 'npm'],
    [undefined, 'npm-shrinkwrap.json', 'npm'],
    [undefined, undefined, 'npm'],
  ] as const)('selects a fixed JavaScript runner %#', async (declared, marker, expected) => {
    const root = await workspace({
      'package.json': packageJson({ packageManager: declared, scripts: { test: 'ignored' } }),
      ...(marker === undefined ? {} : { [marker]: '' }),
    })

    const result = await discoverProjectChecks({ workspace: root })

    expect(result.checks).toMatchObject([{
      id: 'js:test',
      argv: [expected, 'run', 'test'],
      command: `${expected} run test`,
    }])
  })

  it('ignores untrusted manager and script strings when building commands', async () => {
    const root = await workspace({
      'package.json': packageJson({
        packageManager: 'pnpm; touch /tmp/not-allowed',
        scripts: { test: 'touch /tmp/not-allowed && false' },
      }),
    })

    const result = await discoverProjectChecks({ workspace: root })

    expect(result.checks[0]).toMatchObject({
      argv: ['npm', 'run', 'test'],
      command: 'npm run test',
      cwd: root,
    })
    expect(JSON.stringify(result.checks)).not.toContain('touch')
  })

  it('recognizes Python tools only when pyproject declares them', async () => {
    const root = await workspace({
      'pyproject.toml': [
        '# dependencies = ["pytest", "ruff", "mypy"]',
        'dependencies = ["pytest[asyncio]>=8"]',
        '[tool.ruff]',
        '[[tool.mypy.overrides]]',
      ].join('\r\n'),
    })

    expect((await discoverProjectChecks({ workspace: root })).checks.map(check => check.id)).toEqual([
      'python:pytest', 'python:ruff', 'python:mypy',
    ])

    const absent = await workspace({
      'pyproject.toml': '# pytest = "8"\n[project]\nname = "no-tools"\n',
    })
    const result = await discoverProjectChecks({ workspace: absent })
    expect(result.kind).toBe('discovered')
    expect(result.checks).toEqual([])
  })

  it('honors finite explicit recipes, deduplicates them, and reports unavailable recipes', async () => {
    const root = await workspace({
      'package.json': packageJson({ scripts: { test: 'vitest' } }),
    })

    const result = await discoverProjectChecks({
      workspace: root,
      explicit: { checks: ['python:pytest', 'js:test', 'js:test'] },
    })

    expect(result).toMatchObject({
      kind: 'explicit',
      unavailable: ['python:pytest'],
      omitted: [],
    })
    expect(result.checks.map(check => check.id)).toEqual(['js:test'])
  })

  it('caps checks and reports the stable available suffix as omitted', async () => {
    const root = await workspace({
      'package.json': packageJson({ scripts: { check: 'x', typecheck: 'x', lint: 'x', test: 'x' } }),
    })

    const result = await discoverProjectChecks({ workspace: root, maxChecks: 2 })

    expect(result.checks.map(check => check.id)).toEqual(['js:check', 'js:typecheck'])
    expect(result.omitted).toEqual(['js:lint', 'js:test'])
    expect(result.checks).toHaveLength(2)
    expect(MAX_PROJECT_CHECKS).toBe(12)
  })

  it.each([0, 1.5, MAX_PROJECT_CHECKS + 1])('rejects an invalid check cap %s', async (maxChecks) => {
    const root = await workspace()
    await expect(discoverProjectChecks({ workspace: root, maxChecks })).rejects.toThrow(
      /maxChecks must be an integer/,
    )
  })

  it('rejects an arbitrary explicit command identifier', async () => {
    const root = await workspace()
    const unsafe = 'shell:rm -rf workspace' as ProjectCheckId

    await expect(discoverProjectChecks({
      workspace: root,
      explicit: { checks: [unsafe] },
    })).rejects.toThrow(/Unsupported explicit Autopilot check id/)
  })

  it('rejects empty and non-directory workspace inputs', async () => {
    await expect(discoverProjectChecks({ workspace: '' })).rejects.toThrow(/must not be empty/)
    const root = await workspace({ marker: 'file' })
    await expect(discoverProjectChecks({ workspace: join(root, 'marker') })).rejects.toThrow(
      /is not a directory/,
    )
  })

  it('rejects malformed package manifests and ignores non-object scripts', async () => {
    const arrayRoot = await workspace({ 'package.json': '[]' })
    await expect(discoverProjectChecks({ workspace: arrayRoot })).rejects.toThrow(/JSON object/)

    const invalidRoot = await workspace({ 'package.json': '{' })
    await expect(discoverProjectChecks({ workspace: invalidRoot })).rejects.toThrow(SyntaxError)

    const scriptsRoot = await workspace({ 'package.json': packageJson({ scripts: [] }) })
    await expect(discoverProjectChecks({ workspace: scriptsRoot })).resolves.toMatchObject({
      kind: 'discovered', checks: [],
    })
  })

  it('rejects directories, symlinks, and oversized root manifests', async () => {
    const directoryRoot = await workspace()
    await mkdir(join(directoryRoot, 'Cargo.toml'))
    await expect(discoverProjectChecks({ workspace: directoryRoot })).rejects.toThrow(/regular file/)

    const symlinkRoot = await workspace({ outside: '[package]' })
    await symlink(join(symlinkRoot, 'outside'), join(symlinkRoot, 'Cargo.toml'))
    await expect(discoverProjectChecks({ workspace: symlinkRoot })).rejects.toThrow(/regular file/)

    const largeRoot = await workspace({ 'go.mod': 'x'.repeat(1024 * 1024 + 1) })
    await expect(discoverProjectChecks({ workspace: largeRoot })).rejects.toThrow(/exceeds 1048576 bytes/)
  })

  it('canonicalizes the workspace and ignores nested manifests', async () => {
    const parent = await workspace()
    const realRoot = join(parent, 'real')
    const nested = join(realRoot, 'nested')
    const linkedRoot = join(parent, 'linked')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'package.json'), packageJson({ scripts: { test: 'ignored' } }))
    await symlink(realRoot, linkedRoot)

    const result = await discoverProjectChecks({ workspace: linkedRoot })

    expect(result).toMatchObject({
      kind: 'none',
      workspace: realRoot,
      manifests: [],
      checks: [],
    })
  })

  it('validates frozen manifest bytes and reports changes, removal, and invalid replacements', async () => {
    const root = await workspace({
      'package.json': packageJson({ scripts: { test: 'vitest run' } }),
      'go.mod': 'module example.test/original\n',
    })
    const discovered = await discoverProjectChecks({ workspace: root })
    const expected = discovered.manifests.map(({ name, sha256 }) => ({ name, sha256 }))

    await expect(validateProjectManifests(root, expected)).resolves.toEqual({ valid: true, findings: [] })

    await writeFile(join(root, 'package.json'), packageJson({ scripts: { test: 'true' } }))
    await rm(join(root, 'go.mod'))
    const changed = await validateProjectManifests(root, expected)
    expect(changed).toMatchObject({ valid: false })
    expect(changed.findings).toEqual([
      expect.stringContaining('package.json changed after the baseline was frozen'),
      expect.stringContaining('go.mod was removed after the baseline was frozen'),
    ])

    await rm(join(root, 'package.json'))
    await mkdir(join(root, 'package.json'))
    await expect(validateProjectManifests(root, expected)).resolves.toMatchObject({
      valid: false,
      findings: expect.arrayContaining([expect.stringContaining('package.json cannot be validated')]),
    })
  })

  it('fails validation when the frozen workspace is unavailable or resolves elsewhere', async () => {
    const removed = await workspace()
    await rm(removed, { recursive: true })
    await expect(validateProjectManifests(removed, [])).resolves.toMatchObject({
      valid: false,
      findings: [expect.stringContaining('verification workspace is unavailable')],
    })

    const parent = await workspace()
    const realRoot = join(parent, 'real')
    const linkedRoot = join(parent, 'linked')
    await mkdir(realRoot)
    await symlink(realRoot, linkedRoot)
    await expect(validateProjectManifests(linkedRoot, [])).resolves.toEqual({
      valid: false,
      findings: [`verification workspace identity changed: expected ${linkedRoot}, found ${realRoot}`],
    })
  })

  it('hashes exact manifest bytes rather than decoded replacement characters', async () => {
    const root = await workspace()
    await writeFile(join(root, 'go.mod'), Buffer.from([0xff]))
    const discovered = await discoverProjectChecks({ workspace: root })
    const expected = discovered.manifests.map(({ name, sha256 }) => ({ name, sha256 }))
    await writeFile(join(root, 'go.mod'), Buffer.from([0xfe]))

    await expect(validateProjectManifests(root, expected)).resolves.toMatchObject({
      valid: false,
      findings: [expect.stringContaining('go.mod changed after the baseline was frozen')],
    })
  })
})
