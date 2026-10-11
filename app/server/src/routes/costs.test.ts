import { describe, test, expect } from 'vitest'
import { aggregateDaily } from './costs'

const D = 86_400_000
const day0 = Date.UTC(2026, 9, 1)
const p = (timestamp: number, costCents: number | null) =>
  ({
    promptId: 'x',
    text: '',
    command: null,
    timestamp,
    durationMs: null,
    toolCount: 0,
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreate5mTokens: 0,
    cacheCreate1hTokens: 0,
    models: [],
    costCents,
  }) as any

describe('aggregateDaily', () => {
  test('sums per UTC day, counts sessions and unpriced, ignores out of range', () => {
    const r = aggregateDaily(
      [
        { sessionId: 'a', prompts: [p(day0 + 1000, 50), p(day0 + D + 5, 25), p(day0 - 1, 999)] },
        { sessionId: 'b', prompts: [p(day0 + 2000, 10), p(day0 + 3000, null)] },
      ],
      day0,
      day0 + D,
    )
    expect(r.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02'])
    expect(r.days[0]).toEqual({ date: '2026-10-01', costCents: 60, prompts: 3, sessions: 2 })
    expect(r.days[1].costCents).toBe(25)
    expect(r.totalCents).toBe(85)
    expect(r.unpricedPrompts).toBe(1)
  })
})
