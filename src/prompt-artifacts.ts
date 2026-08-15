/** Secure, bounded loader for deployment-authored Markdown prompt artifacts. */
import { createHash } from 'node:crypto'
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { isAlias, isNode, parseDocument, visit } from 'yaml'

/** Deployment ceilings applied before artifact text is parsed. */
export interface PromptArtifactLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

/** One detached Markdown file with strict YAML frontmatter. */
export interface PromptArtifact {
  readonly path: string
  readonly relativePath: string
  readonly sha256: string
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly body: string
  readonly bytes: number
}

/** Stable configuration or artifact validation failure. */
export class PromptArtifactError extends Error {
  /** Machine-routable error category. */
  readonly code: 'ARTIFACT_CONFIG' | 'ARTIFACT_PATH' | 'ARTIFACT_FORMAT' | 'ARTIFACT_LIMIT'

  /**
   * @param message - Actionable validation detail.
   * @param code - Stable failure category.
   */
  constructor(message: string, code: PromptArtifactError['code']) {
    super(message)
    this.name = 'PromptArtifactError'
    this.code = code
  }
}

/** Test whether `candidate` is inside `root`, including the root itself. */
function isWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

/** Validate positive integer deployment limits without relying on a schema caller. */
function validateLimits(limits: PromptArtifactLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PromptArtifactError(`${name} must be a positive safe integer`, 'ARTIFACT_CONFIG')
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new PromptArtifactError('maxFileBytes must not exceed maxTotalBytes', 'ARTIFACT_CONFIG')
  }
}

/** Resolve a deployment-absolute or workspace-relative artifact directory. */
export function resolvePromptArtifactRoot(workspace: string | undefined, configuredDirectory: string): string {
  if (configuredDirectory.length === 0 || configuredDirectory.includes('\0')) {
    throw new PromptArtifactError('artifact directory must be a non-empty path without NUL bytes', 'ARTIFACT_CONFIG')
  }
  if (isAbsolute(configuredDirectory)) return resolve(configuredDirectory)
  if (workspace === undefined || !isAbsolute(workspace)) {
    throw new PromptArtifactError(
      'a relative artifact directory requires an absolute Agent workspace',
      'ARTIFACT_CONFIG',
    )
  }
  const root = resolve(workspace, configuredDirectory)
  if (!isWithin(resolve(workspace), root)) {
    throw new PromptArtifactError(
      `artifact directory "${configuredDirectory}" escapes Agent workspace "${workspace}"`,
      'ARTIFACT_PATH',
    )
  }
  return root
}

/** Parse strict, alias-free YAML frontmatter and a non-empty Markdown body. */
export function parsePromptArtifact(raw: string, path: string): Pick<PromptArtifact, 'frontmatter' | 'body'> {
  const normalized = raw.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    throw new PromptArtifactError(`${path} is missing opening YAML frontmatter`, 'ARTIFACT_FORMAT')
  }
  const closing = /^---(?:\n|$)/mu.exec(normalized.slice(4))
  if (closing === null) {
    throw new PromptArtifactError(`${path} is missing closing YAML frontmatter`, 'ARTIFACT_FORMAT')
  }
  const frontmatterEnd = 4 + closing.index
  const document = parseDocument(normalized.slice(4, frontmatterEnd), {
    schema: 'core',
    merge: false,
    prettyErrors: false,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new PromptArtifactError(
      `${path} has invalid YAML frontmatter: ${document.errors.map(error => error.message).join('; ')}`,
      'ARTIFACT_FORMAT',
    )
  }
  try {
    visit(document, {
      Node(_key, node) {
        if (isAlias(node)) throw new Error('aliases are not allowed')
        if (isNode(node) && node.tag !== undefined) throw new Error('explicit YAML tags are not allowed')
      },
    })
  } catch (error: unknown) {
    throw new PromptArtifactError(
      `${path} has unsafe YAML frontmatter: ${String(error)}`,
      'ARTIFACT_FORMAT',
    )
  }
  const data: unknown = document.toJS({ maxAliasCount: 0 })
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PromptArtifactError(`${path} YAML frontmatter must be an object`, 'ARTIFACT_FORMAT')
  }
  const body = normalized.slice(frontmatterEnd + closing[0].length).trim()
  if (body.length === 0) {
    throw new PromptArtifactError(`${path} Markdown body must not be empty`, 'ARTIFACT_FORMAT')
  }
  return { frontmatter: Object.freeze({ ...(data as Record<string, unknown>) }), body }
}

