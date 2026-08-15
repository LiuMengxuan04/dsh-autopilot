import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AutopilotLifecycleHookService,
  AutopilotRunDashboardService,
  AutopilotRecovery,
  AutopilotRecoveryCoordinator,
  AutopilotRecoveryReadiness,
  ManagedWorkflowService,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  planRunRecovery,
  recoveryRunRef,
} from '../../src/index.ts'

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string }

describe('package entry point', () => {
  it('exports stable package metadata', () => {
    expect(PACKAGE_NAME).toBe(manifest.name)
    expect(PACKAGE_VERSION).toBe(manifest.version)
    expect(AutopilotRecovery).toBeTypeOf('function')
    expect(AutopilotRecoveryCoordinator).toBeTypeOf('function')
    expect(AutopilotRecoveryReadiness).toBeTypeOf('function')
    expect(AutopilotLifecycleHookService).toBeTypeOf('function')
    expect(AutopilotRunDashboardService).toBeTypeOf('function')
    expect(ManagedWorkflowService).toBeTypeOf('function')
    expect(planRunRecovery).toBeTypeOf('function')
    expect(recoveryRunRef).toBeTypeOf('function')
  })
})
