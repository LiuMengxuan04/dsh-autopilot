import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../src/index.ts'

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string }

describe('package entry point', () => {
  it('exports stable package metadata', () => {
    expect(PACKAGE_NAME).toBe(manifest.name)
    expect(PACKAGE_VERSION).toBe(manifest.version)
  })
})
