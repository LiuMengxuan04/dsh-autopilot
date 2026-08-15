import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = resolve(import.meta.dirname, '..')
const upstreamNames = ['oh-my-codex', 'oh-my-openagent']
const allowedStatuses = new Set([
  'planned',
  'implementing',
  'native-available',
  'native-limited',
  'unit-verified',
  'packed-verified',
  'verified',
  'unsupported',
  'planned-after-core',
])
const evidenceStatuses = new Set(['unit-verified', 'packed-verified', 'verified'])
const incompleteStatuses = new Set([
  'planned',
  'implementing',
  'native-available',
  'native-limited',
  'unit-verified',
  'packed-verified',
  'planned-after-core',
])
const allowedEvidenceKinds = new Set(['source', 'test', 'e2e', 'doc', 'upstream'])
const allowedUnsupportedCategories = new Set([
  'compatibility',
  'platform-mismatch',
  'product-boundary',
  'security-policy',
  'upstream-obsolete',
])

/**
 * Return whether a value is a safe repository-relative path.
 *
 * @param {unknown} value Candidate path.
 * @returns {value is string} Whether the path stays relative and uses portable separators.
 */
function isRepositoryPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes('\\')
    && !value.split('/').includes('..')
}

/**
 * Return whether an absolute path remains below a repository root.
 *
 * @param {string} root Repository root.
 * @param {string} path Absolute candidate path.
 * @returns {boolean} Whether the candidate remains below the root.
 */
function isInsideRoot(root, path) {
  const fromRoot = relative(root, path)
  return fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
}

/**
 * Validate a non-empty evidence file and its kind-specific location.
 *
 * @param {object} options Validation options.
 * @param {string} options.root Repository root.
 * @param {unknown} options.evidence Evidence record.
 * @param {string} options.label Diagnostic label.
 * @param {Record<string, unknown>} options.references Capability references.
 * @param {string[]} options.failures Mutable diagnostics.
 * @returns {Promise<void>} Completes after filesystem validation.
 */
async function validateEvidence({ root, evidence, label, references, failures }) {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    failures.push(`${label} must be an object`)
    return
  }
  const kind = evidence.kind
  if (typeof kind !== 'string' || !allowedEvidenceKinds.has(kind)) {
    failures.push(`${label}.kind is invalid`)
    return
  }
  if (kind === 'upstream') {
    if (typeof evidence.url !== 'string' || !evidence.url.startsWith('https://')) {
      failures.push(`${label}.url must be an HTTPS URL`)
      return
    }
    const pinnedPrefixes = Object.values(references)
      .filter(reference => typeof reference === 'object' && reference !== null)
      .map(reference => `${reference.repository}/blob/${reference.commit}/`)
    if (!pinnedPrefixes.some(prefix => evidence.url.startsWith(prefix))) {
      failures.push(`${label}.url must cite a pinned reference revision`)
    }
    return
  }
  if (!isRepositoryPath(evidence.path)) {
    failures.push(`${label}.path must be a repository-relative path`)
    return
  }
  if (kind === 'test' && !/^tests\/(?:.+\/)*[^/]+\.spec\.ts$/u.test(evidence.path)) {
    failures.push(`${label}.path must point to an existing *.spec.ts test`)
  }
  if (kind === 'e2e' && !/^tests\/e2e\/(?:.+\/)*[^/]+\.spec\.ts$/u.test(evidence.path)) {
    failures.push(`${label}.path must point to an existing tests/e2e/*.spec.ts test`)
  }
  const absolutePath = resolve(root, evidence.path)
  if (!isInsideRoot(root, absolutePath)) {
    failures.push(`${label}.path escapes the repository root`)
    return
  }
  try {
    const file = await stat(absolutePath)
    if (!file.isFile()) failures.push(`${label}.path is not a file: ${evidence.path}`)
    if (file.size === 0) failures.push(`${label}.path is empty: ${evidence.path}`)
  } catch {
    failures.push(`${label}.path does not exist: ${evidence.path}`)
  }
}

/**
 * Validate the capability ledger and pinned upstream feature inventory.
 *
 * @param {object} options Validation options.
 * @param {string} options.root Repository root used for evidence paths.
 * @param {Record<string, any>} options.lock Parsed capability ledger.
 * @param {Record<string, any>} options.inventory Parsed upstream inventory.
 * @param {boolean} [options.requireComplete=false] Whether incomplete statuses fail.
 * @returns {Promise<string[]>} Validation diagnostics; an empty array means success.
 */
