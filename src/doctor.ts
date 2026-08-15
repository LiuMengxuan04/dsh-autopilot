#!/usr/bin/env node
/** Installation and operational-readiness diagnostics for a packed DSH Autopilot bundle. */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectResolvedProfile } from './doctor-config.ts'
import type { DoctorDiagnostic } from './doctor-config.ts'

interface DoctorOptions {
  readonly profile: string
  readonly executable: string
}

/** Return whether the current Node version satisfies the package engine floor. */
function supportedNode(version: string): boolean {
  const [majorText, minorText] = version.split('.')
  const major = Number(majorText)
  const minor = Number(minorText)
  return major >= 24 || (major === 22 && minor >= 19)
}

/** Parse the intentionally small doctor command line. */
function parseOptions(argv: readonly string[]): DoctorOptions | undefined {
  const args = argv[0] === 'doctor' ? argv.slice(1) : [...argv]
  if (args.includes('--help') || args.includes('-h')) return undefined
  let profile = 'web'
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--profile') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--profile requires a value')
      profile = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${String(argument)}`)
  }
  return {
    profile,
    executable: process.env['DSH_AUTOPILOT_DSH_BIN']
      ?? (process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
  }
}

function renderDiagnostic(item: DoctorDiagnostic): string {
  return `[${item.level.toUpperCase()}] ${item.message}`
}

/** Run diagnostics and return a process exit code. */
export function runDoctor(argv: readonly string[]): number {
  let options: DoctorOptions | undefined
  try {
    options = parseOptions(argv)
  } catch (error: unknown) {
    process.stderr.write(`dsh-autopilot doctor: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (options === undefined) {
    process.stdout.write('Usage: dsh-autopilot doctor [--profile web]\n')
    return 0
  }

  const diagnostics: DoctorDiagnostic[] = []
  diagnostics.push(supportedNode(process.versions.node)
    ? { level: 'pass', message: `runtime: Node ${process.versions.node} satisfies ^22.19 or >=24` }
    : { level: 'fail', message: `runtime: Node ${process.versions.node} is unsupported; use ^22.19 or >=24` })

  const dumped = spawnSync(
    options.executable,
    ['--profile', options.profile, '--dump-config'],
    { encoding: 'utf8' },
  )
  if (dumped.error !== undefined) {
    diagnostics.push({ level: 'fail', message: `dump-config: could not execute ${options.executable}: ${dumped.error.message}` })
  } else if (dumped.status !== 0) {
    diagnostics.push({
      level: 'fail',
      message: `dump-config: dsh exited ${String(dumped.status)}: ${dumped.stderr.trim()}`,
    })
  } else {
    diagnostics.push(...inspectResolvedProfile(dumped.stdout))
  }

  const failures = diagnostics.filter(item => item.level === 'fail').length
  const warnings = diagnostics.filter(item => item.level === 'warn').length
  const lines = diagnostics.map(renderDiagnostic).join('\n')
  if (failures > 0) {
    process.stderr.write(`DSH Autopilot doctor for profile "${options.profile}":\n${lines}\n`)
    process.stderr.write(`[FAIL] readiness: ${failures} failure(s), ${warnings} warning(s)\n`)
    return 1
  }
  process.stdout.write(`DSH Autopilot doctor for profile "${options.profile}":\n${lines}\n`)
  process.stdout.write(`[PASS] DSH Autopilot is correctly installed and ready (${warnings} warning(s)).\n`)
  return 0
}

if (process.argv[1] !== undefined
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runDoctor(process.argv.slice(2))
}
