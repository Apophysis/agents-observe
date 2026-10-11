// app/server/src/services/redact.ts
//
// Server-side secret redaction. Runs on every incoming envelope before it is
// logged, hashed, stored or broadcast. Single recursive pass, precompiled
// regexes, non-string leaves are returned untouched. Never mutates its input.
//
// Built-in rules scan strings of any length, so every rule must stay
// linear-time: no nested quantifiers, no unbounded lookarounds. Each rule may
// carry literal hints; the regex only runs when the string contains one.

import type { EventEnvelope } from '../types'

export const REDACTED = '[REDACTED]'

/** Max chars a user-supplied pattern may scan (used by a later step). */
export const MAX_USER_SCAN_CHARS = 1_048_576

/** Objects/arrays nested deeper than this are replaced with REDACTED. */
export const MAX_DEPTH = 64

export interface RedactionRule {
  name: string
  re: RegExp
  replacement: string
  /** Literal substrings; the regex runs only if one is present (case-insensitive for /i rules). */
  hint?: string[]
}

// Keys whose string values are always redacted.
// Whole-word match on the key (camelCase split first), so `accessToken` and
// `api_key` match but `bypass_mode` and `compass` do not.
const SENSITIVE_KEY =
  /(^|[^a-z])(pass(word|wd)?|secret|token|api[_-]?key|authorization|credentials?|private[_-]?key|access[_-]?key|cookie|dsn|connection[_-]?string)s?($|[^a-z])/i
const isSensitiveKey = (k: string) =>
  SENSITIVE_KEY.test(k.replace(/([a-z])([A-Z])/g, '$1_$2')) || ENV_KEY_EXACT.test(k)

// Token rules must not start or end inside an alphanumeric run (base64, hex).
const NB = '(?<![A-Za-z0-9])'
const NA = '(?![A-Za-z0-9])'

// Key names for quoted JSON, YAML and assignment text inside strings. A
// bounded prefix (up to 6 `_`/`-` separated segments plus a camelCase head)
// covers `db_password`, `MYSQL_ROOT_PASSWORD`, `X-Auth-Token` and
// `accessToken`; rules anchor it at a word start so the cost stays bounded.
const KV_KEYS =
  'password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client_secret|authorization|credentials'
const KV_PREFIX = '(?:[A-Za-z0-9]{1,32}[_-]){0,6}[A-Za-z0-9]{0,32}'
// Line-anchored rules (one start per line) can afford longer prefixes and
// `.` separators: SPRING_SECURITY_..._CLIENT_SECRET, spring.datasource.password.
const LINE_PREFIX = '(?:[A-Za-z0-9]{1,32}[_.-]){0,8}[A-Za-z0-9]{0,32}'
const KV_HINT = ['pass', 'secret', 'token', 'key', 'authorization', 'credentials']
// `key = "value"` assignments (INI, TOML, Python, kwargs); also `secret_key`.
const ASSIGN_KEY = `${KV_PREFIX}(?:${KV_KEYS})(?:[_-]?key)?`
const LINE_KEY = `${LINE_PREFIX}(?:${KV_KEYS})(?:[_-]?key)?`
// Credential names used by query-string and CLI-flag rules.
const PARAM_KEYS =
  'password|passwd|secret|token|signature|api[_-]?key|access[_-]?key|private[_-]?key'
// Known gap: Python tuples such as `auth=("bob", "hunter22")` are not
// matched (no key name next to the value).
// Bare YAML values that are really type annotations in TS/Python code.
const TYPE_WORDS =
  'string|number|boolean|bigint|object|str|int|float|bool|bytes|dict|list|any|unknown|never|void|null|undefined|none|true|false|optional'

// env / .env segments (uppercase, `_`-separated, whole segment).
const ENV_SEGMENTS =
  'PGPASSWORD|PASSWORD|PASSWD|PASS|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS|CREDENTIAL|AUTH|DSN|DATABASE_URL|CONNECTION_STRING'
// KEY only as the last segment (STRIPE_KEY, not KEY_ID); PWD only with a
// prefix (MYSQL_PWD, not the shell's PWD=/current/dir).
const ENV_KEY =
  `(?:[A-Z0-9_]{0,64}_)?(?:${ENV_SEGMENTS})(?:_[A-Z0-9_]{0,64})?` +
  `|(?:[A-Z0-9_]{0,64}_)?KEY|[A-Z0-9_]{0,64}_PWD`
