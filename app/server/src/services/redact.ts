// app/server/src/services/redact.ts
//
// Server-side secret redaction. Runs on every incoming envelope before it is
// logged, hashed, stored or broadcast. Single recursive pass, precompiled
// regexes, non-string leaves are returned untouched. Never mutates its input.

import type { EventEnvelope } from '../types'

export const REDACTED = '[REDACTED]'

// Keys whose string values are always redacted.
// Whole-word match on the key (camelCase split first), so `accessToken` and
// `api_key` match but `bypass_mode` and `compass` do not.
const SENSITIVE_KEY =
  /(^|[^a-z])(pass(word|wd)?|secret|token|api[_-]?key|authorization)s?($|[^a-z])/i
const isSensitiveKey = (k: string) => SENSITIVE_KEY.test(k.replace(/([a-z])([A-Z])/g, '$1_$2'))

// Each rule: [pattern, replacement]. Order matters (specific/multi-line first).
const RULES: Array<[RegExp, string]> = [
  // PEM private key blocks (also matches a truncated block with no END line).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // scheme://user:pass@host -> keep scheme, user and host; redact the password.
  [/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s@/?#]+(@)/g, `$1${REDACTED}$2`],
  // Authorization-style bearer tokens; keep the scheme word.
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${REDACTED}`],
  // JWT: header.payload.signature (base64url, header/payload start with eyJ).
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Anthropic then generic OpenAI-style keys.
  [/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // GitHub tokens.
  [/(?<![A-Za-z0-9])gh[pos]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // AWS access key id.
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, REDACTED],
  // Slack bot/user tokens.
  [/(?<![A-Za-z0-9])xox[bp]-[A-Za-z0-9-]{10,}/g, REDACTED],
]

export function redactString(value: string): string {
  let out = value
  for (const [re, repl] of RULES) out = out.replace(re, repl)
  return out
}

function walk(value: unknown, keyIsSensitive: boolean): unknown {
  if (typeof value === 'string') {
    return keyIsSensitive && value.length > 0 ? REDACTED : redactString(value)
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    // Sensitive key applies to string children of the array too.
    return value.map((v) => walk(v, keyIsSensitive))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, isSensitiveKey(k))
  }
  return out
}

/** Redact any JSON-like value. Returns a new structure; input is untouched. */
export function redactValue<T>(value: T): T {
  return walk(value, false) as T
}

/** Return a copy of the envelope with payload and _meta redacted. */
export function redactEnvelope(envelope: EventEnvelope): EventEnvelope {
  const out: EventEnvelope = { ...envelope, payload: redactValue(envelope.payload) }
  if (envelope._meta !== undefined) out._meta = redactValue(envelope._meta)
  return out
}