export async function verifyCapabilityData({ root, lock, inventory, requireComplete = false }) {
  const failures = []
  const capabilityReferences = lock.references ?? {}

  if (lock.schemaVersion !== 2) failures.push('schemaVersion must be 2')
  if (typeof lock.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(lock.generatedAt)) {
    failures.push('generatedAt must use YYYY-MM-DD')
  }

  for (const name of [...upstreamNames, 'deepseek-harness']) {
    const reference = capabilityReferences[name]
    if (reference === undefined) {
      failures.push(`references.${name} is missing`)
      continue
    }
    if (typeof reference.repository !== 'string' || !reference.repository.startsWith('https://')) {
      failures.push(`references.${name}.repository must be an HTTPS URL`)
    }
    if (typeof reference.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(reference.commit)) {
      failures.push(`references.${name}.commit must be a full Git SHA`)
    }
  }

  const capabilities = Array.isArray(lock.capabilities) ? lock.capabilities : []
  const capabilityIds = new Set()
  for (const [index, capability] of capabilities.entries()) {
    const label = `capabilities[${index}]`
    if (typeof capability.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(capability.id)) {
      failures.push(`${label}.id is invalid`)
    } else if (capabilityIds.has(capability.id)) {
      failures.push(`${label}.id duplicates ${capability.id}`)
    } else {
      capabilityIds.add(capability.id)
    }
    if (!Array.isArray(capability.source) || capability.source.length === 0) {
      failures.push(`${label}.source must be a non-empty array`)
    } else {
      const sources = new Set()
      for (const source of capability.source) {
        if (typeof source !== 'string'
          || (source !== 'dsh-autopilot' && capabilityReferences[source] === undefined)) {
          failures.push(`${label}.source contains an unknown source: ${String(source)}`)
        } else if (sources.has(source)) {
          failures.push(`${label}.source duplicates ${source}`)
        } else {
          sources.add(source)
        }
      }
    }
    if (typeof capability.implementation !== 'string' || capability.implementation.trim().length === 0) {
      failures.push(`${label}.implementation is missing`)
    }
    if (!allowedStatuses.has(capability.status)) {
      failures.push(`${label}.status is not recognized: ${String(capability.status)}`)
    }
    if (evidenceStatuses.has(capability.status)
      && (!Array.isArray(capability.evidence) || capability.evidence.length === 0)) {
      failures.push(`${label} is ${capability.status} but has no evidence`)
    }
    if (requireComplete && incompleteStatuses.has(capability.status)) {
      failures.push(`${capability.id} is still ${capability.status}`)
    }
    if (capability.status === 'unsupported') {
      if (typeof capability.reason !== 'string' || capability.reason.trim().length === 0) {
        failures.push(`${label} is unsupported but has no reason`)
      }
      if (typeof capability.unsupportedCategory !== 'string'
        || !allowedUnsupportedCategories.has(capability.unsupportedCategory)) {
        failures.push(`${label} is unsupported but has no recognized unsupportedCategory`)
      }
    } else if (capability.reason !== undefined || capability.unsupportedCategory !== undefined) {
      failures.push(`${label} may declare reason/unsupportedCategory only when unsupported`)
    }

    const evidenceRecords = Array.isArray(capability.evidence) ? capability.evidence : []
    const evidenceKeys = new Set()
    for (const [evidenceIndex, evidence] of evidenceRecords.entries()) {
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`
      const evidenceKey = typeof evidence === 'object' && evidence !== null
        ? `${String(evidence.kind)}:${String(evidence.path ?? evidence.url)}`
        : String(evidence)
      if (evidenceKeys.has(evidenceKey)) failures.push(`${evidenceLabel} duplicates ${evidenceKey}`)
      evidenceKeys.add(evidenceKey)
      await validateEvidence({ root, evidence, label: evidenceLabel, references: capabilityReferences, failures })
    }
    const hasUnitTest = evidenceRecords.some(evidence => evidence?.kind === 'test')
    const hasPackedTest = evidenceRecords.some(evidence => evidence?.kind === 'e2e')
    if (capability.status === 'unit-verified' && !hasUnitTest) {
      failures.push(`${label} is unit-verified but has no test evidence`)
    }
    if (capability.status === 'packed-verified' && !hasPackedTest) {
      failures.push(`${label} is packed-verified but has no e2e evidence`)
    }
    if (capability.status === 'verified' && !hasUnitTest && !hasPackedTest) {
      failures.push(`${label} is verified but has no test or e2e evidence`)
    }
  }
  if (capabilities.length === 0) failures.push('capabilities must not be empty')

  if (inventory.schemaVersion !== 1) failures.push('upstream inventory schemaVersion must be 1')
  if (typeof inventory.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(inventory.generatedAt)) {
    failures.push('upstream inventory generatedAt must use YYYY-MM-DD')
  }
  if (typeof inventory.catalogScope !== 'string' || inventory.catalogScope.trim().length === 0) {
    failures.push('upstream inventory catalogScope is missing')
  }
  for (const name of upstreamNames) {
    const reference = inventory.references?.[name]
    const capabilityReference = capabilityReferences[name]
    if (reference?.repository !== capabilityReference?.repository
      || reference?.commit !== capabilityReference?.commit) {
      failures.push(`upstream inventory references.${name} must match capabilities.lock.json`)
    }
  }

  const sourceRecords = Array.isArray(inventory.sources) ? inventory.sources : []
  const sourcesById = new Map()
  for (const [index, source] of sourceRecords.entries()) {
    const label = `upstream sources[${index}]`
    if (typeof source.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(source.id)) {
      failures.push(`${label}.id is invalid`)
      continue
    }
    if (sourcesById.has(source.id)) {
      failures.push(`${label}.id duplicates ${source.id}`)
      continue
    }
    sourcesById.set(source.id, source)
    if (!upstreamNames.includes(source.upstream)) {
      failures.push(`${label}.upstream is invalid`)
      continue
    }
    if (!isRepositoryPath(source.path)) failures.push(`${label}.path is invalid`)
    if (!Number.isInteger(source.lineCount) || source.lineCount < 1) {
      failures.push(`${label}.lineCount must be a positive integer`)
    }
    if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256)) {
      failures.push(`${label}.sha256 must be a full SHA-256 digest`)
    }
    const reference = inventory.references?.[source.upstream]
    const expectedUrl = `${reference?.repository}/blob/${reference?.commit}/${source.path}`
    if (source.url !== expectedUrl) failures.push(`${label}.url must cite its exact pinned file`)
  }
  if (sourceRecords.length === 0) failures.push('upstream sources must not be empty')

  const features = Array.isArray(inventory.features) ? inventory.features : []
  const featureIds = new Set()
  const actualByUpstream = new Map(upstreamNames.map(name => [name, new Set()]))
  const usedSourceIds = new Set()
  for (const [index, feature] of features.entries()) {
    const label = `upstream features[${index}]`
    if (typeof feature.id !== 'string' || !/^(?:omx|omo)\.[a-z][a-z0-9-]*$/u.test(feature.id)) {
      failures.push(`${label}.id is invalid`)
    } else if (featureIds.has(feature.id)) {
      failures.push(`${label}.id duplicates ${feature.id}`)
    } else {
      featureIds.add(feature.id)
    }
    if (!upstreamNames.includes(feature.upstream)) {
      failures.push(`${label}.upstream is invalid`)
    } else {
      actualByUpstream.get(feature.upstream)?.add(feature.id)
      const requiredPrefix = feature.upstream === 'oh-my-codex' ? 'omx.' : 'omo.'
      if (typeof feature.id === 'string' && !feature.id.startsWith(requiredPrefix)) {
        failures.push(`${label}.id must use the ${requiredPrefix} prefix`)
      }
    }
    if (typeof feature.title !== 'string' || feature.title.trim().length === 0) {
      failures.push(`${label}.title is missing`)
    }
    if (typeof feature.capabilityId !== 'string' || !capabilityIds.has(feature.capabilityId)) {
      failures.push(`${label}.capabilityId is unmapped: ${String(feature.capabilityId)}`)
    } else {
      const capability = capabilities.find(entry => entry.id === feature.capabilityId)
      if (upstreamNames.includes(feature.upstream) && !capability?.source?.includes(feature.upstream)) {
        failures.push(`${label}.capabilityId does not cite ${feature.upstream} as a source`)
      }
    }
    if (feature.capabilityIds !== undefined || Array.isArray(feature.capabilityId)) {
      failures.push(`${label} must map to exactly one capabilityId`)
    }
    const citation = feature.citation
    if (typeof citation !== 'object' || citation === null || Array.isArray(citation)) {
      failures.push(`${label}.citation must be an object`)
      continue
    }
    const source = sourcesById.get(citation.sourceId)
    if (source === undefined) {
      failures.push(`${label}.citation.sourceId is unknown: ${String(citation.sourceId)}`)
    } else {
      usedSourceIds.add(citation.sourceId)
      if (source.upstream !== feature.upstream) {
        failures.push(`${label}.citation source belongs to a different upstream`)
      }
    }
    if (!Number.isInteger(citation.lineStart) || citation.lineStart < 1
      || !Number.isInteger(citation.lineEnd) || citation.lineEnd < citation.lineStart) {
      failures.push(`${label}.citation must declare a valid inclusive line range`)
    } else if (source !== undefined && citation.lineEnd > source.lineCount) {
      failures.push(`${label}.citation exceeds the pinned source line count`)
    }
    if (typeof citation.locator !== 'string' || citation.locator.trim().length === 0) {
      failures.push(`${label}.citation.locator is missing`)
    }
  }
  if (features.length === 0) failures.push('upstream features must not be empty')
  const catalogRows = features
    .map(feature => [
      feature.id,
      feature.upstream,
      feature.capabilityId,
      feature.citation?.sourceId,
      feature.citation?.lineStart,
      feature.citation?.lineEnd,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const catalogSha256 = createHash('sha256').update(JSON.stringify(catalogRows)).digest('hex')
  if (inventory.catalogSha256 !== catalogSha256) {
    failures.push('upstream inventory catalogSha256 does not match its feature records')
  }

  for (const name of upstreamNames) {
    const expected = inventory.expectedFeatureIds?.[name]
    if (!Array.isArray(expected) || expected.length === 0) {
      failures.push(`expectedFeatureIds.${name} must be a non-empty array`)
      continue
    }
    const expectedSet = new Set(expected)
    if (expectedSet.size !== expected.length) failures.push(`expectedFeatureIds.${name} contains duplicates`)
    if (JSON.stringify(expected) !== JSON.stringify([...expected].sort())) {
      failures.push(`expectedFeatureIds.${name} must be sorted`)
    }
    const actual = actualByUpstream.get(name) ?? new Set()
    for (const id of expectedSet) {
      if (!actual.has(id)) failures.push(`upstream feature is missing: ${id}`)
    }
    for (const id of actual) {
      if (!expectedSet.has(id)) failures.push(`upstream feature is not declared in expectedFeatureIds.${name}: ${id}`)
    }
  }
  for (const source of sourceRecords) {
    if (typeof source.id === 'string' && !usedSourceIds.has(source.id)) {
      failures.push(`upstream source is unused: ${source.id}`)
    }
  }

  return failures
}

/**
 * Read and validate capability files.
 *
 * @param {object} options Validation options.
 * @param {string} [options.root=defaultRoot] Repository root used for evidence paths.
 * @param {string} [options.lockPath] Capability ledger path.
 * @param {string} [options.inventoryPath] Upstream inventory path.
 * @param {boolean} [options.requireComplete=false] Whether incomplete statuses fail.
 * @returns {Promise<{failures: string[], capabilityCount: number, featureCount: number}>} Validation result.
 */
export async function verifyCapabilityFiles({
  root = defaultRoot,
  lockPath = resolve(root, 'capabilities.lock.json'),
  inventoryPath = resolve(root, 'upstream-features.lock.json'),
  requireComplete = false,
} = {}) {
  const [lockText, inventoryText] = await Promise.all([
    readFile(lockPath, 'utf8'),
    readFile(inventoryPath, 'utf8'),
  ])
  const lock = JSON.parse(lockText)
  const inventory = JSON.parse(inventoryText)
  const failures = await verifyCapabilityData({ root, lock, inventory, requireComplete })
  return {
    failures,
    capabilityCount: Array.isArray(lock.capabilities) ? lock.capabilities.length : 0,
    featureCount: Array.isArray(inventory.features) ? inventory.features.length : 0,
  }
}

/**
 * Parse command-line arguments for fixtureable ledger validation.
 *
 * @param {string[]} args Command-line arguments.
 * @returns {{root: string, lockPath: string, inventoryPath: string, requireComplete: boolean}} Parsed options.
 */
function parseArgs(args) {
  let root = defaultRoot
  let lockPath
  let inventoryPath
  let requireComplete = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--complete') {
      requireComplete = true
      continue
    }
    const [flag, inlineValue] = argument.split('=', 2)
    if (!['--root', '--capabilities', '--inventory'].includes(flag)) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = inlineValue ?? args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a path`)
    if (inlineValue === undefined) index += 1
    if (flag === '--root') root = resolve(value)
    if (flag === '--capabilities') lockPath = resolve(value)
    if (flag === '--inventory') inventoryPath = resolve(value)
  }
  return {
    root,
    lockPath: lockPath ?? resolve(root, 'capabilities.lock.json'),
    inventoryPath: inventoryPath ?? resolve(root, 'upstream-features.lock.json'),
    requireComplete,
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await verifyCapabilityFiles(parseArgs(process.argv.slice(2)))
    if (result.failures.length > 0) {
      for (const failure of result.failures) process.stderr.write(`capabilities: ${failure}\n`)
      process.exitCode = 1
    } else {
      const suffix = process.argv.includes('--complete') ? ' for completion' : ''
      process.stdout.write(
        `capabilities: ${result.capabilityCount} entries and ${result.featureCount} upstream features validated${suffix}\n`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`capabilities: ${message}\n`)
    process.exitCode = 1
  }
}
