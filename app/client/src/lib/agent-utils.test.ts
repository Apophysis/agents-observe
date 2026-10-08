import { describe, it, expect } from 'vitest'
import {
  getAgentDisplayName,
  buildAgentColorMap,
  getAgentColor,
  getAgentColorById,
  isBackgroundLane,
  orderAgentLanes,
} from './agent-utils'
import type { Agent } from '@/types'

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: 'agent-1',
    sessionId: 'sess-1',
    parentAgentId: null,
    description: null,
    name: null,
    status: 'active',
    eventCount: 0,
    firstEventAt: Date.now(),
    lastEventAt: Date.now(),
    ...overrides,
  }
}

describe('getAgentDisplayName', () => {
  it('should return "Main" for root agent (no parentAgentId)', () => {
    const agent = makeAgent({ parentAgentId: null })
    expect(getAgentDisplayName(agent)).toBe('Main')
  })

  it('should return name for subagent with name', () => {
    const agent = makeAgent({
      parentAgentId: 'parent-1',
      name: 'code-reviewer',
    })
    expect(getAgentDisplayName(agent)).toBe('code-reviewer')
  })

  it('should fall back to description for subagent without name', () => {
    const agent = makeAgent({
      parentAgentId: 'parent-1',
      name: null,
      description: 'Review the code for issues',
    })
    expect(getAgentDisplayName(agent)).toBe('Review the code for issues')
  })

  it('should fall back to truncated ID for subagent without name or description', () => {
    const agent = makeAgent({
      id: 'abcdefgh-1234-5678',
      parentAgentId: 'parent-1',
      name: null,
      description: null,
    })
    expect(getAgentDisplayName(agent)).toBe('abcdefgh')
  })

  it('should still return "Main" for root even if it has a name', () => {
    const agent = makeAgent({
      parentAgentId: null,
      name: 'root-agent',
    })
    expect(getAgentDisplayName(agent)).toBe('Main')
  })
})

describe('buildAgentColorMap', () => {
  it('should assign sequential indices in depth-first order', () => {
    const agents: Agent[] = [
      makeAgent({ id: 'root' }),
      makeAgent({ id: 'child-1', parentAgentId: 'root' }),
      makeAgent({ id: 'grandchild-1', parentAgentId: 'child-1' }),
      makeAgent({ id: 'child-2', parentAgentId: 'root' }),
    ]

    const map = buildAgentColorMap(agents)
    expect(map.get('root')).toBe(0)
    expect(map.get('child-1')).toBe(1)
    expect(map.get('grandchild-1')).toBe(2)
    expect(map.get('child-2')).toBe(3)
  })

  it('should return empty map for undefined agents', () => {
    const map = buildAgentColorMap(undefined)
    expect(map.size).toBe(0)
  })

  it('should return empty map for empty array', () => {
    const map = buildAgentColorMap([])
    expect(map.size).toBe(0)
  })

  it('should handle flat agent list (no children)', () => {
    const agents: Agent[] = [makeAgent({ id: 'a' }), makeAgent({ id: 'b' })]
    const map = buildAgentColorMap(agents)
    expect(map.get('a')).toBe(0)
    expect(map.get('b')).toBe(1)
  })
})

describe('getAgentColor', () => {
  it('should return the first color for index 0', () => {
    const color = getAgentColor(0)
    expect(color.text).toContain('series-1')
    expect(color.dot).toContain('series-1')
  })

  it('should return the second color for index 1', () => {
    const color = getAgentColor(1)
    expect(color.text).toContain('series-2')
  })

  it('should cycle colors when index exceeds palette length', () => {
    const first = getAgentColor(0)
    const cycled = getAgentColor(8) // 8 colors in palette, so 8 % 8 = 0
    expect(cycled).toEqual(first)
  })

  it('should return different colors for different indices', () => {
    const a = getAgentColor(0)
    const b = getAgentColor(1)
    expect(a.text).not.toEqual(b.text)
  })

  it('should return all required properties', () => {
    const color = getAgentColor(0)
    expect(color).toHaveProperty('text')
    expect(color).toHaveProperty('textOnly')
    expect(color).toHaveProperty('border')
    expect(color).toHaveProperty('dot')
    expect(typeof color.text).toBe('string')
    expect(typeof color.textOnly).toBe('string')
    expect(typeof color.border).toBe('string')
    expect(typeof color.dot).toBe('string')
  })
})

describe('getAgentColorById', () => {
  it('should look up color from map', () => {
    const map = new Map<string, number>([
      ['agent-a', 0],
      ['agent-b', 2],
    ])

    const colorA = getAgentColorById('agent-a', map)
    const colorB = getAgentColorById('agent-b', map)
    expect(colorA.text).toContain('series-1') // index 0
    expect(colorB.text).toContain('series-3') // index 2
  })

  it('should default to index 0 for unknown agent ID', () => {
    const map = new Map<string, number>()
    const color = getAgentColorById('unknown-agent', map)
    expect(color).toEqual(getAgentColor(0))
  })
})

describe('background lane', () => {
  const lane = makeAgent({
    id: 'sess-1:background',
    parentAgentId: null,
    name: 'Background',
    agentType: 'background',
  })

  it('recognises a lane id', () => {
    expect(isBackgroundLane('sess-1:background')).toBe(true)
    expect(isBackgroundLane('sess-1')).toBe(false)
    expect(isBackgroundLane('a356a5359c2963201')).toBe(false)
  })

  it('labels the lane instead of falling through to "Main"', () => {
    // The lane has no parentAgentId, so the root-agent rule would
    // otherwise claim it.
    expect(getAgentDisplayName(lane)).toBe('Background')
  })

  it('labels a lane whose name never arrived', () => {
    expect(getAgentDisplayName({ ...lane, name: null })).toBe('Background')
  })
})

describe('orderAgentLanes', () => {
  const main = makeAgent({ id: 'sess-1', parentAgentId: null })
  const lane = makeAgent({ id: 'sess-1:background', parentAgentId: null, name: 'Background' })
  const subA = makeAgent({ id: 'sub-a', parentAgentId: 'sess-1' })
  const subB = makeAgent({ id: 'sub-b', parentAgentId: 'sess-1' })

  it('pins the background lane directly after Main', () => {
    const ordered = orderAgentLanes([subA, lane, main, subB], [])
    expect(ordered.map((o) => o.agent.id)).toEqual([
      'sess-1',
      'sess-1:background',
      'sub-b',
      'sub-a',
    ])
  })

  it('keeps subagents newest-first after the lane', () => {
    const ordered = orderAgentLanes([main, subA, subB], [])
    expect(ordered.map((o) => o.agent.id)).toEqual(['sess-1', 'sub-b', 'sub-a'])
  })

  it('marks the lane as neither main nor subagent styling', () => {
    const ordered = orderAgentLanes([main, lane], [])
    expect(ordered.find((o) => o.agent.id === 'sess-1:background')!.isSubagent).toBe(true)
    expect(ordered.find((o) => o.agent.id === 'sess-1')!.isSubagent).toBe(false)
  })

  it('honours an explicit agent selection', () => {
    const ordered = orderAgentLanes([main, lane, subA], ['sub-a'])
    expect(ordered.map((o) => o.agent.id)).toEqual(['sub-a'])
  })

  it('still places the lane after Main when Main is absent', () => {
    const ordered = orderAgentLanes([subA, lane], [])
    expect(ordered.map((o) => o.agent.id)).toEqual(['sess-1:background', 'sub-a'])
  })
})
