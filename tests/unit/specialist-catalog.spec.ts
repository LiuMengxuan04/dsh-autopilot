import { describe, expect, it } from 'vitest'
import {
  SPECIALIST_CATALOG,
  SPECIALIST_CATEGORIES,
  SPECIALIST_READ_ONLY_TOOLS,
  getSpecialist,
  getSpecialistCategory,
  specialistCatalogJson,
} from '../../src/specialist-catalog.ts'

describe('specialist catalog', () => {
  it('packages the complete named agent and category inventories with stable unique ids', () => {
    expect(SPECIALIST_CATALOG).toHaveLength(27)
    expect(new Set(SPECIALIST_CATALOG.map(item => item.id)).size).toBe(27)
    expect(SPECIALIST_CATALOG.map(item => item.id)).toEqual(expect.arrayContaining([
      'sisyphus', 'hephaestus', 'oracle', 'librarian', 'explore', 'multimodal-looker',
      'prometheus', 'metis', 'momus', 'atlas', 'sisyphus-junior',
      'analyst', 'planner', 'architect', 'debugger', 'executor', 'verifier',
      'code-reviewer', 'dependency-expert', 'test-engineer', 'designer', 'writer',
      'git-master', 'researcher', 'critic', 'scholastic', 'vision',
    ]))
    expect(SPECIALIST_CATEGORIES.map(item => item.id)).toEqual([
      'visual-engineering', 'ultrabrain', 'deep', 'artistry', 'quick',
      'unspecified-low', 'unspecified-high', 'writing',
    ])
    expect(SPECIALIST_CATALOG.every(item => item.toolPolicy === 'read-only')).toBe(true)
    expect(SPECIALIST_READ_ONLY_TOOLS).toContain('grep')
    expect(SPECIALIST_READ_ONLY_TOOLS).not.toContain('bash')
    expect(SPECIALIST_READ_ONLY_TOOLS).not.toContain('get_autopilot')
    expect(SPECIALIST_READ_ONLY_TOOLS).not.toContain('get_goal')
  })

  it('resolves exact ids and returns undefined for unknown or inexact ids', () => {
    expect(getSpecialist('oracle')).toMatchObject({ label: 'Oracle', family: 'shared' })
    expect(getSpecialist('Oracle')).toBeUndefined()
    expect(getSpecialistCategory('ultrabrain')).toMatchObject({
      specialists: ['oracle', 'architect', 'scholastic'],
    })
    expect(getSpecialistCategory('missing')).toBeUndefined()
  })

  it('projects mutable JSON arrays without exposing catalog-owned arrays', () => {
    const json = specialistCatalogJson() as {
      specialists: Array<Record<string, string>>
      categories: Array<{ id: string, specialists: string[] }>
    }
    expect(json.specialists[0]).toMatchObject({ id: 'sisyphus', toolPolicy: 'read-only' })
    const category = json.categories[0]
    expect(category).toBeDefined()
    category?.specialists.push('mutation')
    expect(getSpecialistCategory('visual-engineering')?.specialists).not.toContain('mutation')
  })
})
