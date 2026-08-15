import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

interface Evidence {
  kind: string
  path?: string
  url?: string
}

interface Capability {
  id: string
  status: string
  evidence?: Evidence[]
  reason?: string
  unsupportedCategory?: string
}

interface CapabilityLedger {
  capabilities: Capability[]
}

interface UpstreamFeature {
  id: string
  capabilityId: string
}

interface UpstreamSource {
  id: string
  url: string
}

interface UpstreamInventory {
  features: UpstreamFeature[]
  sources: UpstreamSource[]
  expectedFeatureIds: Record<string, string[]>
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const verifierPath = resolve(repositoryRoot, 'scripts/verify-capabilities.mjs')
const capabilityPath = resolve(repositoryRoot, 'capabilities.lock.json')
const inventoryPath = resolve(repositoryRoot, 'upstream-features.lock.json')

async function readFixtureFiles(): Promise<{
  lock: CapabilityLedger
  inventory: UpstreamInventory
}> {
  const [lockText, inventoryText] = await Promise.all([
    readFile(capabilityPath, 'utf8'),
    readFile(inventoryPath, 'utf8'),
  ])
  return {
    lock: JSON.parse(lockText) as CapabilityLedger,
    inventory: JSON.parse(inventoryText) as UpstreamInventory,
  }
}

async function execute(args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(process.execPath, [verifierPath, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as Error & { code?: number, stdout?: string, stderr?: string }
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

async function executeFixture(
  lock: CapabilityLedger,
  inventory: UpstreamInventory,
  options: { fixtureRoot?: boolean, files?: Array<{ path: string, content: string }> } = {},
): Promise<CommandResult> {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'dsh-autopilot-capabilities-'))
  try {
    const fixtureCapabilityPath = join(fixtureDirectory, 'capabilities.lock.json')
    const fixtureInventoryPath = join(fixtureDirectory, 'upstream-features.lock.json')
    await Promise.all([
      writeFile(fixtureCapabilityPath, `${JSON.stringify(lock, null, 2)}\n`),
      writeFile(fixtureInventoryPath, `${JSON.stringify(inventory, null, 2)}\n`),
    ])
    for (const file of options.files ?? []) {
      const target = join(fixtureDirectory, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content)
    }
    return await execute([
      '--root',
      options.fixtureRoot === true ? fixtureDirectory : repositoryRoot,
      '--capabilities',
      fixtureCapabilityPath,
      '--inventory',
      fixtureInventoryPath,
    ])
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
}

describe('capability inventory verifier', () => {
  it('validates the checked-in ledgers', async () => {
    const result = await execute([])

    expect(result).toEqual({
      code: 0,
      stdout: 'capabilities: 150 entries and 101 upstream features validated\n',
      stderr: '',
    })
  })

  it('rejects deletion of an expected upstream feature', async () => {
    const { lock, inventory } = await readFixtureFiles()
    const deleted = inventory.features[0]
    if (deleted === undefined) throw new Error('upstream fixture is empty')
    inventory.features.splice(0, 1)

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`upstream feature is missing: ${deleted.id}`)
  })

  it('rejects coupled deletion from the feature and expected-id lists', async () => {
    const { lock, inventory } = await readFixtureFiles()
    inventory.features.splice(0, 1)
    inventory.expectedFeatureIds['oh-my-codex']?.splice(0, 1)

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('catalogSha256 does not match its feature records')
  })

  it('rejects duplicate upstream feature ids', async () => {
    const { lock, inventory } = await readFixtureFiles()
    const first = inventory.features[0]
    if (first === undefined) throw new Error('upstream fixture is empty')
    inventory.features.push(structuredClone(first))

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`id duplicates ${first.id}`)
  })

  it('rejects a feature without a capability mapping', async () => {
    const { lock, inventory } = await readFixtureFiles()
    const first = inventory.features[0]
    if (first === undefined) throw new Error('upstream fixture is empty')
    first.capabilityId = 'missing-capability'

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('capabilityId is unmapped: missing-capability')
  })

  it('rejects an upstream source URL that is not pinned to its declared file', async () => {
    const { lock, inventory } = await readFixtureFiles()
    const first = inventory.sources[0]
    if (first === undefined) throw new Error('upstream source fixture is empty')
    first.url = 'https://github.com/code-yeongyu/oh-my-openagent/blob/dev/README.md'

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('url must cite its exact pinned file')
  })

  it('requires test evidence to point to a spec file', async () => {
    const { lock, inventory } = await readFixtureFiles()
    const capability = lock.capabilities.find(entry => entry.id === 'active-time-lease')
    if (capability === undefined) throw new Error('active-time-lease fixture is missing')
    capability.evidence = [{ kind: 'test', path: 'package.json' }]

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('path must point to an existing *.spec.ts test')
  })

  it('rejects an empty spec file as verification evidence', async () => {
    const { lock, inventory } = await readFixtureFiles()
    for (const capability of lock.capabilities) {
      delete capability.evidence
      if (['unit-verified', 'packed-verified', 'verified'].includes(capability.status)) {
        capability.status = 'planned'
      }
    }
    const capability = lock.capabilities.find(entry => entry.id === 'active-time-lease')
    if (capability === undefined) throw new Error('active-time-lease fixture is missing')
    capability.status = 'unit-verified'
    capability.evidence = [{ kind: 'test', path: 'tests/unit/empty.spec.ts' }]

    const result = await executeFixture(lock, inventory, {
      fixtureRoot: true,
      files: [{ path: 'tests/unit/empty.spec.ts', content: '' }],
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('path is empty: tests/unit/empty.spec.ts')
  })

  it('requires unsupported capabilities to declare a recognized category', async () => {
    const { lock, inventory } = await readFixtureFiles()
    const capability = lock.capabilities.find(entry => entry.status === 'unsupported')
    if (capability === undefined) throw new Error('unsupported fixture is missing')
    delete capability.unsupportedCategory

    const result = await executeFixture(lock, inventory)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('has no recognized unsupportedCategory')
  })

  it('keeps the completion gate red while parity work remains', async () => {
    const result = await execute(['--complete'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('native-goal-round-continuation is still packed-verified')
    expect(result.stderr).toContain('hash-anchored-edit is still unit-verified')
  })
})
