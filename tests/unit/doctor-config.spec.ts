import { describe, expect, it } from 'vitest'
import { yamlScalarCount } from '../../src/doctor-config.ts'

describe('doctor resolved-profile inspection', () => {
  it('accepts plain, single-quoted, and double-quoted YAML scalars', () => {
    const config = [
      'name: dsh-autopilot/service',
      "  name: 'dsh-autopilot/service'",
      '  name: "dsh-autopilot/service"',
      'name: another-package/service',
    ].join('\n')

    expect(yamlScalarCount(config, 'name', 'dsh-autopilot/service')).toBe(3)
    expect(yamlScalarCount(config, 'name', 'missing/service')).toBe(0)
  })
})
