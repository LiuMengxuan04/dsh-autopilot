/** Durable, explicitly accessed project memory for DSH Autopilot. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'

/** Current project-memory record format. */
export const PROJECT_MEMORY_VERSION = 1 as const

/** One bounded project-scoped memory entry. */
export interface ProjectMemoryEntry {
  readonly version: typeof PROJECT_MEMORY_VERSION
  readonly workspace: string
  readonly key: string
  readonly revision: number
  readonly value: string
  readonly tags: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Lightweight list result that does not inject full values into context. */
export interface ProjectMemorySummary {
  readonly key: string
  readonly revision: number
  readonly tags: readonly string[]
  readonly updatedAt: number
  readonly preview: string
}

/** Deployment limits for explicit project memory. */
export interface ProjectMemoryConfig {
  readonly maxEntriesPerWorkspace?: number
  readonly maxValueChars?: number
}

interface ResolvedProjectMemoryConfig {
  readonly maxEntriesPerWorkspace: number
  readonly maxValueChars: number
}

const memoryEntrySchema: z.ZodType<ProjectMemoryEntry> = z.object({
  version: z.literal(PROJECT_MEMORY_VERSION),
  workspace: z.string().min(1).max(4096),
  key: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
  revision: z.number().int().positive(),
  value: z.string().min(1).max(65_536),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).max(16),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

/** DSH storage-domain declaration for project memory. */
export const projectMemoryDomainSpec = defineDomain({
  name: 'dsh_autopilot_memory',
  version: PROJECT_MEMORY_VERSION,
  tables: { entries: domainTable<string, ProjectMemoryEntry>(memoryEntrySchema) },
})

/** Stable project-memory failure. */
export class ProjectMemoryError extends Error {
  /** Stable machine-routable failure category. */
  readonly code: 'MEMORY_INVALID' | 'MEMORY_CONFLICT' | 'MEMORY_LIMIT'

  /**
   * @param message - Actionable failure detail.
   * @param code - Stable failure category.
   */
  constructor(message: string, code: ProjectMemoryError['code']) {
    super(message)
    this.name = 'ProjectMemoryError'
    this.code = code
  }
}

/** Canonicalize the workspace identity used as the project-memory namespace. */
export function projectMemoryWorkspace(workspace: string): string {
  const normalized = workspace.trim()
  if (normalized.length === 0) throw new ProjectMemoryError('workspace must not be empty', 'MEMORY_INVALID')
  return resolve(normalized)
}

/** Build a storage-safe key while retaining the original key in each record. */
function storageKey(workspace: string, key: string): string {
  const project = createHash('sha256').update(workspace).digest('base64url')
  return `${project}.${Buffer.from(key, 'utf8').toString('base64url')}`
}

/** Normalize and validate a caller-supplied logical key. */
function memoryKey(key: string): string {
  const normalized = key.trim()
  if (!/^[a-z][a-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new ProjectMemoryError(
      'memory key must start with a lowercase letter and contain only lowercase letters, digits, dot, colon, underscore, or hyphen',
      'MEMORY_INVALID',
    )
  }
  return normalized
}

/** Normalize bounded tags and reject duplicates. */
function memoryTags(tags: readonly string[]): readonly string[] {
  const normalized = tags.map(tag => tag.trim())
  if (normalized.length > 16 || normalized.some(tag => !/^[a-z][a-z0-9-]{0,63}$/u.test(tag))) {
    throw new ProjectMemoryError('memory tags must be 1-64 character lowercase kebab-case values', 'MEMORY_INVALID')
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new ProjectMemoryError('memory tags must not repeat', 'MEMORY_INVALID')
  }
  return Object.freeze(normalized)
}

/** Host service that owns one durable project-memory domain. */
export class ProjectMemoryService extends Service {
  static inject = ['storageDomain']

  static Config: s<ProjectMemoryConfig> = s.object({
    maxEntriesPerWorkspace: s.number().step(1).min(1).max(10_000).default(128),
    maxValueChars: s.number().step(1).min(1).max(65_536).default(32_000),
  })

  private domain: Domain<typeof projectMemoryDomainSpec> | undefined
  private table: KvTable<string, ProjectMemoryEntry> | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private readonly resolved: ResolvedProjectMemoryConfig

  /**
   * @param ctx - Cordis owner carrying storage-domain.
   * @param config - Deployment memory ceilings.
   */
  constructor(ctx: Context, config: ProjectMemoryConfig = {}) {
    super(ctx, 'autopilotMemory')
    this.resolved = {
      maxEntriesPerWorkspace: config.maxEntriesPerWorkspace
        /* v8 ignore next -- Cordis materializes the schema default before construction. */
        ?? 128,
      maxValueChars: config.maxValueChars
        /* v8 ignore next -- Cordis materializes the schema default before construction. */
        ?? 32_000,
    }
  }

  /** Open the owned domain before tool consumers activate. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectMemoryDomainSpec)
    this.domain = domain
    this.table = domain.table('entries')
    this.ctx.effect(() => async () => {
      await this.writeTail
      /* v8 ignore else -- this effect is the sole owner of the opened domain slot. */
      if (this.domain === domain) {
        this.domain = undefined
        this.table = undefined
      }
      await domain.close()
    }, 'dsh-autopilot.projectMemoryClose')
  }

