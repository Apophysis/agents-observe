/**
 * Pure builder for the per-session communication graph. No DOM/React, unit
 * tested in comms-graph.test.ts. Derived purely from the event stream plus the
 * derived Agent[] (nothing is stored separately).
 *
 * Edges:
 *  - delegation: PreToolUse(Agent) parent -> child (child matched via the
 *    PostToolUse tool_response.agentId, else the next SubagentStart)
 *  - message:    PreToolUse(SendMessage) sender -> tool_input.to
 *  - result:     SubagentStop child -> parent, only for started subagents,
 *    first stop wins (background ticks / duplicates are ignored)
 */
import type { Agent } from '@/types'
import { buildAgentTree, type AgentTreeNode } from '@/dashboard/themes/constellation/agent-tree'

export interface CommsEvent {
  id: number
  agentId: string
  hookName: string
  timestamp: number
  payload: Record<string, unknown>
}

export type CommsEdgeKind = 'delegation' | 'message' | 'result'

export interface CommsNode {
  id: string
  sessionId: string
  label: string
  isRoot: boolean
  /** True when a message target could not be resolved to a known agent. */
  external: boolean
}

export interface CommsEdge {
  from: string
  to: string
  kind: CommsEdgeKind
  label: string
  count: number
}

export interface CommsGraph {
  nodes: CommsNode[]
  edges: CommsEdge[]
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function parentsFromTree(root: AgentTreeNode): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (n: AgentTreeNode) => {
    for (const c of n.children) {
      map.set(c.id, n.id)
      walk(c)
    }
  }
  walk(root)
  return map
}

export function buildCommsGraph(events: readonly CommsEvent[], agents: readonly Agent[]): CommsGraph {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)

  const rootId =
    agents[0]?.sessionId ||
    agents.find((a) => !a.parentAgentId)?.id ||
    sorted[0]?.agentId ||
    ''
  if (!rootId) return { nodes: [], edges: [] }

  const agentById = new Map<string, Agent>()
  for (const a of agents) agentById.set(a.id, a)
  const treeParent = parentsFromTree(buildAgentTree([...agents], rootId))

  // Pass 1: explicit spawn links (Post carries the child id) and started set.
  const spawnParent = new Map<string, string>() // child -> parent via PostToolUse:Agent
  const started = new Set<string>()
  for (const e of sorted) {
    const p = e.payload ?? {}
    if (e.hookName === 'PostToolUse' && p.tool_name === 'Agent') {
      const child = str((p.tool_response as Record<string, unknown> | undefined)?.agentId)
      if (child && child !== e.agentId && !spawnParent.has(child)) spawnParent.set(child, e.agentId)
    } else if (e.hookName === 'SubagentStart') {
      const id = str(p.agent_id) ?? e.agentId
      if (id !== rootId) started.add(id)
    }
  }

  const edgeMap = new Map<string, CommsEdge>()
  const addEdge = (from: string, to: string, kind: CommsEdgeKind, label: string) => {
    const key = `${kind}|${from}|${to}`
    const cur = edgeMap.get(key)
    if (cur) cur.count++
    else edgeMap.set(key, { from, to, kind, label, count: 1 })
  }

  // Pass 2: walk in order. Pending Agent PreToolUse calls resolve unmatched
  // SubagentStarts (FIFO) when the Post link is missing.
  const pendingSpawners: string[] = []
  const parentOf = new Map<string, string>()
  const stopped = new Set<string>()
  const startedSeen = new Set<string>()
  const nodeIds = new Set<string>([rootId])
  const externals = new Map<string, string>() // node id -> label

  const resolveTarget = (to: string): string | null => {
    if (agentById.has(to)) return to
    for (const a of agents) if (a.name === to) return a.id
    for (const a of agents) if (a.agentType === to) return a.id
    return null
  }

  for (const e of sorted) {
    const p = e.payload ?? {}
    if (e.hookName === 'PreToolUse' && p.tool_name === 'Agent') {
      pendingSpawners.push(e.agentId)
    } else if (e.hookName === 'PreToolUse' && p.tool_name === 'SendMessage') {
      const input = (p.tool_input ?? {}) as Record<string, unknown>
      const to = str(input.to) ?? str(input.recipient)
      if (!to) continue
      const resolved = resolveTarget(to)
      let target = resolved
      if (!target) {
        target = `ext:${to}`
        externals.set(target, to)
      }
      if (target === e.agentId) continue
      nodeIds.add(e.agentId)
      nodeIds.add(target)
      addEdge(e.agentId, target, 'message', 'message')
    } else if (e.hookName === 'SubagentStart') {
      const id = str(p.agent_id) ?? e.agentId
      if (id === rootId || startedSeen.has(id)) continue
      startedSeen.add(id)
      let parent = spawnParent.get(id)
      if (!parent) {
        const pending = pendingSpawners.shift()
        // Only trust a pending spawner when it is a different agent.
        parent = pending && pending !== id ? pending : (treeParent.get(id) ?? rootId)
      } else {
        // Consume the matching pending spawner so it can't mislead a later start.
        const i = pendingSpawners.indexOf(parent)
        if (i !== -1) pendingSpawners.splice(i, 1)
      }
      parentOf.set(id, parent)
      nodeIds.add(parent)
      nodeIds.add(id)
      addEdge(parent, id, 'delegation', 'spawn')
    } else if (e.hookName === 'SubagentStop') {
      const id = str(p.agent_id) ?? e.agentId
      if (!started.has(id) || !startedSeen.has(id) || stopped.has(id)) continue
      stopped.add(id)
      addEdge(id, parentOf.get(id) ?? rootId, 'result', 'result')
    }
  }

  const nodes: CommsNode[] = []
  const labelFor = (id: string): string => {
    const a = agentById.get(id)
    if (id === rootId) return a?.name || 'main'
    return a?.name || a?.agentType || (id.length > 10 ? id.slice(0, 8) : id)
  }
  for (const id of nodeIds) {
    const ext = externals.get(id)
    nodes.push({
      id,
      sessionId: agentById.get(id)?.sessionId ?? agents[0]?.sessionId ?? rootId,
      label: ext ?? labelFor(id),
      isRoot: id === rootId,
      external: ext !== undefined,
    })
  }
  return { nodes, edges: [...edgeMap.values()] }
}
