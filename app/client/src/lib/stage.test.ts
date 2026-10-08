import { describe, test, expect } from 'vitest'
import { RE2JS } from 're2js'
import { deriveStage, type StageMapping } from './stage'
import { applyFilters } from './filters/matcher'
import { compileFilters } from './filters/compile'
import { SEED_FILTERS } from '../../../server/src/storage/seed-filters'
import type { Agent, Filter, ParsedEvent } from '@/types'

const mapping: StageMapping = {
  main: 'Orchestrating',
  stages: { 'code-reviewer': { label: 'Reviewing' }, planner: { label: 'Planning' } },
}

const mainAgent = { id: 's1', sessionId: 's1', parentAgentId: null } as Agent
const sub = (agentType: string | null) =>
  ({ id: 'a1', sessionId: 's1', parentAgentId: 's1', agentType }) as Agent

let n = 0
const ev = (hookName: string, agentId = 'a1', payload: Record<string, unknown> = {}) =>
  ({ id: ++n, agentId, hookName, timestamp: n * 10, payload }) as ParsedEvent

describe('deriveStage', () => {
  test('base stage from agent_type', () => {
    expect(deriveStage(sub('code-reviewer'), [ev('PreToolUse')], mapping)).toEqual({
      label: 'Reviewing',
      kind: 'base',
    })
  })

  test('main thread uses mapping.main', () => {
    expect(deriveStage(mainAgent, [ev('PreToolUse', 's1')], mapping)?.label).toBe('Orchestrating')
  })

  test('unknown or missing type gives null, never throws', () => {
    expect(deriveStage(sub('mystery'), [ev('PreToolUse')], mapping)).toBeNull()
    expect(deriveStage(sub('constructor'), [], mapping)).toBeNull()
    expect(deriveStage(sub(null), [], mapping)).toBeNull()
    expect(deriveStage(sub('planner'), [], null)).toBeNull()
  })

  test('unresolved PermissionRequest shows Needs input', () => {
    const evs = [ev('PreToolUse'), ev('PermissionRequest')]
    expect(deriveStage(sub('planner'), evs, mapping)).toEqual({
      label: 'Needs input',
      kind: 'needs-input',
    })
  })

  test('unresolved permission_prompt / agent_needs_input notifications', () => {
    for (const t of ['permission_prompt', 'agent_needs_input']) {
      const evs = [ev('Notification', 'a1', { notification_type: t })]
      expect(deriveStage(sub('planner'), evs, mapping)?.kind).toBe('needs-input')
    }
    const idle = [ev('Notification', 'a1', { notification_type: 'idle_prompt' })]
    expect(deriveStage(sub('planner'), idle, mapping)?.kind).toBe('base')
  })

  test.each(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Stop', 'SubagentStop'])(
    'resolved by later %s',
    (hook) => {
      const evs = [ev('PermissionRequest'), ev(hook)]
      expect(deriveStage(sub('planner'), evs, mapping)?.kind).not.toBe('needs-input')
    },
  )

  test('another agent resolving does not clear needs-input', () => {
    const evs = [ev('PermissionRequest'), ev('PostToolUse', 'other')]
    expect(deriveStage(sub('planner'), evs, mapping)?.kind).toBe('needs-input')
  })

  test('Done after SubagentStop (payload agent_id) and Stop', () => {
    const stop = [ev('PreToolUse'), ev('SubagentStop', 'parent', { agent_id: 'a1' })]
    expect(deriveStage(sub('planner'), stop, mapping)).toEqual({ label: 'Done', kind: 'done' })
    expect(deriveStage(mainAgent, [ev('Stop', 's1')], mapping)?.kind).toBe('done')
    // The sub's stop must not mark the main thread done.
    expect(deriveStage(mainAgent, [ev('SubagentStop', 's1', { agent_id: 'a1' })], mapping)?.kind).toBe(
      'base',
    )
  })

  test('Failed after StopFailure; resumes after new work', () => {
    const failed = [ev('PreToolUse', 's1'), ev('StopFailure', 's1')]
    expect(deriveStage(mainAgent, failed, mapping)).toEqual({ label: 'Failed', kind: 'failed' })
    const again = [...failed, ev('UserPromptSubmit', 's1')]
    expect(deriveStage(mainAgent, again, mapping)?.kind).toBe('base')
  })

  test('replay is deterministic regardless of order or repetition', () => {
    const evs = [ev('PreToolUse'), ev('PermissionRequest'), ev('PostToolUse'), ev('Stop')]
    const a = deriveStage(sub('planner'), evs, mapping)
    const b = deriveStage(sub('planner'), [...evs].reverse(), mapping)
    const c = deriveStage(sub('planner'), evs, mapping)
    expect(a).toEqual({ label: 'Done', kind: 'done' })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })
})

describe('seeded Needs input filter under the real RE2 matcher', () => {
  const seed = SEED_FILTERS.find((f) => f.id === 'default-needs-input')!
  const compiled = compileFilters([
    { ...seed, enabled: true, kind: 'default' } as unknown as Filter,
  ])
  const hit = (hookName: string, payload: Record<string, unknown>) =>
    applyFilters({ id: 1, agentId: 'a', hookName, timestamp: 0, payload }, null, compiled)
      .primary.length > 0

  test('compiles under re2js', () => {
    expect(compiled).toHaveLength(1)
    for (const p of seed.patterns) expect(() => RE2JS.compile(p.regex)).not.toThrow()
  })

  test('matches PermissionRequest and the two notification types only', () => {
    expect(hit('PermissionRequest', {})).toBe(true)
    expect(hit('Notification', { notification_type: 'permission_prompt' })).toBe(true)
    expect(hit('Notification', { notification_type: 'agent_needs_input' })).toBe(true)
    expect(hit('Notification', { notification_type: 'idle_prompt' })).toBe(false)
    expect(hit('PostToolUse', {})).toBe(false)
  })
})
