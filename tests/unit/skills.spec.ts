import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as bundledSkills from '../../src/skills.ts'
import { parseBundledSkill } from '../../src/skills.ts'

describe('bundled skill registration', () => {
  it('loads the published autonomous-development artifact and unregisters with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(bundledSkills)

    expect(await ctx.skills.list()).toEqual([
      expect.objectContaining({
        name: 'autonomous-development',
        source: 'bundled',
        provider: 'oh-my-dsh',
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: {
          kind: 'directory',
          path: expect.stringContaining('assets/skills/autonomous-development'),
        },
      }),
    ])
    expect(await ctx.skills.get('autonomous-development')).toMatchObject({
      content: expect.stringContaining('# Autonomous Development'),
      path: expect.stringMatching(/assets\/skills\/autonomous-development\/SKILL\.md$/u),
    })

    await fiber.dispose()
    expect(await ctx.skills.get('autonomous-development')).toBeUndefined()
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
    ].join('\r\n'), '/package/assets/sample/SKILL.md')).toEqual({
      name: 'sample-skill',
      description: 'Sample description',
      whenToUse: 'During tests',
      source: 'bundled',
      provider: 'oh-my-dsh',
      content: 'Follow these instructions.',
      path: '/package/assets/sample/SKILL.md',
      resourceBase: { kind: 'directory', path: '/package/assets/sample' },
    })
  })

  it.each([
    ['plain Markdown', 'missing opening'],
    ['---\nname: sample-skill', 'missing closing'],
    ['---\nname: [\n---\nBody.', 'invalid YAML'],
    ['---\ntext\n---\nBody.', 'must be an object'],
    ['---\ndescription: Present\n---\nBody.', '"name"'],
    ['---\nname: "  "\ndescription: Present\n---\nBody.', '"name"'],
    ['---\nname: sample-skill\n---\nBody.', '"description"'],
    ['---\nname: sample-skill\ndescription: "  "\n---\nBody.', '"description"'],
    ['---\nname: sample-skill\ndescription: Present\nwhenToUse: 3\n---\nBody.', '"whenToUse"'],
    ['---\nname: sample-skill\ndescription: Present\nwhenToUse: "  "\n---\nBody.', '"whenToUse"'],
    ['---\nname: sample-skill\ndescription: Present\n---\n  \n', 'body must not be empty'],
  ])('fails load for an invalid packaged document', (raw, message) => {
    expect(() => parseBundledSkill(raw, '/broken/SKILL.md')).toThrow(message)
  })
})