  /** List bounded metadata for one project without returning full values. */
  list(workspace: string): readonly ProjectMemorySummary[] {
    const canonical = projectMemoryWorkspace(workspace)
    return Object.freeze([...this.requireTable().entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.workspace === canonical)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(entry => Object.freeze({
        key: entry.key,
        revision: entry.revision,
        tags: entry.tags,
        updatedAt: entry.updatedAt,
        preview: entry.value.length <= 200 ? entry.value : `${entry.value.slice(0, 200)}…`,
      })))
  }

  /** Read one exact entry. */
  read(workspace: string, key: string): ProjectMemoryEntry | undefined {
    const canonical = projectMemoryWorkspace(workspace)
    return this.requireTable().get(storageKey(canonical, memoryKey(key)))
  }

  /** Create or compare-and-set replace one entry. */
  write(
    workspace: string,
    key: string,
    value: string,
    tags: readonly string[] = [],
    expectedRevision?: number,
  ): Promise<ProjectMemoryEntry> {
    const canonical = projectMemoryWorkspace(workspace)
    const normalizedKey = memoryKey(key)
    const normalizedValue = value.trim()
    if (normalizedValue.length === 0 || normalizedValue.length > this.resolved.maxValueChars) {
      throw new ProjectMemoryError(
        `memory value must contain 1-${this.resolved.maxValueChars} characters`,
        'MEMORY_INVALID',
      )
    }
    const normalizedTags = memoryTags(tags)
    return this.serialized(async () => {
      const table = this.requireTable()
      const encoded = storageKey(canonical, normalizedKey)
      const current = table.get(encoded)
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
        throw new ProjectMemoryError(
          `memory revision conflict for "${normalizedKey}"; expected ${expectedRevision}, current is ${current?.revision ?? 'absent'}`,
          'MEMORY_CONFLICT',
        )
      }
      if (current === undefined) {
        const count = [...table.entries()].filter(([, entry]) => entry.workspace === canonical).length
        if (count >= this.resolved.maxEntriesPerWorkspace) {
          throw new ProjectMemoryError(
            `project memory reached its ${this.resolved.maxEntriesPerWorkspace} entry ceiling`,
            'MEMORY_LIMIT',
          )
        }
      }
      const now = Date.now()
      const next: ProjectMemoryEntry = Object.freeze({
        version: PROJECT_MEMORY_VERSION,
        workspace: canonical,
        key: normalizedKey,
        revision: (current?.revision ?? 0) + 1,
        value: normalizedValue,
        tags: normalizedTags,
        createdAt: current?.createdAt ?? now,
        updatedAt: Math.max(now, current?.updatedAt ?? 0),
      })
      await table.put(encoded, next)
      return next
    })
  }

  /** Compare-and-set delete one entry. */
  delete(workspace: string, key: string, expectedRevision?: number): Promise<boolean> {
    const canonical = projectMemoryWorkspace(workspace)
    const normalizedKey = memoryKey(key)
    return this.serialized(async () => {
      const table = this.requireTable()
      const encoded = storageKey(canonical, normalizedKey)
      const current = table.get(encoded)
      if (current === undefined) return false
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new ProjectMemoryError(
          `memory revision conflict for "${normalizedKey}"; expected ${expectedRevision}, current is ${current.revision}`,
          'MEMORY_CONFLICT',
        )
      }
      return table.delete(encoded)
    })
  }

  private requireTable(): KvTable<string, ProjectMemoryEntry> {
    /* v8 ignore next -- service injection activates only after Service.init completes. */
    if (this.table === undefined) throw new ProjectMemoryError('project memory is not initialized', 'MEMORY_INVALID')
    return this.table
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilotMemory: ProjectMemoryService
  }
}

export default ProjectMemoryService
