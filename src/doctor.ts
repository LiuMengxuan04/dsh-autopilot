#!/usr/bin/env node
/** Installation diagnostics for a packed DSH Autopilot bundle. */
import { spawnSync } from 'node:child_process'

interface DoctorOptions {
  readonly profile: string
  readonly executable: string
}

const EXPECTED_ROWS = [
  'dsh-autopilot-service',
  'dsh-autopilot-commands',
  'dsh-autopilot-tools',
  'dsh-autopilot-skills',
] as const

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

/** Count a stable Loader row id in dumped YAML. */
function rowCount(config: string, id: string): number {
  return config.split('\n').filter(line => line.trim() === `- id: ${id}` || line.trim() === `id: ${id}`).length
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

  const failures: string[] = []
  if (!supportedNode(process.versions.node)) {
    failures.push(`Node ${process.versions.node} is unsupported; use ^22.19 or >=24`)
  }
  const dumped = spawnSync(
    options.executable,
    ['--profile', options.profile, '--dump-config'],
    { encoding: 'utf8' },
  )
  if (dumped.error !== undefined) {
    failures.push(`could not execute ${options.executable}: ${dumped.error.message}`)
  } else if (dumped.status !== 0) {
    failures.push(`dsh --dump-config exited ${String(dumped.status)}: ${dumped.stderr.trim()}`)
  } else {
    for (const row of EXPECTED_ROWS) {
      const count = rowCount(dumped.stdout, row)
      if (count !== 1) failures.push(`expected Loader row "${row}" exactly once, found ${count}`)
    }
    if (!dumped.stdout.includes("name: '@liumengxuan04/dsh-autopilot/service'")
      || !dumped.stdout.includes("name: '@liumengxuan04/dsh-autopilot/commands'")
      || !dumped.stdout.includes("name: '@liumengxuan04/dsh-autopilot/tools'")
      || !dumped.stdout.includes("name: '@liumengxuan04/dsh-autopilot/skills'")) {
      failures.push('one or more DSH Autopilot module names are missing from the resolved profile')
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`DSH Autopilot doctor found ${failures.length} problem(s):\n`)
    for (const failure of failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }
  process.stdout.write(`DSH Autopilot is correctly installed in DSH profile "${options.profile}".\n`)
  return 0
}

process.exitCode = runDoctor(process.argv.slice(2))
