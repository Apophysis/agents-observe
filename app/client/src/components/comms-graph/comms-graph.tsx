import { useMemo } from 'react'
import type { Agent, ParsedEvent } from '@/types'
import { buildCommsGraph, type CommsEdge, type CommsEdgeKind } from '@/lib/comms-graph'
import { buildAgentColorMap } from '@/lib/agent-utils'
import { deriveStage, type Stage, type StageKind } from '@/lib/stage'
import { useStageMapping } from '@/hooks/use-stage-mapping'

const NODE_W = 168
const NODE_H = 48
const COL_GAP = 28
const ROW_GAP = 150
const PAD = 40

// Theme tokens only, so the graph follows light and dark mode. Spawns are
// structural and recede; messages carry the accent; results use the
// reserved "good" status colour and a dash, so meaning never rests on hue.
const KIND_TEXT: Record<CommsEdgeKind, string> = {
  delegation: 'text-muted-foreground',
  message: 'text-primary',
  result: 'text-status-good',
}
const KIND_WIDTH: Record<CommsEdgeKind, number> = { delegation: 1.25, message: 1.75, result: 1.25 }
const KIND_DASH: Record<CommsEdgeKind, string | undefined> = {
  delegation: undefined,
  message: undefined,
  result: '4 3',
}
const KIND_LABEL: Record<CommsEdgeKind, string> = {
  delegation: 'spawn',
  message: 'message',
  result: 'result',
}

// Literal class names so Tailwind's scanner keeps them. Same fixed order as
// the agent colours elsewhere in the app.
const SERIES_FILL = [
  'fill-series-1',
  'fill-series-2',
  'fill-series-3',
  'fill-series-4',
  'fill-series-5',
  'fill-series-6',
  'fill-series-7',
  'fill-series-8',
]
const STAGE_FILL: Record<StageKind, string> = {
  base: 'fill-primary',
  'needs-input': 'fill-status-warning',
  done: 'fill-status-good',
  failed: 'fill-status-critical',
}

interface Pos {
  x: number
  y: number
}

function layout(nodeIds: string[], rootId: string | undefined, edges: CommsEdge[]) {
  const depth = new Map<string, number>()
  if (rootId) depth.set(rootId, 0)
  const children = new Map<string, string[]>()
  for (const e of edges) {
    if (e.kind !== 'delegation') continue
    const list = children.get(e.from) ?? []
    list.push(e.to)
    children.set(e.from, list)
  }
  const queue = rootId ? [rootId] : []
  while (queue.length) {
    const id = queue.shift()!
    for (const c of children.get(id) ?? []) {
      if (!depth.has(c)) {
        depth.set(c, depth.get(id)! + 1)
        queue.push(c)
      }
    }
  }
  // Nodes not reached by delegation (e.g. message-only peers) sit on row 1.
  for (const id of nodeIds) if (!depth.has(id)) depth.set(id, 1)

  const rows = new Map<number, string[]>()
  for (const id of nodeIds) {
    const d = depth.get(id)!
    const row = rows.get(d) ?? []
    row.push(id)
    rows.set(d, row)
  }
  const maxCols = Math.max(1, ...[...rows.values()].map((r) => r.length))
  const width = PAD * 2 + maxCols * NODE_W + (maxCols - 1) * COL_GAP
  const height =
    PAD * 2 + (Math.max(0, ...rows.keys()) + 1) * NODE_H + Math.max(0, ...rows.keys()) * ROW_GAP
  const pos = new Map<string, Pos>()
  for (const [d, ids] of rows) {
    const rowW = ids.length * NODE_W + (ids.length - 1) * COL_GAP
    const x0 = (width - rowW) / 2
    ids.forEach((id, i) => {
      pos.set(id, {
        x: x0 + i * (NODE_W + COL_GAP) + NODE_W / 2,
        y: PAD + d * (NODE_H + ROW_GAP) + NODE_H / 2,
      })
    })
  }
  return { pos, width, height }
}

