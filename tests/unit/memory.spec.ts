import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectMemoryService, { ProjectMemoryError, projectMemoryWorkspace } from '../../src/memory.ts'
import { createStorageHarness } from '../helpers.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('project memory service', () => {
  it('persists bounded project entries with compare-and-set revisions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { ctx } = await createStorageHarness()
    await ctx.plugin(ProjectMemoryService, { maxEntriesPerWorkspace: 2, maxValueChars: 40 })

    const created = await ctx.autopilotMemory.write('/workspace', 'decision:api', 'Use the public seam.', ['decision'])
    expect(created).toMatchObject({ revision: 1, value: 'Use the public seam.', tags: ['decision'] })
    expect(ctx.autopilotMemory.read('/workspace', 'decision:api')).toEqual(created)
    expect(ctx.autopilotMemory.list('/workspace')).toEqual([{
      key: 'decision:api', revision: 1, tags: ['decision'], updatedAt: created.updatedAt,
      preview: 'Use the public seam.',
    }])
    await ctx.autopilotMemory.write('/workspace', 'alpha', 'Sorted first.')
    expect(ctx.autopilotMemory.list('/workspace').map(entry => entry.key)).toEqual(['alpha', 'decision:api'])

    vi.setSystemTime(created.updatedAt + 100)
    const updated = await ctx.autopilotMemory.write(
      '/workspace', 'decision:api', 'Use the typed public seam.', ['decision'], 1,
    )
    expect(updated).toMatchObject({ revision: 2, createdAt: created.createdAt, updatedAt: created.updatedAt + 100 })
    await expect(ctx.autopilotMemory.write('/workspace', 'decision:api', 'stale', [], 1))
      .rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    await expect(ctx.autopilotMemory.write('/other', 'missing', 'value', [], 1))
      .rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    await expect(ctx.autopilotMemory.delete('/workspace', 'decision:api', 1))
      .rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    await expect(ctx.autopilotMemory.delete('/workspace', 'decision:api', 2)).resolves.toBe(true)
    await expect(ctx.autopilotMemory.delete('/workspace', 'decision:api')).resolves.toBe(false)
    await ctx.fiber.dispose()
  })

  it('enforces workspace entry, value, key, and tag limits', async () => {
    const { ctx } = await createStorageHarness()
    await ctx.plugin(ProjectMemoryService, { maxEntriesPerWorkspace: 1, maxValueChars: 4 })
    await ctx.autopilotMemory.write('/one', 'a', '1234')
    await expect(ctx.autopilotMemory.write('/one', 'b', 'x')).rejects.toMatchObject({ code: 'MEMORY_LIMIT' })
    expect(() => ctx.autopilotMemory.write('/two', 'a', '12345')).toThrow(ProjectMemoryError)
    expect(() => ctx.autopilotMemory.write('/two', 'Bad', 'x')).toThrow(ProjectMemoryError)
    expect(() => ctx.autopilotMemory.write('/two', 'good', 'x', ['bad_tag'])).toThrow(ProjectMemoryError)
    expect(() => ctx.autopilotMemory.write('/two', 'good', 'x', ['same', 'same'])).toThrow(ProjectMemoryError)
    expect(() => projectMemoryWorkspace(' ')).toThrow(ProjectMemoryError)
    await ctx.fiber.dispose()
  })

  it('serializes concurrent creation and retains only bounded previews', async () => {
    const { ctx } = await createStorageHarness()
    await ctx.plugin(ProjectMemoryService, { maxEntriesPerWorkspace: 1, maxValueChars: 500 })
    const settled = await Promise.allSettled([
      ctx.autopilotMemory.write('/workspace', 'one', 'x'.repeat(250)),
      ctx.autopilotMemory.write('/workspace', 'two', 'second'),
    ])
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(ctx.autopilotMemory.list('/workspace')[0]?.preview).toHaveLength(201)
    await ctx.fiber.dispose()
  })

  it('retains constructor defaults for direct service embeddings', async () => {
    const ctx = new Context()
    new ProjectMemoryService(ctx)
    await ctx.fiber.dispose()
  })
})
