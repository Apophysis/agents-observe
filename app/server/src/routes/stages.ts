// app/server/src/routes/stages.ts
//
// Stage mapping endpoint. Maps an agent's agent_type to a display stage
// (the only signal used). Main thread (no agent_id) uses `main`.
// Source: AGENTS_OBSERVE_STAGES_PATH, else config/stages.json, else the
// built-in default. Never throws; bad input falls back to the default.

import { Hono } from 'hono'
import { config } from '../config'
import { resolve, dirname } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

export interface StageEntry {
  label: string
  [key: string]: unknown
}

export interface StagesConfig {
  stages: Record<string, StageEntry>
  main: string
}

export const DEFAULT_STAGES: StagesConfig = {
  stages: {
    planner: { label: 'Planning' },
    Plan: { label: 'Planning' },
    Explore: { label: 'Exploring' },
    coder: { label: 'Coding' },
    tester: { label: 'Testing' },
    reviewer: { label: 'Reviewing' },
  },
  main: 'Orchestrating',
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseStages(raw: string): StagesConfig | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data) || typeof data.main !== 'string' || !isRecord(data.stages)) return null
  const stages: Record<string, StageEntry> = {}
  for (const [type, entry] of Object.entries(data.stages)) {
    if (!isRecord(entry) || typeof entry.label !== 'string') return null
    stages[type] = { ...entry, label: entry.label }
  }
  return { stages, main: data.main }
}

function candidatePaths(): string[] {
  const override = config.stagesPath
  if (override) return [override]
  const dir = dirname(fileURLToPath(import.meta.url))
  return [
    resolve(dir, '../../../../config/stages.json'), // dev: app/server/src/routes -> root
    resolve(dir, '../../../config/stages.json'), // Docker: /app/server/src/routes -> /app
  ]
}

export function loadStages(): StagesConfig {
  for (const p of candidatePaths()) {
    let raw: string
    try {
      raw = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const parsed = parseStages(raw)
    if (parsed) return parsed
    console.warn(`[stages] Invalid stages file at ${p}, using built-in default`)
    return DEFAULT_STAGES
  }
  console.warn('[stages] Stages file not found, using built-in default')
  return DEFAULT_STAGES
}

const router = new Hono()

router.get('/stages', (c) => c.json(loadStages()))

export default router
