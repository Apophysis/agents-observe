import { useMemo } from 'react'
import type { Agent, ParsedEvent } from '@/types'
import { buildCommsGraph, type CommsEdge, type CommsEdgeKind } from '@/lib/comms-graph'

const NODE_W = 132
const NODE_H = 34
const COL_GAP = 40
const ROW_GAP = 90
const PAD = 40

// Theme-token colors so the graph reads in both light and dark mode.
const KIND_TEXT: Record<CommsEdgeKind, string> = {
  delegation: 'text-muted-foreground',
  message: 'text-primary',
  result: 'text-emerald-600 dark:text-emerald-400',
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
  const height = PAD * 2 + (Math.max(0, ...rows.keys()) + 1) * NODE_H + Math.max(0, ...rows.keys()) * ROW_GAP
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

  if (graph.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No agents to show yet.
      </div>
    )
  }

  const legend: Array<[CommsEdgeKind, string]> = [
    ['delegation', 'spawn'],
    ['message', 'message'],
    ['result', 'result'],
  ]

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center gap-4 px-3 py-1.5 text-xs text-muted-foreground border-b border-border">
        {legend.map(([kind, label]) => (
          <span key={kind} className={`inline-flex items-center gap-1.5 ${KIND_TEXT[kind]}`}>
            <svg width="22" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={kind === 'result' ? '4 3' : undefined}
              />
            </svg>
            {label}
          </span>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
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
                markerWidth="7"
                markerHeight="7"
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
            const dx = b.x - a.x
            const dy = b.y - a.y
            const len = Math.hypot(dx, dy) || 1
            // Perpendicular offset; the reverse direction bows the other way.
            const bow = 22 + (e.kind === 'message' ? 14 : 0)
            const cx = (a.x + b.x) / 2 + (-dy / len) * bow
            const cy = (a.y + b.y) / 2 + (dx / len) * bow
            const p1 = clip(a, { x: cx, y: cy })
            const p2 = clip(b, { x: cx, y: cy })
            const mx = 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x
            const my = 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y
            const text = e.count > 1 ? `${e.label} x${e.count}` : e.label
            return (
              <g key={`${e.kind}|${e.from}|${e.to}`} className={KIND_TEXT[e.kind]}>
                <path
                  d={`M${p1.x} ${p1.y}Q${cx} ${cy} ${p2.x} ${p2.y}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={e.kind === 'result' ? '5 4' : undefined}
                  markerEnd={`url(#comms-arrow-${e.kind})`}
                />
                <text
                  x={mx}
                  y={my - 4}
                  textAnchor="middle"
                  fontSize="10"
                  fill="currentColor"
                  stroke="var(--background)"
                  strokeWidth="3"
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
            return (
              <g key={n.id}>
                <title>{n.id}</title>
                <rect
                  x={p.x - NODE_W / 2}
                  y={p.y - NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  rx="6"
                  className={n.isRoot ? 'fill-card stroke-primary' : 'fill-card stroke-border'}
                  strokeWidth={n.isRoot ? 2 : 1}
                  strokeDasharray={n.external ? '4 3' : undefined}
                />
                <text
                  x={p.x}
                  y={p.y + 4}
                  textAnchor="middle"
                  fontSize="12"
                  className="fill-foreground"
                >
                  {truncate(n.label, 18)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
