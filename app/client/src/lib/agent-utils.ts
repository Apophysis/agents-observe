import type { Agent } from '@/types'

/**
 * Suffix the server appends to a session id to form its background lane —
 * the single row every background poll tick collapses onto. Mirrors
 * BACKGROUND_LANE_SUFFIX in app/server/src/services/background-tick.ts.
 */
export const BACKGROUND_LANE_SUFFIX = ':background'
const BACKGROUND_LANE_LABEL = 'Background'

/** True for the synthetic per-session background lane. */
export function isBackgroundLane(agentId: string): boolean {
  return agentId.endsWith(BACKGROUND_LANE_SUFFIX)
}

// Display name for an agent: name (short) → description → truncated ID
export function getAgentDisplayName(agent: Agent): string {
  // Checked before the root-agent rule: the lane has no parentAgentId, so
  // it would otherwise be labelled "Main".
  if (isBackgroundLane(agent.id)) return agent.name || BACKGROUND_LANE_LABEL
  if (!agent.parentAgentId) return 'Main'
  return agent.name || agent.description || agent.id.slice(0, 8)
}

/**
 * Order agents into timeline rows: Main first, then the background lane,
 * then real subagents newest-first.
 *
 * The lane carries no parentAgentId (nothing spawned it), so without the
 * explicit pin it would sort in with the root agents and drift above Main.
 * It is flagged `isSubagent` so it renders with the indented lane styling
 * rather than as a second root row.
 */
export function orderAgentLanes(
  agents: Agent[],
  selectedAgentIds: string[],
): { agent: Agent; isSubagent: boolean }[] {
  const mainAgents: { agent: Agent; isSubagent: boolean }[] = []
  const subAgents: { agent: Agent; isSubagent: boolean }[] = []
  let backgroundLane: { agent: Agent; isSubagent: boolean } | null = null

  for (const a of agents) {
    if (selectedAgentIds.length > 0 && !selectedAgentIds.includes(a.id)) continue
    if (isBackgroundLane(a.id)) {
      backgroundLane = { agent: a, isSubagent: true }
    } else if (!a.parentAgentId) {
      mainAgents.push({ agent: a, isSubagent: false })
    } else {
      subAgents.push({ agent: a, isSubagent: true })
    }
  }
  // Reverse non-main agents so newest appear right after Main
  subAgents.reverse()
  return [...mainAgents, ...(backgroundLane ? [backgroundLane] : []), ...subAgents]
}

// ── Agent colors ──────────────────────────────────────────────────────
// Ordered list of colors. Agents are assigned colors by their position
// in the flattened agent tree (depth-first), cycling when exhausted.

export interface AgentColorClasses {
  /** Text + border classes for event-row left border and agent label */
  text: string
  /** Just the text color classes (light + dark) */
  textOnly: string
  /** Border classes only */
  border: string
  /** Background color for dots / indicators */
  dot: string
}

// Theme series tokens (see index.css): one validated palette for light and
// dark, so agent identity reads the same everywhere.
const AGENT_COLORS: AgentColorClasses[] = [
  {
    text: 'text-series-1 border-series-1/50',
    textOnly: 'text-series-1',
    border: 'border-series-1/50',
    dot: 'bg-series-1',
  },
  {
    text: 'text-series-2 border-series-2/50',
    textOnly: 'text-series-2',
    border: 'border-series-2/50',
    dot: 'bg-series-2',
  },
  {
    text: 'text-series-3 border-series-3/50',
    textOnly: 'text-series-3',
    border: 'border-series-3/50',
    dot: 'bg-series-3',
  },
  {
    text: 'text-series-4 border-series-4/50',
    textOnly: 'text-series-4',
    border: 'border-series-4/50',
    dot: 'bg-series-4',
  },
  {
    text: 'text-series-5 border-series-5/50',
    textOnly: 'text-series-5',
    border: 'border-series-5/50',
    dot: 'bg-series-5',
  },
  {
    text: 'text-series-6 border-series-6/50',
    textOnly: 'text-series-6',
    border: 'border-series-6/50',
    dot: 'bg-series-6',
  },
  {
    text: 'text-series-7 border-series-7/50',
    textOnly: 'text-series-7',
    border: 'border-series-7/50',
    dot: 'bg-series-7',
  },
  {
    text: 'text-series-8 border-series-8/50',
    textOnly: 'text-series-8',
    border: 'border-series-8/50',
    dot: 'bg-series-8',
  },
]

/**
 * Build a map from agentId -> color index by flattening the agent tree
 * depth-first. The index is stable as long as the tree order is stable.
 */
export function buildAgentColorMap(agents: Agent[] | undefined): Map<string, number> {
  const map = new Map<string, number>()
  if (!agents) return map
  let idx = 0
  function visit(parentId: string | null) {
    for (const a of agents!) {
      if (a.parentAgentId === parentId) {
        map.set(a.id, idx++)
        visit(a.id)
      }
    }
  }
  visit(null)
  return map
}

/** Get color classes for an agent given its index in the flattened tree. */
export function getAgentColor(index: number): AgentColorClasses {
  return AGENT_COLORS[index % AGENT_COLORS.length]
}

/** Convenience: get color classes for an agent by ID, given a color map. */
export function getAgentColorById(
  agentId: string,
  colorMap: Map<string, number>,
): AgentColorClasses {
  const idx = colorMap.get(agentId) ?? 0
  return getAgentColor(idx)
}
