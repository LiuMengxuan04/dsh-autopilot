/** Packaged DSH Autopilot skill catalog registered without host profile paths. */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { registerRecoveryContribution } from './recovery-coordinator.ts'
import { parseSkillMcpReferences } from './skill-mcp.ts'

export const name = 'dsh-autopilot-skills'
export const inject = ['skills']

const SKILLS_ROOT_URL = new URL('../assets/skills/', import.meta.url)
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const FRONTMATTER_KEYS = new Set(['name', 'description', 'whenToUse', 'mcpServers'])

/** Test whether a YAML result is a frontmatter record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one required non-empty string from controlled frontmatter. */
function requiredString(data: Record<string, unknown>, key: string, path: string): string {
  const value = data[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`bundled skill ${path} frontmatter requires a non-empty "${key}" string`)
  }
  return value.trim()
}

/** Read an optional non-empty string from controlled frontmatter. */
function optionalString(data: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = data[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`bundled skill ${path} frontmatter field "${key}" must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Parse one packaged skill document and reject incomplete artifacts at load.
 * @param raw - Complete UTF-8 Markdown file.
 * @param path - Absolute artifact path used for diagnostics and resources.
 * @returns Runtime registration ready for the DSH skill registry.
 */
export function parseBundledSkill(raw: string, path: string): SkillRegistration {
  const normalized = raw.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    throw new Error(`bundled skill ${path} is missing opening YAML frontmatter`)
  }
  const closing = /^---(?:\n|$)/mu.exec(normalized.slice(4))
  if (closing === null) {
    throw new Error(`bundled skill ${path} is missing closing YAML frontmatter`)
  }
  const frontmatterEnd = 4 + closing.index
  let data: unknown
  try {
    data = parseYaml(normalized.slice(4, frontmatterEnd)) as unknown
  } catch (error: unknown) {
    throw new Error(`bundled skill ${path} has invalid YAML frontmatter`, { cause: error })
  }
  if (!isRecord(data)) {
    throw new Error(`bundled skill ${path} YAML frontmatter must be an object`)
  }
  for (const key of Object.keys(data)) {
    if (!FRONTMATTER_KEYS.has(key)) {
      throw new Error(`bundled skill ${path} frontmatter contains unsupported field "${key}"`)
    }
  }
  const skillName = requiredString(data, 'name', path)
  if (!SKILL_NAME.test(skillName)) {
    throw new Error(`bundled skill ${path} has invalid kebab-case name "${skillName}"`)
  }
  const description = requiredString(data, 'description', path)
  const whenToUse = optionalString(data, 'whenToUse', path)
  const mcpServers = data['mcpServers'] === undefined
    ? undefined
    : parseSkillMcpReferences(data['mcpServers'], `bundled skill ${path} frontmatter.mcpServers`)
  const body = normalized.slice(frontmatterEnd + closing[0].length).trim()
  if (body.length === 0) throw new Error(`bundled skill ${path} body must not be empty`)

  return {
    name: skillName,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    source: 'bundled',
    provider: 'dsh-autopilot',
    content: body,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    ...(mcpServers === undefined ? {} : { metadata: { mcpServers } }),
  }
}

/**
 * Load every direct child Skill directory from one packaged catalog.
 * @param root - Absolute `assets/skills` directory to scan.
 * @returns Fully parsed registrations in stable name order.
 */
export function loadBundledSkills(root: string): SkillRegistration[] {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  if (entries.length === 0) {
    throw new Error(`bundled skill catalog ${root} contains no Skill directories`)
  }

  const loaded = entries.map((entry) => {
    const path = join(root, entry.name, 'SKILL.md')
    return { directory: entry.name, skill: parseBundledSkill(readFileSync(path, 'utf8'), path) }
  })
  const names = new Map<string, string>()
  for (const item of loaded) {
    const previous = names.get(item.skill.name)
    if (previous !== undefined) {
      throw new Error(
        `bundled skill catalog ${root} has duplicate name "${item.skill.name}" in "${previous}" and "${item.directory}"`,
      )
    }
    names.set(item.skill.name, item.directory)
  }
  for (const item of loaded) {
    if (item.skill.name !== item.directory) {
      throw new Error(
        `bundled skill directory "${item.directory}" must match frontmatter name "${item.skill.name}"`,
      )
    }
  }
  return loaded
    .map(item => item.skill)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

/** Register the complete catalog embedded in this exact published package. */
export function apply(ctx: Context): void {
  const root = fileURLToPath(SKILLS_ROOT_URL)
  const skills = loadBundledSkills(root)
  ctx.effect(() => {
    const disposers = skills.map(skill => ctx.skills.register(skill))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, `dsh-autopilot: ${basename(root)} catalog`)
  registerRecoveryContribution(ctx, 'skills')
}
