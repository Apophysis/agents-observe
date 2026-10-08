import { describe, test, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventStore } from '../storage/types'

const tmp = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'costs-route-'))
})
vi.mock('../config', () => ({
  config: {
    transcriptStats: { enabled: true, bases: [], maxFileBytes: 100 * 1024 * 1024 },
    dataDir: tmp,
  },
}))
import costsRouter from './costs'

function line(o: unknown) {
  return JSON.stringify(o)
}
function transcript(ts: number): string {
  const iso = new Date(ts).toISOString()
  return [
    line({ type: 'user', uuid: 'u1', parentUuid: null, promptId: 'p1', timestamp: iso, message: { content: 'hi' } }),
    line({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: iso, isSidechain: false,
      message: {
        id: 'm1', model: 'claude-opus-4-7', stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard' },
        content: [{ type: 'text', text: 'hi' }],
      },
    }),
  ].join('\n') + '\n'
}

function app(sessions: any[]) {
  const a = new Hono<{ Variables: { store: EventStore } }>()
  a.use('*', async (c, next) => {
    c.set('store', {
      getRecentSessions: async () => sessions,
      getAgentsForSession: async () => [],
    } as unknown as EventStore)
    await next()
  })
  a.route('/api', costsRouter)
  return a
}

describe('GET /api/costs/daily', () => {
  test('includes sessions without a project, counts unreadable ones, clamps days', async () => {
    const good = join(mkdtempSync(join(tmpdir(), 'cr-')), 's.jsonl')
    writeFileSync(good, transcript(Date.now()))
    const res = await app([
      { id: 'unassigned', project_id: null, transcript_path: good },
      { id: 'missing', project_id: null, transcript_path: join(tmp, 'nope.jsonl') },
      { id: 'no-path', project_id: null, transcript_path: null },
    ]).request('/api/costs/daily?days=9999')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.days).toHaveLength(365)
    expect(body.skippedSessions).toBe(1)
    expect(body.days.at(-1).sessions).toBe(1)
    expect(body.days.at(-1).prompts).toBe(1)
  })
})