/** Return recursively discovered Markdown paths after rejecting unsafe entries. */
function discoverMarkdown(root: string): string[] {
  const files: string[] = []
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const status = lstatSync(path)
      if (status.isSymbolicLink()) {
        throw new PromptArtifactError(`artifact catalog contains symbolic link "${path}"`, 'ARTIFACT_PATH')
      }
      if (status.isDirectory()) {
        visitDirectory(path)
        continue
      }
      if (!status.isFile()) {
        throw new PromptArtifactError(`artifact catalog entry "${path}" is not a regular file`, 'ARTIFACT_PATH')
      }
      if (entry.name.toLowerCase().endsWith('.md')) files.push(path)
    }
  }
  visitDirectory(root)
  return files.sort()
}

/**
 * Load one bounded catalog in path-stable order.
 * @param workspace - Absolute Agent workspace, required for relative configuration.
 * @param configuredDirectory - Absolute deployment path or workspace-relative path.
 * @param limits - File-count and byte ceilings applied before parsing.
 * @returns Detached, immutable Markdown artifacts.
 */
export function loadPromptArtifacts(
  workspace: string | undefined,
  configuredDirectory: string,
  limits: PromptArtifactLimits,
): readonly PromptArtifact[] {
  validateLimits(limits)
  const root = resolvePromptArtifactRoot(workspace, configuredDirectory)
  let rootStatus
  try {
    rootStatus = lstatSync(root)
  } catch (error: unknown) {
    throw new PromptArtifactError(`cannot inspect artifact directory "${root}": ${String(error)}`, 'ARTIFACT_PATH')
  }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new PromptArtifactError(`artifact root "${root}" must be a real directory`, 'ARTIFACT_PATH')
  }
  const realRoot = realpathSync(root)
  if (!isAbsolute(configuredDirectory) && workspace !== undefined) {
    const realWorkspace = realpathSync(workspace)
    if (!isWithin(realWorkspace, realRoot)) {
      throw new PromptArtifactError(`artifact root "${root}" resolves outside Agent workspace`, 'ARTIFACT_PATH')
    }
  }
  const paths = discoverMarkdown(root)
  if (paths.length > limits.maxFiles) {
    throw new PromptArtifactError(
      `artifact catalog has ${paths.length} Markdown files; maximum is ${limits.maxFiles}`,
      'ARTIFACT_LIMIT',
    )
  }
  let totalBytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const loaded = paths.map((path): PromptArtifact => {
    const bytes = readFileSync(path)
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new PromptArtifactError(
        `artifact "${path}" is ${bytes.byteLength} bytes; per-file maximum is ${limits.maxFileBytes}`,
        'ARTIFACT_LIMIT',
      )
    }
    totalBytes += bytes.byteLength
    if (totalBytes > limits.maxTotalBytes) {
      throw new PromptArtifactError(
        `artifact catalog is larger than the ${limits.maxTotalBytes} byte total maximum`,
        'ARTIFACT_LIMIT',
      )
    }
    let raw: string
    try {
      raw = decoder.decode(bytes)
    } catch (error: unknown) {
      throw new PromptArtifactError(`artifact "${path}" is not valid UTF-8: ${String(error)}`, 'ARTIFACT_FORMAT')
    }
    const parsed = parsePromptArtifact(raw, path)
    return Object.freeze({
      path,
      relativePath: relative(root, path).split(sep).join('/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...parsed,
      bytes: bytes.byteLength,
    })
  })
  return Object.freeze(loaded)
}
