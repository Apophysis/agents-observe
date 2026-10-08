// app/server/src/routes/costs.ts
//
// Daily cost trend. Reuses the on-demand transcript parser per session and
// sums each prompt's cost into the UTC day of the prompt's timestamp.
// ponytail: a prompt that crosses midnight is attributed to its start day;
// per-call attribution would need the parser's raw calls.

import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import type { EventStore } from '../storage/types'
import { config } from '../config'
import { resolveTranscriptPath } from '../services/transcript-path'
import { parseSessionTranscripts, type TranscriptStatsV2 } from '../transcript-parser'

type Env = { Variables: { store: EventStore } }

const router = new Hono<Env>()
const DAY_MS = 86_400_000

// Parsed stats per session, valid while the transcript's mtime+size match.
// Only prompts are kept; entries with unpriced prompts are not cached, so a
// pricing outage cannot pin a session at $0 until its transcript changes.
type Prompts = TranscriptStatsV2['prompts']
const cache = new Map<string, { sig: string; prompts: Prompts }>()
const CONCURRENCY = 4

export interface DailyCost {
  date: string // YYYY-MM-DD, UTC
  costCents: number
  prompts: number
  sessions: number
}

export function aggregateDaily(
  perSession: Array<{ sessionId: string; prompts: TranscriptStatsV2['prompts'] }>,
  sinceTs: number,
  untilTs: number,
): { days: DailyCost[]; totalCents: number; unpricedPrompts: number } {
  const byDay = new Map<string, DailyCost & { _s: Set<string> }>()
  let unpriced = 0
  for (let t = sinceTs; t <= untilTs; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10)
    byDay.set(date, { date, costCents: 0, prompts: 0, sessions: 0, _s: new Set() })
  }
  for (const { sessionId, prompts } of perSession) {
    for (const p of prompts) {
      if (p.timestamp < sinceTs || p.timestamp > untilTs + DAY_MS - 1) continue
      const row = byDay.get(new Date(p.timestamp).toISOString().slice(0, 10))
      if (!row) continue
      row.prompts++
      row._s.add(sessionId)
      if (p.costCents == null) unpriced++
      else row.costCents += p.costCents
    }
  }
  const days = [...byDay.values()].map(({ _s, ...d }) => ({ ...d, sessions: _s.size }))
  return { days, totalCents: days.reduce((a, d) => a + d.costCents, 0), unpricedPrompts: unpriced }
}

router.get('/costs/daily', async (c) => {
  if (!config.transcriptStats.enabled) {
    return c.json({ error: 'disabled', message: 'Transcript parsing is disabled.' }, 404)
  }
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365)
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS
  const sinceTs = today - (days - 1) * DAY_MS
  const store = c.get('store')

  // getRecentSessions includes sessions with no project (the Unassigned bucket).
  const sessions = (await store.getRecentSessions(100_000, sinceTs)).filter(
    (s) => s.transcript_path,
  )
  const perSession: Array<{ sessionId: string; prompts: Prompts }> = []
  let skipped = 0
  const load = async (s: any) => {
    try {
      const resolved = resolveTranscriptPath(s.transcript_path, config.transcriptStats.bases)
      const st = await fs.stat(resolved)
      if (st.size > config.transcriptStats.maxFileBytes) throw new Error('too large')
      const sig = `${st.mtimeMs}:${st.size}`
      let hit = cache.get(s.id)
      if (!hit || hit.sig !== sig) {
        const { prompts } = await parseSessionTranscripts(s.id, store, resolved)
        hit = { sig, prompts }
        if (prompts.every((p) => p.costCents != null)) cache.set(s.id, hit)
        else cache.delete(s.id)
      }
      perSession.push({ sessionId: s.id, prompts: hit.prompts })
    } catch {
      skipped++
    }
  }
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    await Promise.all(sessions.slice(i, i + CONCURRENCY).map(load))
  }
  return c.json({ ...aggregateDaily(perSession, sinceTs, today), skippedSessions: skipped }, 200)
})

export default router