/** Point on the node rectangle border along the line from `c` towards `t`. */
function clip(c: Pos, t: Pos): Pos {
  const dx = t.x - c.x
  const dy = t.y - c.y
  if (dx === 0 && dy === 0) return c
  const sx = dx === 0 ? Infinity : NODE_W / 2 / Math.abs(dx)
  const sy = dy === 0 ? Infinity : NODE_H / 2 / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: c.x + dx * s, y: c.y + dy * s }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const BOW_STEP = 44
const KIND_ORDER: CommsEdgeKind[] = ['delegation', 'message', 'result']

const pairKey = (e: CommsEdge) => (e.from <= e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`)
const edgeKey = (e: CommsEdge) => `${e.kind}|${e.from}|${e.to}`

/** Slot per edge within its agent pair: 0 for a lone edge, else centred on 0. */
function assignSlots(edges: CommsEdge[]): Map<string, Map<string, number>> {
  const groups = new Map<string, CommsEdge[]>()
  for (const e of edges) {
    const list = groups.get(pairKey(e)) ?? []
    list.push(e)
    groups.set(pairKey(e), list)
  }
  const out = new Map<string, Map<string, number>>()
  for (const [k, list] of groups) {
    list.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind))
    out.set(k, new Map(list.map((e, i) => [edgeKey(e), i - (list.length - 1) / 2])))
  }
  return out
}

export function CommsGraph({
  events,
  agents,
}: {
  events: ParsedEvent[] | undefined
  agents: Agent[]
}) {
  const graph = useMemo(() => buildCommsGraph(events ?? [], agents), [events, agents])
  const { pos, width, height } = useMemo(
    () =>
      layout(
        graph.nodes.map((n) => n.id),
        graph.nodes.find((n) => n.isRoot)?.id,
        graph.edges,
      ),
    [graph],
  )

  const pairSlots = useMemo(() => assignSlots(graph.edges), [graph])
  const colorMap = useMemo(() => buildAgentColorMap(agents), [agents])
  const { data: stageMapping } = useStageMapping()
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const stageById = useMemo(() => {
    const out = new Map<string, Stage>()
    if (!events || !stageMapping) return out
    for (const a of agents) {
      const st = deriveStage(a, events, stageMapping)
      if (st) out.set(a.id, st)
    }
    return out
  }, [agents, events, stageMapping])

  if (graph.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No agents to show yet.
      </div>
    )
  }

  const counts = { delegation: 0, message: 0, result: 0 } as Record<CommsEdgeKind, number>
  for (const e of graph.edges) counts[e.kind] += e.count

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-2 bg-background">
      <section className="flex-1 min-h-0 flex flex-col rounded-sm border border-border bg-card overflow-hidden">
        <header className="flex items-center gap-3 h-8 px-3 border-b border-border">
          <h2 className="text-xs font-semibold tracking-wide text-foreground">
            Agent communication
          </h2>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {graph.nodes.length} agents
          </span>
          <div className="ml-auto flex items-center gap-4 text-[11px] text-muted-foreground">
            {(['delegation', 'message', 'result'] as CommsEdgeKind[]).map((kind) => (
              <span key={kind} className="inline-flex items-center gap-1.5">
                <svg width="20" height="6" aria-hidden="true" className={KIND_TEXT[kind]}>
                  <line
                    x1="0"
                    y1="3"
                    x2="20"
                    y2="3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={KIND_DASH[kind]}
                  />
                </svg>
                {KIND_LABEL[kind]}
                <span className="tabular-nums text-foreground">{counts[kind]}</span>
              </span>
            ))}
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-auto">
          <svg
            role="img"
            aria-label="Agent communication graph"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            className="mx-auto max-w-none"
          >
            <defs>
              {(Object.keys(KIND_TEXT) as CommsEdgeKind[]).map((kind) => (
                <marker
                  key={kind}
                  id={`comms-arrow-${kind}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                  className={KIND_TEXT[kind]}
                >
                  <path d="M0 0L10 5L0 10z" fill="currentColor" />
                </marker>
              ))}
            </defs>
            {graph.edges.map((e) => {
              const a = pos.get(e.from)
              const b = pos.get(e.to)
              if (!a || !b) return null
              // Edges between the same two agents share one canonical perpendicular
              // axis and take evenly spaced slots on it, so curves and labels never
              // stack, whichever direction each edge travels.
              const slots = pairSlots.get(pairKey(e))!
              const slot = slots.get(edgeKey(e))!
              const canonFromA = e.from <= e.to
              const ca = canonFromA ? a : b
              const cb = canonFromA ? b : a
              const dx = cb.x - ca.x
              const dy = cb.y - ca.y
              const len = Math.hypot(dx, dy) || 1
              const bow = slot * BOW_STEP
              const cx = (a.x + b.x) / 2 + (-dy / len) * bow
              const cy = (a.y + b.y) / 2 + (dx / len) * bow
              const p1 = clip(a, { x: cx, y: cy })
              const p2 = clip(b, { x: cx, y: cy })
              // Labels sit towards the lower (child) end, where edges from one
              // parent are furthest apart, staggered by kind so the labels of
              // edges between the same pair never share a spot.
              const d = e.kind === 'delegation' ? 0.2 : e.kind === 'message' ? 0.4 : 0.6
              const t = a.y >= b.y ? d : 1 - d
              const mx = (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * cx + t * t * p2.x
              const my = (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * cy + t * t * p2.y
              const text = e.count > 1 ? `${e.label} x${e.count}` : e.label
              return (
                <g key={`${e.kind}|${e.from}|${e.to}`} className={KIND_TEXT[e.kind]}>
                  <path
                    d={`M${p1.x} ${p1.y}Q${cx} ${cy} ${p2.x} ${p2.y}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={KIND_WIDTH[e.kind]}
                    strokeOpacity={e.kind === 'delegation' ? 0.7 : 1}
                    strokeDasharray={KIND_DASH[e.kind]}
                    markerEnd={`url(#comms-arrow-${e.kind})`}
                  />
                  <text
                    x={mx}
                    y={my - 4}
                    textAnchor="middle"
                    fontSize="10"
                    className="fill-muted-foreground"
                    stroke="var(--card)"
                    strokeWidth="4"
                    strokeLinejoin="round"
                    paintOrder="stroke"
                  >
                    {text}
                  </text>
                </g>
              )
            })}
            {graph.nodes.map((n) => {
              const p = pos.get(n.id)
              if (!p) return null
              const agent = agentById.get(n.id)
              const stage = stageById.get(n.id)
              const colorIdx = colorMap.get(n.id)
              const x = p.x - NODE_W / 2
              const y = p.y - NODE_H / 2
              const sub = [
                agent?.agentType ?? (n.isRoot ? 'main' : n.external ? 'unresolved' : null),
                stage?.label,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <g key={n.id}>
                  <title>{n.id}</title>
                  <rect
                    x={x}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx="3"
                    className={n.isRoot ? 'fill-card stroke-primary' : 'fill-card stroke-border'}
                    strokeWidth={n.isRoot ? 1.5 : 1}
                    strokeDasharray={n.external ? '4 3' : undefined}
                  />
                  {colorIdx !== undefined && (
                    <rect
                      x={x}
                      y={y}
                      width="3"
                      height={NODE_H}
                      rx="1.5"
                      className={SERIES_FILL[colorIdx % SERIES_FILL.length]}
                    />
                  )}
                  <text
                    x={x + 14}
                    y={y + 20}
                    fontSize="12"
                    fontWeight="500"
                    className="fill-foreground"
                  >
                    {truncate(n.label, 20)}
                  </text>
                  {sub && (
                    <text x={x + 14} y={y + 36} fontSize="10" className="fill-muted-foreground">
                      {truncate(sub, 26)}
                    </text>
                  )}
                  {stage && (
                    <circle
                      cx={x + NODE_W - 12}
                      cy={y + 12}
                      r="3.5"
                      className={STAGE_FILL[stage.kind]}
                    >
                      <title>{stage.label}</title>
                    </circle>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </section>
    </div>
  )
}
