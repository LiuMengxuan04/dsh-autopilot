import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it } from 'vitest'
import * as bundledSkills from '../../src/skills.ts'
import { loadBundledSkills, parseBundledSkill } from '../../src/skills.ts'

const EXPECTED_SKILLS = [
  'autonomous-development',
  'autoresearch',
  'code-review',
  'consensus-plan',
  'deep-interview',
  'design-document',
  'dynamic-cordis',
  'git-master',
  'handoff',
  'performance-goal',
  'ralph',
  'ralplan',
  'security-review',
  'start-work',
  'tdd',
  'team-orchestration',
  'ultrawork',
] as const

const roots: string[] = []

function temporaryCatalog(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-autopilot-skills-'))
  roots.push(root)
  return root
}

function writeSkill(root: string, directory: string, name = directory, body = `# ${name}\n\nDo it.`): void {
  const skillRoot = join(root, directory)
  mkdirSync(skillRoot)
  writeFileSync(join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Use ${name} for a focused test.`,
    '---',
    '',
    body,
    '',
  ].join('\n'))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('bundled skill registration', () => {
  it('loads the complete stable catalog and unregisters every Skill with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(bundledSkills)

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name)).toEqual(EXPECTED_SKILLS)
    expect(catalog).toEqual(EXPECTED_SKILLS.map(skillName => expect.objectContaining({
      name: skillName,
      source: 'bundled',
      provider: 'dsh-autopilot',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: {
        kind: 'directory',
        path: expect.stringContaining(`assets/skills/${skillName}`),
      },
    })))

    const headings = new Map([
      ['autonomous-development', '# Autonomous Development'],
      ['autoresearch', '# Autoresearch'],
      ['code-review', '# Code Review'],
      ['consensus-plan', '# Consensus Plan'],
      ['deep-interview', '# Deep Interview'],
      ['design-document', '# Design Document'],
      ['dynamic-cordis', '# Dynamic Cordis'],
      ['git-master', '# Git Master'],
      ['handoff', '# Durable Handoff'],
      ['performance-goal', '# Performance Goal'],
      ['ralph', '# Ralph'],
      ['ralplan', '# Ralplan'],
      ['security-review', '# Security Review'],
      ['start-work', '# Start Work'],
      ['tdd', '# Test-Driven Development'],
      ['team-orchestration', '# Team Orchestration'],
      ['ultrawork', '# Ultrawork'],
    ])
    for (const [skillName, heading] of headings) {
      expect(await ctx.skills.get(skillName)).toMatchObject({
        content: expect.stringContaining(heading),
        path: expect.stringMatching(new RegExp(`assets/skills/${skillName}/SKILL\\.md$`, 'u')),
      })
    }

    await fiber.dispose()
    for (const skillName of EXPECTED_SKILLS) {
      expect(await ctx.skills.get(skillName)).toBeUndefined()
    }
    await ctx.fiber.dispose()
  })

  it('parses CRLF frontmatter, trims fields, and retains optional routing guidance', () => {
    expect(parseBundledSkill([
      '---',
      'name: sample-skill',
      'description: "  Sample description  "',
      'whenToUse: "  During tests  "',
      '---',
      '',
      '  Follow these instructions.  ',
    ].join('\r\n'), '/package/assets/sample-skill/SKILL.md')).toEqual({
      name: 'sample-skill',
      description: 'Sample description',
      whenToUse: 'During tests',
      source: 'bundled',
      provider: 'dsh-autopilot',
      content: 'Follow these instructions.',
      path: '/package/assets/sample-skill/SKILL.md',
      resourceBase: { kind: 'directory', path: '/package/assets/sample-skill' },
    })
  })

  it('retains only validated deployment server references as Skill metadata', () => {
    expect(parseBundledSkill([
      '---',
      'name: mcp-skill',
      'description: Load deployment-owned MCP tools.',
      'mcpServers:',
      '  - docs',
      '  - issue-tracker',
      '---',
      'Use the requested tools.',
    ].join('\n'), '/package/assets/mcp-skill/SKILL.md')).toMatchObject({
      name: 'mcp-skill',
      metadata: { mcpServers: ['docs', 'issue-tracker'] },
    })
  })

  it.each([
    ['plain Markdown', 'missing opening'],
    ['---\nname: sample-skill', 'missing closing'],
    ['---\nname: [\n---\nBody.', 'invalid YAML'],
    ['---\ntext\n---\nBody.', 'must be an object'],
    ['---\nnull\n---\nBody.', 'must be an object'],
    ['---\n[]\n---\nBody.', 'must be an object'],
    ['---\nname: sample-skill\ndescription: Present\nmetadata: {}\n---\nBody.', 'unsupported field "metadata"'],
    ['---\ndescription: Present\n---\nBody.', '"name"'],
    ['---\nname: "  "\ndescription: Present\n---\nBody.', '"name"'],
    ['---\nname: Bad_Name\ndescription: Present\n---\nBody.', 'invalid kebab-case name'],
    ['---\nname: sample-skill\n---\nBody.', '"description"'],
    ['---\nname: sample-skill\ndescription: "  "\n---\nBody.', '"description"'],
    ['---\nname: sample-skill\ndescription: Present\nwhenToUse: 3\n---\nBody.', '"whenToUse"'],
    ['---\nname: sample-skill\ndescription: Present\nwhenToUse: "  "\n---\nBody.', '"whenToUse"'],
    ['---\nname: sample-skill\ndescription: Present\nmcpServers: docs\n---\nBody.', 'non-empty array'],
    ['---\nname: sample-skill\ndescription: Present\nmcpServers: []\n---\nBody.', 'non-empty array'],
    ['---\nname: sample-skill\ndescription: Present\nmcpServers: [Bad_Name]\n---\nBody.', 'lower-kebab-case'],
    ['---\nname: sample-skill\ndescription: Present\nmcpServers: [docs, docs]\n---\nBody.', 'duplicate server ID'],
    ['---\nname: sample-skill\ndescription: Present\n---\n  \n', 'body must not be empty'],
  ])('fails load for an invalid packaged document', (raw, message) => {
    expect(() => parseBundledSkill(raw, '/broken/SKILL.md')).toThrow(message)
  })

  it('scans direct child directories only and returns stable name order', () => {
    const root = temporaryCatalog()
    writeFileSync(join(root, 'README.txt'), 'not a Skill directory')
    writeSkill(root, 'zeta-skill')
    writeSkill(root, 'alpha-skill')
    mkdirSync(join(root, 'alpha-skill', 'agents'))
    writeFileSync(join(root, 'alpha-skill', 'agents', 'openai.yaml'), 'interface: {}\n')

    expect(loadBundledSkills(root)).toEqual([
      expect.objectContaining({ name: 'alpha-skill', path: join(root, 'alpha-skill', 'SKILL.md') }),
      expect.objectContaining({ name: 'zeta-skill', path: join(root, 'zeta-skill', 'SKILL.md') }),
    ])
  })

  it('rejects an empty catalog, duplicate names, directory mismatches, and malformed child Skills', () => {
    const empty = temporaryCatalog()
    writeFileSync(join(empty, 'README.txt'), 'files are ignored')
    expect(() => loadBundledSkills(empty)).toThrow('contains no Skill directories')

    const duplicate = temporaryCatalog()
    writeSkill(duplicate, 'first-directory', 'same-name')
    writeSkill(duplicate, 'second-directory', 'same-name')
    expect(() => loadBundledSkills(duplicate)).toThrow('duplicate name "same-name"')

    const mismatch = temporaryCatalog()
    writeSkill(mismatch, 'directory-name', 'frontmatter-name')
    expect(() => loadBundledSkills(mismatch)).toThrow(
      'directory "directory-name" must match frontmatter name "frontmatter-name"',
    )

    const malformed = temporaryCatalog()
    mkdirSync(join(malformed, 'broken-skill'))
    writeFileSync(join(malformed, 'broken-skill', 'SKILL.md'), '# Missing frontmatter\n')
    expect(() => loadBundledSkills(malformed)).toThrow('missing opening YAML frontmatter')
  })
})
