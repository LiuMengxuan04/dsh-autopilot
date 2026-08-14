import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
})
