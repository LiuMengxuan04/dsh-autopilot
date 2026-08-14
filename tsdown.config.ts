import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/service.ts',
    'src/commands.ts',
    'src/tools.ts',
    'src/skills.ts',
    'src/doctor.ts',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//u] },
})
