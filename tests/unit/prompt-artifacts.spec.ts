import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPromptArtifacts,
  parsePromptArtifact,
  resolvePromptArtifactRoot,
} from '../../src/prompt-artifacts.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autopilot-artifacts-'))
  roots.push(root)
  return root
}

function document(frontmatter: string, body = 'Follow this rule.'): string {
  return `---\n${frontmatter}\n---\n${body}\n`
}

const limits = { maxFiles: 8, maxFileBytes: 4096, maxTotalBytes: 8192 }

describe('prompt artifact paths and parsing', () => {
  it('resolves deployment-absolute and workspace-relative roots', async () => {
    const workspace = await temporaryRoot()
    expect(resolvePromptArtifactRoot(workspace, '.dsh/prompts')).toBe(join(workspace, '.dsh/prompts'))
    expect(resolvePromptArtifactRoot(undefined, join(workspace, 'absolute'))).toBe(join(workspace, 'absolute'))
    expect(() => resolvePromptArtifactRoot(undefined, 'relative')).toThrow(/requires an absolute Agent workspace/)
    expect(() => resolvePromptArtifactRoot('relative', 'prompts')).toThrow(/requires an absolute Agent workspace/)
    expect(() => resolvePromptArtifactRoot(workspace, '../escape')).toThrow(/escapes Agent workspace/)
    expect(() => resolvePromptArtifactRoot(workspace, '')).toThrow(/non-empty path/)
    expect(() => resolvePromptArtifactRoot(workspace, 'bad\0path')).toThrow(/NUL/)
  })

  it('parses strict CRLF frontmatter and freezes detached metadata', () => {
    const parsed = parsePromptArtifact(
      '---\r\nname: safe\r\ntags: [one, two]\r\n---\r\n\r\nDo the work.\r\n',
      '/safe.md',
    )
    expect(parsed).toEqual({ frontmatter: { name: 'safe', tags: ['one', 'two'] }, body: 'Do the work.' })
    expect(Object.isFrozen(parsed.frontmatter)).toBe(true)
  })

  it.each([
    ['name: missing-open\n---\nbody', /missing opening/],
    ['---\nname: missing-close\nbody', /missing closing/],
    ['---\nname: [broken\n---\nbody', /invalid YAML/],
    ['---\n- list\n---\nbody', /must be an object/],
    ['---\nname: safe\n---\n   ', /body must not be empty/],
  ])('rejects malformed document %j', (raw, message) => {
    expect(() => parsePromptArtifact(raw, '/bad.md')).toThrow(message)
  })

  it('rejects aliases and every explicit YAML tag without constructing them', () => {
    expect(() => parsePromptArtifact(document('base: &base safe\ncopy: *base'), '/alias.md'))
      .toThrow(/aliases are not allowed/)
    expect(() => parsePromptArtifact(document('value: !!str safe'), '/tag.md'))
      .toThrow(/explicit YAML tags are not allowed/)
    expect(() => parsePromptArtifact(document('value: !!js/function >\n  function () { return 1 }'), '/code.md'))
      .toThrow(/invalid YAML|explicit YAML tags/)
  })
})

