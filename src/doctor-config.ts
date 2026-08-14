/** Count exact plain or quoted YAML scalar lines in a resolved DSH profile. */
export function yamlScalarCount(config: string, key: string, value: string): number {
  const forms = new Set([
    `${key}: ${value}`,
    `${key}: '${value}'`,
    `${key}: "${value}"`,
  ])
  return config.split('\n').filter(line => forms.has(line.trim())).length
}
