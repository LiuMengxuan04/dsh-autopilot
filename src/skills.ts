/** Packaged autonomous-development skill registered without host profile paths. */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

export const name = 'dsh-autopilot-skills'
export const inject = ['skills']

const SKILL_FILE_URL = new URL(
  '../assets/skills/autonomous-development/SKILL.md',
  import.meta.url,
)

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
  const skillName = requiredString(data, 'name', path)
  const description = requiredString(data, 'description', path)
  const whenToUse = optionalString(data, 'whenToUse', path)
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
  }
}

/** Register the skill embedded in this exact published package. */
export function apply(ctx: Context): void {
  const path = fileURLToPath(SKILL_FILE_URL)
  const skill = parseBundledSkill(readFileSync(path, 'utf8'), path)
  ctx.skills.register(skill)
}
