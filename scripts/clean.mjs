import { rm } from 'node:fs/promises'

await Promise.all([
  rm(new URL('../lib', import.meta.url), { recursive: true, force: true }),
  rm(new URL('../coverage', import.meta.url), { recursive: true, force: true }),
  rm(new URL('../.artifacts', import.meta.url), { recursive: true, force: true }),
])
