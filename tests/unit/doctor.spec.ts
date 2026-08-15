import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inspectResolvedProfile: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }))
vi.mock('../../src/doctor-config.ts', () => ({
  inspectResolvedProfile: mocks.inspectResolvedProfile,
}))

import { runDoctor } from '../../src/doctor.ts'

describe('doctor command', () => {
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  const previousExecutable = process.env['DSH_AUTOPILOT_DSH_BIN']

  beforeEach(() => {
    mocks.spawnSync.mockReset()
    mocks.inspectResolvedProfile.mockReset()
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env['DSH_AUTOPILOT_DSH_BIN'] = 'test-dsh'
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: 'resolved profile', stderr: '' })
    mocks.inspectResolvedProfile.mockReturnValue([{ level: 'pass', message: 'profile ready' }])
  })

  afterEach(() => {
    if (previousExecutable === undefined) delete process.env['DSH_AUTOPILOT_DSH_BIN']
    else process.env['DSH_AUTOPILOT_DSH_BIN'] = previousExecutable
    vi.restoreAllMocks()
  })

  it('prints every readiness result and preserves a successful warning exit', () => {
    mocks.inspectResolvedProfile.mockReturnValue([
      { level: 'pass', message: 'profile ready' },
      { level: 'warn', message: 'automatic checks only' },
    ])

    expect(runDoctor(['doctor', '--profile', 'web'])).toBe(0)
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'test-dsh',
      ['--profile', 'web', '--dump-config'],
      { encoding: 'utf8' },
    )
    expect(stdout.mock.calls.flat().join('')).toContain('[WARN] automatic checks only')
    expect(stdout.mock.calls.flat().join('')).toContain('correctly installed and ready (1 warning(s))')
    expect(stderr).not.toHaveBeenCalled()
  })

  it('prints mixed diagnostics to stderr and exits one when readiness fails', () => {
    mocks.inspectResolvedProfile.mockReturnValue([
      { level: 'pass', message: 'one pass' },
      { level: 'fail', message: 'one failure' },
    ])

    expect(runDoctor([])).toBe(1)
    expect(stderr.mock.calls.flat().join('')).toContain('[PASS] one pass')
    expect(stderr.mock.calls.flat().join('')).toContain('[FAIL] readiness: 1 failure(s), 0 warning(s)')
    expect(stdout).not.toHaveBeenCalled()
  })

  it('reports command execution and nonzero dump failures', () => {
    mocks.spawnSync.mockReturnValueOnce({ error: new Error('not found'), stdout: '', stderr: '' })
    expect(runDoctor([])).toBe(1)
    expect(stderr.mock.calls.flat().join('')).toContain('could not execute test-dsh: not found')

    stderr.mockClear()
    mocks.spawnSync.mockReturnValueOnce({ status: 7, stdout: '', stderr: 'broken profile' })
    expect(runDoctor([])).toBe(1)
    expect(stderr.mock.calls.flat().join('')).toContain('dsh exited 7: broken profile')
    expect(mocks.inspectResolvedProfile).not.toHaveBeenCalled()
  })

  it('prints help without running dump-config', () => {
    expect(runDoctor(['-h'])).toBe(0)
    expect(stdout.mock.calls.flat().join('')).toContain('Usage: dsh-autopilot doctor')
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })

  it.each([
    [['--profile'], '--profile requires a value'],
    [['--profile', '--bad'], '--profile requires a value'],
    [['--bad'], 'unknown argument: --bad'],
  ])('rejects invalid arguments %#', (args, message) => {
    expect(runDoctor(args)).toBe(2)
    expect(stderr.mock.calls.flat().join('')).toContain(message)
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })
})
