import { describe, it, expect } from 'vitest'
import { buildCommsGraph, type CommsEvent } from './comms-graph'
import type { Agent } from '@/types'

let nextId = 1
function ev(
  agentId: string,
  hookName: string,
  payload: Record<string, unknown> = {},
  timestamp = nextId * 10,
): CommsEvent {
  return { id: nextId++, agentId, hookName, timestamp, payload }
}

function agent(id: string, parentAgentId: string | null, over: Partial<Agent> = {}): Agent {
  return {
    id,
    sessionId: 'sess',
    parentAgentId,
    description: null,
    name: null,
    agentType: null,
    agentClass: null,
    status: 'active',
    eventCount: 1,
    firstEventAt: 0,
    lastEventAt: 0,
    cwd: null,
    ...over,
  }
}

const pre = (agentId: string) => ev(agentId, 'PreToolUse', { tool_name: 'Agent' })
const post = (agentId: string, child: string) =>
  ev(agentId, 'PostToolUse', { tool_name: 'Agent', tool_response: { agentId: child } })
const start = (child: string) => ev(child, 'SubagentStart', { agent_id: child })
const stop = (child: string) => ev('sess', 'SubagentStop', { agent_id: child })

describe('buildCommsGraph', () => {
  it('handles one subagent: spawn and result edges', () => {
    nextId = 1
    const events = [pre('sess'), start('a'), post('sess', 'a'), stop('a')]
    const g = buildCommsGraph(events, [agent('sess', null), agent('a', 'sess')])
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'sess'])
    expect(g.nodes.find((n) => n.id === 'sess')!.isRoot).toBe(true)
    expect(g.edges).toEqual([
      { from: 'sess', to: 'a', kind: 'delegation', label: 'spawn', count: 1 },
      { from: 'a', to: 'sess', kind: 'result', label: 'result', count: 1 },
    ])
  })

  it('handles nested subagents', () => {
    nextId = 1
    const events = [
      pre('sess'),
      start('a'),
      post('sess', 'a'),
      pre('a'),
      start('b'),
      post('a', 'b'),
      stop('b'),
      stop('a'),
    ]
    const g = buildCommsGraph(events, [
      agent('sess', null),
      agent('a', 'sess'),
      agent('b', 'a'),
    ])
    const d = g.edges.filter((e) => e.kind === 'delegation').map((e) => `${e.from}>${e.to}`)
    expect(d.sort()).toEqual(['a>b', 'sess>a'])
    const r = g.edges.filter((e) => e.kind === 'result').map((e) => `${e.from}>${e.to}`)
    expect(r.sort()).toEqual(['a>sess', 'b>a'])
  })

  it('falls back to Pre ordering when Post is missing', () => {
    nextId = 1
    const events = [pre('sess'), start('a'), pre('a'), start('b')]
    const g = buildCommsGraph(events, [agent('sess', null), agent('a', 'sess'), agent('b', 'sess')])
    const d = g.edges.map((e) => `${e.from}>${e.to}`)
    expect(d).toEqual(['sess>a', 'a>b'])
  })

  it('adds a SendMessage edge between peers', () => {
    nextId = 1
    const events = [
      pre('sess'),
      start('a'),
      post('sess', 'a'),
      pre('sess'),
      start('b'),
      post('sess', 'b'),
      ev('a', 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'reviewer' } }),
    ]
    const g = buildCommsGraph(events, [
      agent('sess', null),
      agent('a', 'sess'),
      agent('b', 'sess', { name: 'reviewer' }),
    ])
    expect(g.edges.find((e) => e.kind === 'message')).toEqual({
      from: 'a',
      to: 'b',
      kind: 'message',
      label: 'message',
      count: 1,
    })
  })

  it('creates an external node for an unknown message target', () => {
    nextId = 1
    const events = [ev('sess', 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'ghost' } })]
    const g = buildCommsGraph(events, [agent('sess', null)])
    const ghost = g.nodes.find((n) => n.external)!
    expect(ghost.label).toBe('ghost')
    expect(g.edges).toHaveLength(1)
  })

  it('ignores stray and duplicate SubagentStop events', () => {
    nextId = 1
    const events = [
      stop('never-started'),
      pre('sess'),
      start('a'),
      post('sess', 'a'),
      stop('a'),
      stop('a'),
      stop('tick'),
    ]
    const g = buildCommsGraph(events, [
      agent('sess', null),
      agent('a', 'sess'),
      agent('tick', 'sess'),
    ])
    expect(g.edges.filter((e) => e.kind === 'result')).toHaveLength(1)
    expect(g.edges.find((e) => e.kind === 'result')!.count).toBe(1)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'sess'])
  })

  it('counts repeated messages on one edge', () => {
    nextId = 1
    const msg = () => ev('sess', 'PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'a' } })
    const events = [pre('sess'), start('a'), post('sess', 'a'), msg(), msg(), msg()]
    const g = buildCommsGraph(events, [agent('sess', null), agent('a', 'sess')])
    expect(g.edges.find((e) => e.kind === 'message')!.count).toBe(3)
    expect(g.edges).toHaveLength(2)
  })

  it('returns an empty graph with no data', () => {
    expect(buildCommsGraph([], [])).toEqual({ nodes: [], edges: [] })
  })
})