describe('bounded catalog loading', () => {
  it('recurses, ignores non-Markdown regular files, hashes content, and sorts paths', async () => {
    const workspace = await temporaryRoot()
    const catalog = join(workspace, '.dsh', 'prompts')
    await mkdir(join(catalog, 'nested'), { recursive: true })
    await writeFile(join(catalog, 'z.md'), document('name: zed'))
    await writeFile(join(catalog, 'nested', 'a.MD'), document('name: alpha'))
    await writeFile(join(catalog, 'notes.txt'), 'not an artifact')

    const artifacts = loadPromptArtifacts(workspace, '.dsh/prompts', limits)
    expect(artifacts.map(artifact => artifact.relativePath)).toEqual(['nested/a.MD', 'z.md'])
    expect(artifacts[0]).toMatchObject({ body: 'Follow this rule.', bytes: expect.any(Number) })
    expect(artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(Object.isFrozen(artifacts)).toBe(true)
    expect(Object.isFrozen(artifacts[0])).toBe(true)
    expect(loadPromptArtifacts(workspace, catalog, limits)).toHaveLength(2)
  })

  it('accepts an empty real directory and rejects missing, file, and linked roots', async () => {
    const workspace = await temporaryRoot()
    const empty = join(workspace, 'empty')
    await mkdir(empty)
    expect(loadPromptArtifacts(workspace, 'empty', limits)).toEqual([])
    expect(() => loadPromptArtifacts(workspace, 'missing', limits)).toThrow(/cannot inspect artifact directory/)

    const file = join(workspace, 'file.md')
    await writeFile(file, document('name: file'))
    expect(() => loadPromptArtifacts(undefined, file, limits)).toThrow(/must be a real directory/)

    const linked = join(workspace, 'linked')
    await symlink(empty, linked, 'dir')
    expect(() => loadPromptArtifacts(workspace, 'linked', limits)).toThrow(/must be a real directory/)
  })

  it('rejects links inside the catalog and a linked parent that resolves outside the workspace', async () => {
    const workspace = await temporaryRoot()
    const outside = await temporaryRoot()
    const catalog = join(workspace, 'catalog')
    await mkdir(catalog)
    const target = join(outside, 'target.md')
    await writeFile(target, document('name: target'))
    await symlink(target, join(catalog, 'linked.md'))
    expect(() => loadPromptArtifacts(workspace, 'catalog', limits)).toThrow(/contains symbolic link/)

    const externalCatalog = join(outside, 'catalog')
    await mkdir(externalCatalog)
    await symlink(outside, join(workspace, 'outside'), 'dir')
    expect(() => loadPromptArtifacts(workspace, 'outside/catalog', limits)).toThrow(/resolves outside Agent workspace/)
  })

  it('rejects a non-regular catalog entry', async () => {
    const workspace = await temporaryRoot()
    const catalog = join(workspace, 'catalog')
    await mkdir(catalog)
    const socketPath = join(catalog, 'prompt.socket')
    const server = createServer()
    await new Promise<void>((accept, reject) => {
      server.once('error', reject)
      server.listen(socketPath, accept)
    })
    try {
      expect(() => loadPromptArtifacts(workspace, 'catalog', limits)).toThrow(/not a regular file/)
    } finally {
      await new Promise<void>((accept, reject) => server.close(error => error === undefined ? accept() : reject(error)))
    }
  })

  it('validates deployment limits before scanning', async () => {
    const workspace = await temporaryRoot()
    await mkdir(join(workspace, 'catalog'))
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => loadPromptArtifacts(workspace, 'catalog', {
        maxFiles: invalid, maxFileBytes: 4, maxTotalBytes: 8,
      })).toThrow(/maxFiles must be a positive safe integer/)
    }
    expect(() => loadPromptArtifacts(workspace, 'catalog', {
      maxFiles: 1, maxFileBytes: 9, maxTotalBytes: 8,
    })).toThrow(/must not exceed/)
  })

  it('enforces file-count, per-file, and aggregate byte ceilings', async () => {
    const workspace = await temporaryRoot()
    const catalog = join(workspace, 'catalog')
    await mkdir(catalog)
    const first = document('name: first', '1234567890')
    const second = document('name: second', 'abcdefghij')
    await writeFile(join(catalog, 'a.md'), first)
    await writeFile(join(catalog, 'b.md'), second)
    expect(() => loadPromptArtifacts(workspace, 'catalog', {
      maxFiles: 1, maxFileBytes: 4096, maxTotalBytes: 8192,
    })).toThrow(/2 Markdown files/)
    expect(() => loadPromptArtifacts(workspace, 'catalog', {
      maxFiles: 2, maxFileBytes: Buffer.byteLength(first) - 1, maxTotalBytes: 8192,
    })).toThrow(/per-file maximum/)
    expect(() => loadPromptArtifacts(workspace, 'catalog', {
      maxFiles: 2,
      maxFileBytes: Math.max(Buffer.byteLength(first), Buffer.byteLength(second)),
      maxTotalBytes: Buffer.byteLength(first) + Buffer.byteLength(second) - 1,
    })).toThrow(/total maximum/)
  })

  it('rejects invalid UTF-8', async () => {
    const workspace = await temporaryRoot()
    const catalog = join(workspace, 'catalog')
    await mkdir(catalog)
    await writeFile(join(catalog, 'bad.md'), Buffer.from([0xff, 0xfe, 0xfd]))
    expect(() => loadPromptArtifacts(workspace, 'catalog', limits)).toThrow(/not valid UTF-8/)
  })
})
