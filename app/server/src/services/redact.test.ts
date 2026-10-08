import { describe, test, expect } from 'vitest'
import { redactString, redactValue, redactEnvelope, REDACTED } from './redact'
import type { EventEnvelope } from '../types'

describe('redactString patterns', () => {
  test.each([
    ['sk-ant', 'key sk-ant-api03-abcdefghijklmnop1234567890 end'],
    ['sk-', 'key sk-abcdefghijklmnopqrstuvwx end'],
    ['ghp_', 'tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 end'],
    ['gho_', 'tok gho_abcdefghijklmnopqrstuvwxyz0123456789 end'],
    ['ghs_', 'tok ghs_abcdefghijklmnopqrstuvwxyz0123456789 end'],
    ['github_pat_', 'tok github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz end'],
    ['AKIA', 'id AKIAIOSFODNN7EXAMPLE end'],
    ['xoxb', 'slack xoxb-123456789012-abcdefghijkl end'],
    ['xoxp', 'slack xoxp-123456789012-abcdefghijkl end'],
    [
      'jwt',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end',
    ],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY----- tail'],
  ])('redacts %s', (_name, input) => {
    const out = redactString(input)
    expect(out).toContain(REDACTED)
    expect(out).not.toMatch(
      /sk-|ghp_|gho_|ghs_|github_pat_|AKIAIOSFODNN7|xox[bp]-|eyJ|MIIabc|PRIVATE KEY/,
    )
  })

  test('Bearer token keeps scheme, hides token', () => {
    expect(redactString('Authorization: Bearer abc123def456ghi789')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    )
  })

  test('URL credentials: only password redacted', () => {
    expect(redactString('postgres://admin:hunter2@db.local:5432/app')).toBe(
      `postgres://admin:${REDACTED}@db.local:5432/app`,
    )
  })

  test('PEM block keeps surrounding text', () => {
    const out = redactString('a\n-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\nb')
    expect(out).toBe(`a\n${REDACTED}\nb`)
  })
})

describe('redactValue keys and recursion', () => {
  test('redacts string values under sensitive keys, any depth', () => {
    const out = redactValue({
      a: { password: 'hunter2', API_KEY: 'x', 'api-key': 'y', apiKey: 'z' },
      list: [{ Authorization: 'Basic abc' }, { client_secret: 's' }, { token: 't' }],
    })
    expect(JSON.stringify(out)).not.toMatch(/hunter2|Basic abc|"s"|"t"|"x"|"y"|"z"/)
    expect((out as any).a.password).toBe(REDACTED)
    expect((out as any).list[0].Authorization).toBe(REDACTED)
  })

  test('skips non-strings under sensitive keys', () => {
    const out = redactValue({ token: 5, password: null, secret: true, tokens: { n: 1 } })
    expect(out).toEqual({ token: 5, password: null, secret: true, tokens: { n: 1 } })
  })

  test('redacts inside arrays of strings', () => {
    expect(redactValue(['ok', 'AKIAIOSFODNN7EXAMPLE'])).toEqual(['ok', REDACTED])
  })

  test('does not mutate input', () => {
    const input = { password: 'p', nested: { s: 'Bearer abcdefgh12345' } }
    const copy = JSON.parse(JSON.stringify(input))
    redactValue(input)
    expect(input).toEqual(copy)
  })
})

describe('false positives', () => {
  test.each([
    'const x = tasks.map((t) => t.id)',
    '/home/user/skills/sk-test/file.ts',
    'task-1234567890123456789012345',
    'sk-short',
    'git commit -m "fix: ghost_busters"',
    'The bearer of bad news',
    'Bearer token',
    'https://example.com/path?x=1',
    'https://user@example.com/repo.git',
    'eyJ.not.a.jwt',
    'AKIA-too-short',
    'ls -la && echo hello',
    '',
  ])('leaves %j untouched', (s) => {
    expect(redactString(s)).toBe(s)
  })

  test('normal keys and values untouched', () => {
    const v = { tool_name: 'Bash', file_path: '/a/b.ts', max_tokens: 100, command: 'npm test' }
    expect(redactValue(v)).toEqual(v)
  })
})

describe('redactEnvelope', () => {
  const base: EventEnvelope = {
    agentClass: 'claude-code',
    sessionId: 's',
    agentId: 'a',
    hookName: 'PreToolUse',
    payload: { cmd: 'curl -H "Authorization: Bearer abcdefgh12345"' },
    _meta: { session: { slug: 'AKIAIOSFODNN7EXAMPLE' } },
  }

  test('redacts payload and _meta without mutating input', () => {
    const out = redactEnvelope(base)
    expect(JSON.stringify(out)).not.toMatch(/abcdefgh12345|AKIAIOSFODNN7/)
    expect(JSON.stringify(base)).toContain('abcdefgh12345')
    expect(out.sessionId).toBe('s')
  })

  test('envelope without _meta stays without _meta', () => {
    const { _meta, ...rest } = base
    expect('_meta' in redactEnvelope(rest as EventEnvelope)).toBe(false)
  })
})

describe('sensitive key matching', () => {
  test('matches whole-word key names, including camelCase', () => {
    const out = redactValue({
      accessToken: 'abc',
      api_key: 'abc',
      Password: 'abc',
      secret: 'abc',
    }) as Record<string, string>
    expect(Object.values(out).every((v) => v === '[REDACTED]')).toBe(true)
  })
  test('does not match keys that merely contain the letters', () => {
    const input = { bypass_mode: 'on', compass: 'north', passed: 'yes' }
    expect(redactValue(input)).toEqual(input)
  })
})
