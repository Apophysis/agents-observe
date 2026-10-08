import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import router, { loadStages, DEFAULT_STAGES } from './stages'

describe('stages', () => {
  let tmpDir = ''

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stages-route-'))
    delete process.env.AGENTS_OBSERVE_STAGES_PATH
  })

  afterEach(() => {
    delete process.env.AGENTS_OBSERVE_STAGES_PATH
    vi.restoreAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('default file matches the built-in mapping', () => {
    const cfg = loadStages()
    expect(cfg).toEqual(DEFAULT_STAGES)
    expect(cfg.main).toBe('Orchestrating')
    expect(cfg.stages.planner.label).toBe('Planning')
    expect(cfg.stages.Plan.label).toBe('Planning')
    expect(cfg.stages.Explore.label).toBe('Exploring')
    expect(cfg.stages.coder.label).toBe('Coding')
    expect(cfg.stages.tester.label).toBe('Testing')
    expect(cfg.stages.reviewer.label).toBe('Reviewing')
  })

  test('env override loads the given file and keeps extra fields', () => {
    const p = join(tmpDir, 's.json')
    writeFileSync(p, JSON.stringify({ main: 'Lead', stages: { x: { label: 'X', color: 'red' } } }))
    process.env.AGENTS_OBSERVE_STAGES_PATH = p
    expect(loadStages()).toEqual({ main: 'Lead', stages: { x: { label: 'X', color: 'red' } } })
  })

  test('invalid JSON falls back to default and warns', () => {
    const p = join(tmpDir, 'bad.json')
    writeFileSync(p, '{ not json')
    process.env.AGENTS_OBSERVE_STAGES_PATH = p
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadStages()).toEqual(DEFAULT_STAGES)
    expect(warn).toHaveBeenCalled()
  })

  test('missing file falls back to default and warns', () => {
    process.env.AGENTS_OBSERVE_STAGES_PATH = join(tmpDir, 'nope.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadStages()).toEqual(DEFAULT_STAGES)
    expect(warn).toHaveBeenCalled()
  })

  test('GET /stages returns 200 JSON', async () => {
    const res = await router.request('/stages')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { stages: Record<string, unknown>; main: string }
    expect(body.main).toBe('Orchestrating')
    expect(body.stages.coder).toEqual({ label: 'Coding' })
  })
})