// Object keys that are env names get the same decision as env text.
const ENV_KEY_EXACT = new RegExp(`^(?:${ENV_KEY})$`)

const r = String.raw

// Order matters: structural / context rules first, then bare tokens.
export const BUILTIN_RULES: RedactionRule[] = [
  {
    // PEM private key blocks (also matches a truncated block with no END line).
    name: 'pem-private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replacement: REDACTED,
    hint: ['PRIVATE KEY-----'],
  },
  {
    // Slack incoming webhooks; keep the host and kind, redact the path.
    name: 'slack-webhook',
    re: /(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/g,
    replacement: `$1${REDACTED}`,
    hint: ['hooks.slack.com'],
  },
  {
    // scheme://[user]:pass@host -> keep scheme, user and host; redact the password.
    // Scheme length is bounded so long word runs cannot cause quadratic scans.
    // The password stops at `/` `?` `#` `@`: per RFC 3986 those must be
    // percent-encoded inside userinfo, so a raw one ends the authority.
    name: 'url-credentials',
    re: /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s:/?#@]*:)[^\s@/?#]+(@)/g,
    replacement: `$1${REDACTED}$2`,
    hint: ['://'],
  },
  {
    // HTTP auth header lines; keep the name and an optional scheme word.
    // Custom headers need at least one `X-`-style segment before Token,
    // Api-Key or Secret (X-Vault-Token, X-Shopify-Access-Token), so a bare
    // `token: value` or `secret: x` in YAML or TS code is not a header.
    // Values that look like code (`${x}`, template literals) are skipped.
    name: 'auth-header',
    re: /(?<![\w-])((?:Proxy-Authorization|Authorization|Set-Cookie|Cookie|Api-Key|Auth-Token|Access-Token|(?:[A-Za-z0-9]{1,32}-){1,3}(?:Token|Api-?Key|Secret))[ \t]*:[ \t]*(?:(?:Bearer|Basic|Token|Digest)[ \t]+)?)(?![\s$`{([])[^"'\r\n]{8,}/gi,
    replacement: `$1${REDACTED}`,
    hint: ['authorization', 'api-key', 'apikey', 'token', 'secret', 'cookie'],
  },
  {
    // Bearer tokens anywhere; keep the scheme word.
    name: 'bearer',
    re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: `$1${REDACTED}`,
    hint: ['Bearer'],
  },
  {
    // Azure connection-string secrets; keep the key name.
    name: 'azure-key',
    re: /\b((?:AccountKey|SharedAccessKey|SharedAccessSignature)=)[^;"'\s]+/gi,
    replacement: `$1${REDACTED}`,
    hint: ['accountkey', 'sharedaccess'],
  },
  {
    // AWS secret access key (40 chars), only right after its key name:
    // aws_secret_access_key, aws_secret_key, secretAccessKey (SDK configs).
    name: 'aws-secret-key',
    re: /((?:aws_?)?secret_?(?:access_?)?key["']?[ \t]*[:=][ \t]*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    replacement: `$1${REDACTED}`,
    hint: ['secret'],
  },
  {
    // Credentials in query strings and form bodies; keep the parameter name.
    // The KV prefix covers client_secret, oauth_client_secret, accessToken,
    // X-Amz-Security-Token; `sig`/`signature` are SAS and presigned-URL
    // signatures. Must follow `?` `&` `;` a quote, `-` (CLI flags such as
    // `--api-key=x`) or the start of the string, not a space, so
    // `f(x, token=t)` is untouched;
    // the short names `pwd` and `sig` need a real `?` `&` `;` so the shell's
    // `PWD=/dir` is left alone. `$VAR` values are skipped. Quoted values
    // (`--password="x"`) are taken whole, but only without whitespace, so
    // code like `"?token=" + token + "&x"` is not swallowed.
    name: 'query-credential',
    re: new RegExp(
      r`((?:(?<![^?&;"'-])${KV_PREFIX}(?:${PARAM_KEYS})(?:[_-]?key)?|(?<=[?&;])(?:pwd|sig))=)(?!["']?\$)(?:"[^"\s]+"|'[^'\s]+'|[^&#;\s"']+)`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    hint: ['pass', 'pwd', 'api', 'secret', 'token', 'sig', 'key'],
  },
  {
    // Space-separated CLI flags: `--token VALUE`, `--client-secret "x"`.
    // A start needs the full flag, so it stays linear. Skips `$VAR` and a
    // following flag (`--token --other`). `--password-stdin` is not a match.
    // Ambiguous by design: a boolean flag such as `--show-token arg` gets
    // its next argument redacted (fail closed).
    name: 'cli-flag-space',
    re: new RegExp(
      r`(?<![\w-])(--?${KV_PREFIX}(?:${PARAM_KEYS})(?:[_-]?key)?[ \t]+)(?!["']?\$|-)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"']+)`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    hint: ['pass', 'api', 'secret', 'token', 'key', 'signature'],
  },
  {
    // .npmrc auth lines for any registry: `//host/:_authToken=...`.
    name: 'npmrc-auth',
    re: /(:_(?:authToken|auth|password)=)[^\s"']+/g,
    replacement: `$1${REDACTED}`,
    hint: [':_auth', ':_password'],
  },
  {
    // .netrc, one-line form: `machine HOST login USER password PASS`
    // (`default` only at line start, so prose "default login ... password"
    // is untouched).
    name: 'netrc-inline',
    re: /((?:\bmachine[ \t]+\S{1,256}|^[ \t]*default)[ \t]+login[ \t]+\S{1,256}[ \t]+password[ \t]+)\S+/gm,
    replacement: `$1${REDACTED}`,
    hint: ['password'],
  },
  {
    // .netrc, multi-line form: an indented line that is exactly
    // `password VALUE` (so indented prose with more words is untouched).
    name: 'netrc-line',
    re: /^([ \t]+password[ \t]+)\S+(?=[ \t]*$)/gm,
    replacement: `$1${REDACTED}`,
    hint: ['password'],
  },
  {
    // Password=/Pwd= in connection strings. Either up to `;` (spaces allowed,
    // at most 128 chars so a long line without `;` stays linear), or a single
    // word (also at most 128, and stopping at `&` for URL query strings)
    // ending at a quote, whitespace or end of string, so Python kwargs
    // like `f(password=pw)` are left alone. `$VAR` is skipped. Case-sensitive
    // on purpose: uppercase `PWD=/dir` is the shell's cwd, not a password.
    // Each branch is an emulated atomic group (`(?=(x))\2`): the lookahead
    // takes the longest run once and the engine never backtracks into it.
    name: 'connection-string-password',
    re: /(?<![A-Za-z0-9_])((?:Password|password|PASSWORD|Pwd|pwd)=)(?![\s$;])(?:(?=([^;"'\r\n]{1,128}))\2(?=;)|(?=([^;"'\s(),&]{1,128}))\3(?=["'\s]|$))/g,
    replacement: `$1${REDACTED}`,
    hint: ['assword', 'ASSWORD', 'wd='],
  },
  {
    // env and .env lines: [export ]KEY=value where KEY has a sensitive
    // `_`-separated segment. Keep the key; skip `$VAR` references. Keys are
    // uppercase only (case-sensitive) so code like `f(token=x)` is untouched.
    // The key may follow `=` too (`--from-literal=DB_PASSWORD=x`).
    name: 'env-assignment',
    re: new RegExp(
      r`(?<![A-Za-z0-9_$.-])((?:export[ \t]+)?(?:${ENV_KEY})=)(?!["']?\$)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"']+)`,
      'g',
    ),
    replacement: `$1${REDACTED}`,
    hint: [
      'PASS',
      'PWD',
      'SECRET',
      'TOKEN',
      'KEY',
      'CREDENTIAL',
      'AUTH',
      'DSN',
      'DATABASE_URL',
      'CONNECTION_STRING',
    ],
  },
  {
    // `password = "x"`, `SECRET_KEY = 'x'`, `connect(password="x")`: quoted
    // values only (>= 4 chars), so `password = get_pw()` is untouched.
    // `"${VAR}"` references and values starting with whitespace (string
    // concatenation such as `"?token=" + token + "&x"`) are skipped.
    // Attribute and index targets work:
    // `app.secret_key = "x"`, `os.environ["DB_PASSWORD"] = "x"`.
    name: 'assign-double-quoted',
    re: new RegExp(
      r`((?<![\w$\\-])${ASSIGN_KEY}["']?\]?[ \t]*=[ \t]*")(?![\s$])(?:[^"\\\r\n]|\\.){4,}(?=")`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    name: 'assign-single-quoted',
    re: new RegExp(
      r`((?<![\w$\\-])${ASSIGN_KEY}["']?\]?[ \t]*=[ \t]*')(?![\s$])[^'\r\n]{4,}(?=')`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    // JSON-ish text: "password": "value" (key quoted or bare), double-quoted value.
    name: 'kv-double-quoted',
    re: new RegExp(
      r`((?<![\w\\-])(["']?)${ASSIGN_KEY}\2[ \t]*:[ \t]*")(?:[^"\\\r\n]|\\.){4,}(?=")`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    // Python-dict-ish text: 'api_key': 'value'.
    name: 'kv-single-quoted',
    re: new RegExp(r`((?<![\w\\-])(["']?)${ASSIGN_KEY}\2[ \t]*:[ \t]*')[^'\r\n]{4,}(?=')`, 'gi'),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    // Escaped JSON inside a string: \"password\": \"value\".
    name: 'kv-escaped-json',
    re: new RegExp(
      r`(\\"${ASSIGN_KEY}\\"[ \t]*:[ \t]*\\")(?:[^"\\\r\n]|\\[^"\r\n]){4,}(?=\\")`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    // YAML `key: value` lines with a bare value. Skips type annotations
    // (`token: string`), anchors/aliases/tags/blocks, `${VAR}`, lines ending
    // in `,` `;` `{` `(` `[` (object literals and code) and lines ending in
    // `]` (flow lists, or a header line an earlier rule already redacted).
    name: 'yaml-bare',
    re: new RegExp(
      r`^([ \t]*(?:-[ \t]+)?${LINE_KEY}[ \t]*:[ \t]+)(?!(?:${TYPE_WORDS})\b)[^\s"'|>&*!{[$#][^\r\n]{3,}$(?<![,;{(\[\]])`,
      'gim',
    ),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    // Unquoted INI `key = value` lines (.my.cnf, .pypirc, ~/.aws/credentials).
    // Same code heuristics as yaml-bare, plus no `(` anywhere in the value.
    // Anchored at column 0 (no indentation) so indented Python such as
    // `    password = config.password` inside a function is untouched.
    name: 'ini-bare',
    re: new RegExp(
      r`^(${LINE_KEY}[ \t]*=[ \t]*)(?!(?:${TYPE_WORDS})\b)[^\s"'|>&*!{[$#(][^\r\n(]{3,}$(?<![,;{(\[\]])`,
      'gim',
    ),
    replacement: `$1${REDACTED}`,
    hint: KV_HINT,
  },
  {
    // JWT: header.payload.signature (base64url, header/payload start with eyJ).
    name: 'jwt',
    // The lookbehind (not \b) keeps `eyJ-eyJ-...` runs linear.
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: REDACTED,
    hint: ['eyJ'],
  },
  {
    // Anthropic keys.
    name: 'anthropic',
    re: new RegExp(r`${NB}sk-ant-[A-Za-z0-9_-]{8,}`, 'g'),
    replacement: REDACTED,
    hint: ['sk-ant-'],
  },
  {
    // Generic OpenAI-style keys.
    name: 'openai',
    re: new RegExp(r`${NB}sk-[A-Za-z0-9_-]{20,}`, 'g'),
    replacement: REDACTED,
    hint: ['sk-'],
  },
  {
    name: 'github-token',
    re: new RegExp(r`${NB}gh[pos]_[A-Za-z0-9]{20,}`, 'g'),
    replacement: REDACTED,
    hint: ['ghp_', 'gho_', 'ghs_'],
  },
  {
    name: 'github-pat',
    re: new RegExp(r`${NB}github_pat_[A-Za-z0-9_]{20,}`, 'g'),
    replacement: REDACTED,
    hint: ['github_pat_'],
  },
  {
    name: 'aws-access-key-id',
    re: new RegExp(r`${NB}AKIA[0-9A-Z]{16}${NA}`, 'g'),
    replacement: REDACTED,
    hint: ['AKIA'],
  },
  {
    name: 'google-api-key',
    re: new RegExp(r`${NB}AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`, 'g'),
    replacement: REDACTED,
    hint: ['AIza'],
  },
  {
    // Stripe secret and restricted keys, live and test.
    name: 'stripe',
    re: new RegExp(r`${NB}(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}${NA}`, 'g'),
    replacement: REDACTED,
    hint: ['_live_', '_test_'],
  },
  {
    name: 'npm-token',
    re: new RegExp(r`${NB}npm_[A-Za-z0-9]{36}${NA}`, 'g'),
    replacement: REDACTED,
    hint: ['npm_'],
  },
  {
    name: 'sendgrid',
    re: new RegExp(r`${NB}SG\.[\w-]{22}\.[\w-]{43}(?![\w-])`, 'g'),
    replacement: REDACTED,
    hint: ['SG.'],
  },
  {
    name: 'twilio-api-key',
    re: new RegExp(r`${NB}SK[0-9a-fA-F]{32}${NA}`, 'g'),
    replacement: REDACTED,
    hint: ['SK'],
  },
  {
    // Slack bot/user/app/refresh/session tokens and app-level tokens.
    name: 'slack-token',
    re: new RegExp(r`${NB}(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,}`, 'g'),
    replacement: REDACTED,
    hint: ['xox', 'xapp-'],
  },
  {
    // GitLab personal access tokens.
    name: 'gitlab-pat',
    re: new RegExp(r`${NB}glpat-[A-Za-z0-9_-]{20,}`, 'g'),
    replacement: REDACTED,
    hint: ['glpat-'],
  },
  {
    // Hugging Face access tokens.
    name: 'huggingface',
    re: new RegExp(r`${NB}hf_[A-Za-z0-9]{34}${NA}`, 'g'),
    replacement: REDACTED,
    hint: ['hf_'],
  },
  {
    // Google OAuth access tokens.
    name: 'google-oauth',
    re: new RegExp(r`${NB}ya29\.[0-9A-Za-z_-]{20,}`, 'g'),
    replacement: REDACTED,
    hint: ['ya29.'],
  },
  {
    // PyPI API tokens (macaroon; the fixed head is base64 of "pypi.org").
    name: 'pypi-token',
    re: new RegExp(r`${NB}pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}(?![A-Za-z0-9_-])`, 'g'),
    replacement: REDACTED,
    hint: ['pypi-'],
  },
]

interface PreparedRule {
  re: RegExp
  replacement: string
  hint?: string[]
  ci: boolean
}

const prepare = (rules: readonly RedactionRule[]): PreparedRule[] =>
  rules.map((rule) => {
    const ci = rule.re.flags.includes('i')
    return {
      re: rule.re,
      replacement: rule.replacement,
      hint: rule.hint && (ci ? rule.hint.map((h) => h.toLowerCase()) : rule.hint),
      ci,
    }
  })

const PREPARED_BUILTINS = prepare(BUILTIN_RULES)

function applyRules(value: string, rules: readonly PreparedRule[]): string {
  // Hints are checked against the original value: replacements only insert
  // REDACTED, so they cannot create a hint that was not already present.
  let lower: string | undefined
  let out = value
  for (const rule of rules) {
    if (rule.hint) {
      const hay = rule.ci ? (lower ??= value.toLowerCase()) : value
      if (!rule.hint.some((h) => hay.includes(h))) continue
    }
    out = out.replace(rule.re, rule.replacement)
  }
  return out
}

export function redactString(value: string): string {
  if (value.length === 0) return value
  return applyRules(value, PREPARED_BUILTINS)
}

function walk(value: unknown, keyIsSensitive: boolean, depth: number): unknown {
  if (typeof value === 'string') {
    return keyIsSensitive && value.length > 0 ? REDACTED : redactString(value)
  }
  if (value === null || typeof value !== 'object') return value
  // Fail closed on absurd nesting instead of risking a stack overflow.
  if (depth > MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) {
    // Sensitive key applies to string children of the array too.
    return value.map((v) => walk(v, keyIsSensitive, depth + 1))
  }
  // fromEntries defines own properties, so a `__proto__` key from JSON.parse
  // survives instead of hitting the prototype setter.
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      walk(v, isSensitiveKey(k), depth + 1),
    ]),
  )
}

/** Redact any JSON-like value. Returns a new structure; input is untouched. */
export function redactValue<T>(value: T): T {
  return walk(value, false, 0) as T
}

/** Return a copy of the envelope with payload and _meta redacted. */
export function redactEnvelope(envelope: EventEnvelope): EventEnvelope {
  const out: EventEnvelope = { ...envelope, payload: redactValue(envelope.payload) }
  if (envelope._meta !== undefined) out._meta = redactValue(envelope._meta)
  return out
}
