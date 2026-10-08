import { describe, test, expect } from 'vitest'
import { SqliteAdapter } from '../storage/sqlite-adapter'
import { SEED_FILTERS } from '../storage/seed-filters'
import type { FilterPattern } from '../types'

// Mirrors the client matcher: hook -> hookName, payload -> JSON.stringify(raw),
// with the client's `^.*?(?:...)` anchor wrap for unanchored sources.
function matches(
  patterns: FilterPattern[],
  combinator: 'and' | 'or',
  raw: { hookName: string; payload: Record<string, unknown> },
): boolean {
  const results = patterns.map((p) => {
    const target = p.target === 'hook' ? raw.hookName : JSON.stringify(raw)
    const src = p.regex.startsWith('^') ? p.regex : `^.*?(?:${p.regex})`
    const hit = new RegExp(src).test(target)
    return p.negate ? !hit : hit
  })
  return combinator === 'and' ? results.every(Boolean) : results.some(Boolean)
}

describe('default-needs-input filter', () => {
  const seed = SEED_FILTERS.find((s) => s.id === 'default-needs-input')!
  const run = (hookName: string, payload: Record<string, unknown>) =>
    matches(seed.patterns, seed.combinator, { hookName, payload })

  test('seeding creates the filter', async () => {
    const adapter = new SqliteAdapter(':memory:')
    await adapter.seedDefaultFilters()
    const f = await adapter.getFilterById('default-needs-input')
    expect(f).not.toBeNull()
    expect(f?.name).toBe('Needs input')
    expect(f?.kind).toBe('default')
    expect(f?.enabled).toBe(true)
    expect(f?.combinator).toBe('or')
  })

  test('PermissionRequest matches', () => {
    expect(run('PermissionRequest', { tool_name: 'Bash' })).toBe(true)
  })

  test('Notification permission_prompt matches', () => {
    expect(run('Notification', { notification_type: 'permission_prompt' })).toBe(true)
  })

  test('Notification agent_needs_input matches', () => {
    expect(run('Notification', { notification_type: 'agent_needs_input' })).toBe(true)
  })

  test('Notification idle_prompt does not match', () => {
    expect(run('Notification', { notification_type: 'idle_prompt' })).toBe(false)
  })

  test('ordinary PreToolUse does not match', () => {
    expect(run('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } })).toBe(false)
  })
})
