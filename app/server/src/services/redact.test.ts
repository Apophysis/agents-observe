import { describe, test, expect } from 'vitest'
import {
  redactString,
  redactValue,
  redactEnvelope,
  REDACTED,
  BUILTIN_RULES,
  MAX_DEPTH,
  MAX_USER_SCAN_CHARS,
} from './redact'
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

  test('wider key set: credentials, private/access keys, cookie, dsn, connection string', () => {
    const out = redactValue({
      privateKey: 'a',
      accessKey: 'b',
      cookie: 'c',
      credentials: 'd',
      credential: 'e',
      SENTRY_DSN: 'f',
      connectionString: 'g',
      'private-key': 'h',
    }) as Record<string, string>
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true)
  })

  test('non-string values under sensitive keys stay untouched', () => {
    const input = { token_usage: 5, cookie: null, privateKey: false }
    expect(redactValue(input)).toEqual(input)
  })

  test('env-style object keys follow the env rule decisions', () => {
    const out = redactValue({
      env: {
        PGPASSWORD: 'hunter22',
        MYSQL_PWD: 'hunter22',
        ENCRYPTION_KEY: 'abc123def456',
        PWD: '/home/user',
        NODE_ENV: 'production',
        // Numeric: the object-key rule already treats `tokens` as sensitive for strings.
        MAX_TOKENS: 100,
        BYPASS_MODE: 'on',
      },
    }) as { env: Record<string, unknown> }
    expect(out.env).toEqual({
      PGPASSWORD: REDACTED,
      MYSQL_PWD: REDACTED,
      ENCRYPTION_KEY: REDACTED,
      PWD: '/home/user',
      NODE_ENV: 'production',
      MAX_TOKENS: 100,
      BYPASS_MODE: 'on',
    })
  })

  test('__proto__ key from JSON.parse survives as an own property', () => {
    const input = JSON.parse('{"__proto__": {"a": "x", "token": "t"}, "b": 1}')
    const out = redactValue(input) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(JSON.stringify(out)).toBe(`{"__proto__":{"a":"x","token":"${REDACTED}"},"b":1}`)
  })
})

// Built from parts so the literals are not themselves scanner bait.
const google = 'AIza' + 'Sy' + 'B'.repeat(33)
const stripeLive = 'sk_' + 'live_' + 'a1B2'.repeat(6)
const stripeTest = 'sk_' + 'test_' + 'a1B2'.repeat(6)
const stripeRestricted = 'rk_' + 'live_' + 'a1B2'.repeat(6)
const npmTok = 'npm_' + 'A1b2'.repeat(9)
const sendgrid = 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43)
const twilio = 'SK' + '0123456789abcdef'.repeat(2)
const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

const glpat = 'glpat-' + 'a1B2c3D4e5F6g7H8i9J0'
const hfTok = 'hf_' + 'a1B2'.repeat(8) + 'cd'
const ya29 = 'ya29.' + 'a0AfB_byC1x2'.repeat(3)
const pypiTok = 'pypi-AgEIcHlwaS5vcmc' + 'CJDU4ZjA'.repeat(8)

// [label, rule that must fire on its own, input, expected full redaction]
const POSITIVES: Array<[string, string, string, string]> = [
  ['google', 'google-api-key', `const k = "${google}"`, `const k = "${REDACTED}"`],
  ['stripe live', 'stripe', `key ${stripeLive} end`, `key ${REDACTED} end`],
  ['stripe test (redacted by decision)', 'stripe', `key ${stripeTest} end`, `key ${REDACTED} end`],
  ['stripe restricted', 'stripe', `key ${stripeRestricted} end`, `key ${REDACTED} end`],
  [
    'npm',
    'npm-token',
    `//registry.npmjs.org/:_authToken=${npmTok}`,
    `//registry.npmjs.org/:_authToken=${REDACTED}`,
  ],
  ['sendgrid', 'sendgrid', `key ${sendgrid} end`, `key ${REDACTED} end`],
  ['twilio', 'twilio-api-key', `key ${twilio} end`, `key ${REDACTED} end`],
  ['slack xoxa', 'slack-token', 'tok xoxa-2-1234567890-abcdef end', `tok ${REDACTED} end`],
  ['slack xoxr', 'slack-token', 'tok xoxr-1234567890-abcdef end', `tok ${REDACTED} end`],
  ['slack xoxs', 'slack-token', 'tok xoxs-1234567890-abcdef end', `tok ${REDACTED} end`],
  ['slack xapp', 'slack-token', 'tok xapp-1-A0123456789-abcdef end', `tok ${REDACTED} end`],
  ['gitlab pat', 'gitlab-pat', `tok ${glpat} end`, `tok ${REDACTED} end`],
  ['hugging face', 'huggingface', `tok ${hfTok} end`, `tok ${REDACTED} end`],
  ['google oauth', 'google-oauth', `tok ${ya29} end`, `tok ${REDACTED} end`],
  [
    'jwt',
    'jwt',
    'x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fw end',
    `x ${REDACTED} end`,
  ],
  [
    'slack webhook',
    'slack-webhook',
    'curl https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXX -d x',
    `curl https://hooks.slack.com/services/${REDACTED} -d x`,
  ],
  [
    'slack workflow webhook',
    'slack-webhook',
    'url https://hooks.slack.com/workflows/T0/A0/123/abc',
    `url https://hooks.slack.com/workflows/${REDACTED}`,
  ],
  [
    'azure AccountKey',
    'azure-key',
    'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abc123+/def==;EndpointSuffix=core.windows.net',
    `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${REDACTED};EndpointSuffix=core.windows.net`,
  ],
  [
    'azure SharedAccessKey',
    'azure-key',
    'Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=abc/def+ghi=',
    `Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=${REDACTED}`,
  ],
  ['conn Pwd', 'connection-string-password', 'Pwd=hunter22;Server=db', `Pwd=${REDACTED};Server=db`],
  [
    'conn Password with spaces',
    'connection-string-password',
    'Server=db;User Id=sa;Password=my secret pw;Database=app',
    `Server=db;User Id=sa;Password=${REDACTED};Database=app`,
  ],
  [
    'libpq keyword string',
    'connection-string-password',
    'host=db user=app password=hunter22 dbname=x',
    `host=db user=app password=${REDACTED} dbname=x`,
  ],
  [
    'aws secret (ini)',
    'aws-secret-key',
    `aws_secret_access_key = ${awsSecret}`,
    `aws_secret_access_key = ${REDACTED}`,
  ],
  [
    'aws secret (json)',
    'aws-secret-key',
    `{"AwsSecretAccessKey": "${awsSecret}"}`,
    `{"AwsSecretAccessKey": "${REDACTED}"}`,
  ],
  [
    'aws secret (sdk camelCase)',
    'aws-secret-key',
    `new S3Client({ credentials: { secretAccessKey: '${awsSecret}' } })`,
    `new S3Client({ credentials: { secretAccessKey: '${REDACTED}' } })`,
  ],
  [
    'query access_token',
    'query-credential',
    'https://api.example.com/v1?user=bob&access_token=abc123&x=1',
    `https://api.example.com/v1?user=bob&access_token=${REDACTED}&x=1`,
  ],
  ['query apikey', 'query-credential', 'GET /x?apikey=abc123def', `GET /x?apikey=${REDACTED}`],
  [
    'query sslpassword',
    'query-credential',
    'postgres://db/app?sslmode=require&sslpassword=pw123',
    `postgres://db/app?sslmode=require&sslpassword=${REDACTED}`,
  ],
  [
    'oauth form body',
    'query-credential',
    'client_secret=abc123&grant_type=refresh_token&refresh_token=def456',
    `client_secret=${REDACTED}&grant_type=refresh_token&refresh_token=${REDACTED}`,
  ],
  [
    'azure sas url',
    'query-credential',
    'https://a.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&sig=AbC%2Fde%3D',
    `https://a.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&sig=${REDACTED}`,
  ],
  [
    'url without user',
    'url-credentials',
    'redis://:s3cret@cache:6379/0',
    `redis://:${REDACTED}@cache:6379/0`,
  ],
  ['header X-Api-Key', 'auth-header', 'X-Api-Key: 0123456789abcdef', `X-Api-Key: ${REDACTED}`],
  [
    'header X-Auth-Token',
    'auth-header',
    'X-Auth-Token: 0123456789abcdef',
    `X-Auth-Token: ${REDACTED}`,
  ],
  [
    'header Api-Key',
    'auth-header',
    'curl -H "Api-Key: 0123456789abcdef"',
    `curl -H "Api-Key: ${REDACTED}"`,
  ],
  [
    'header Proxy-Authorization keeps scheme',
    'auth-header',
    'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
    `Proxy-Authorization: Basic ${REDACTED}`,
  ],
  [
    'header Cookie stops at quote',
    'auth-header',
    `curl -H "Cookie: session=abcdef123456; theme=dark" x`,
    `curl -H "Cookie: ${REDACTED}" x`,
  ],
  [
    'header Set-Cookie',
    'auth-header',
    'Set-Cookie: sid=abcdef1234567890',
    `Set-Cookie: ${REDACTED}`,
  ],
  [
    'header lowercase',
    'auth-header',
    'authorization: token abcdef123456',
    `authorization: token ${REDACTED}`,
  ],
  ['env', 'env-assignment', 'DB_PASSWORD=hunter22', `DB_PASSWORD=${REDACTED}`],
  [
    'env export quoted',
    'env-assignment',
    'export API_KEY="abc def ghi"',
    `export API_KEY=${REDACTED}`,
  ],
  [
    'env inline before command',
    'env-assignment',
    'GITHUB_TOKEN=abc123 npm publish',
    `GITHUB_TOKEN=${REDACTED} npm publish`,
  ],
  [
    'env PGPASSWORD',
    'env-assignment',
    'PGPASSWORD=hunter22 psql -h db',
    `PGPASSWORD=${REDACTED} psql -h db`,
  ],
  ['env MYSQL_PWD', 'env-assignment', 'MYSQL_PWD=hunter22', `MYSQL_PWD=${REDACTED}`],
  [
    'env *_KEY last segment',
    'env-assignment',
    'ENCRYPTION_KEY=abc123def456',
    `ENCRYPTION_KEY=${REDACTED}`,
  ],
  ['env STRIPE_KEY', 'env-assignment', 'STRIPE_KEY=xyz12345', `STRIPE_KEY=${REDACTED}`],
  [
    'env after =',
    'env-assignment',
    'kubectl create secret generic db --from-literal=DB_PASSWORD=hunter22',
    `kubectl create secret generic db --from-literal=DB_PASSWORD=${REDACTED}`,
  ],
  [
    'dotenv multiline',
    'env-assignment',
    "NODE_ENV=production\nSENTRY_DSN=https://abc@o1.ingest.sentry.io/1\nJWT_SECRET='s3cr3t'\nPORT=3000",
    `NODE_ENV=production\nSENTRY_DSN=${REDACTED}\nJWT_SECRET=${REDACTED}\nPORT=3000`,
  ],
  [
    'django settings',
    'assign-single-quoted',
    "SECRET_KEY = 'django-insecure-abc123'",
    `SECRET_KEY = '${REDACTED}'`,
  ],
  [
    'toml / ini',
    'assign-double-quoted',
    '[db]\npassword = "hunter22"\nhost = "db"',
    `[db]\npassword = "${REDACTED}"\nhost = "db"`,
  ],
  [
    'python kwarg literal',
    'assign-double-quoted',
    'psycopg2.connect(host="db", password="S3cretPw!")',
    `psycopg2.connect(host="db", password="${REDACTED}")`,
  ],
  [
    'json double-quoted',
    'kv-double-quoted',
    '{"password": "hunter22", "user": "bob"}',
    `{"password": "${REDACTED}", "user": "bob"}`,
  ],
  [
    'json prefixed key',
    'kv-double-quoted',
    '{"refresh_token":"abcd1234"}',
    `{"refresh_token":"${REDACTED}"}`,
  ],
  [
    'json camelCase key',
    'kv-double-quoted',
    '{"accessToken": "ya29.a0AfB_byC1x2"}',
    `{"accessToken": "${REDACTED}"}`,
  ],
  ['python dict', 'kv-single-quoted', "{'api_key': 'abcd1234'}", `{'api_key': '${REDACTED}'}`],
  [
    'escaped json',
    'kv-escaped-json',
    '{\\"client_secret\\": \\"abcd1234\\", \\"a\\": 1}',
    `{\\"client_secret\\": \\"${REDACTED}\\", \\"a\\": 1}`,
  ],
  [
    'yaml bare',
    'yaml-bare',
    'db:\n  host: localhost\n  password: hunter22\n  port: 5432',
    `db:\n  host: localhost\n  password: ${REDACTED}\n  port: 5432`,
  ],
  ['yaml camelCase key', 'yaml-bare', 'refreshToken: abcd1234efgh', `refreshToken: ${REDACTED}`],
  ['yaml quoted', 'kv-double-quoted', 'api_key: "abcd1234"', `api_key: "${REDACTED}"`],
  // Round 3: multi-segment prefixes, `*_key` suffix in text, attribute targets.
  [
    'compose multi-segment key',
    'yaml-bare',
    'environment:\n  MYSQL_ROOT_PASSWORD: hunter22',
    `environment:\n  MYSQL_ROOT_PASSWORD: ${REDACTED}`,
  ],
  [
    'json header-style key',
    'kv-double-quoted',
    '{"X-Auth-Token": "abcdef1234567890"}',
    `{"X-Auth-Token": "${REDACTED}"}`,
  ],
  [
    'json two-segment prefix',
    'kv-double-quoted',
    '{"github_access_token": "abcd1234efgh"}',
    `{"github_access_token": "${REDACTED}"}`,
  ],
  [
    'json SECRET_KEY',
    'kv-double-quoted',
    '{"SECRET_KEY": "django-insecure-abc123"}',
    `{"SECRET_KEY": "${REDACTED}"}`,
  ],
  ['yaml secret_key', 'yaml-bare', 'secret_key: abc123def456', `secret_key: ${REDACTED}`],
  [
    'python dict secretKey',
    'kv-single-quoted',
    "{'secretKey': 'abcd1234'}",
    `{'secretKey': '${REDACTED}'}`,
  ],
  [
    'assign multi-segment',
    'assign-double-quoted',
    'MYSQL_ROOT_PASSWORD = "hunter22"',
    `MYSQL_ROOT_PASSWORD = "${REDACTED}"`,
  ],
  [
    'assign attribute (flask)',
    'assign-double-quoted',
    'app.secret_key = "dev-secret-123"',
    `app.secret_key = "${REDACTED}"`,
  ],
  [
    'assign this.apiKey',
    'assign-double-quoted',
    'this.apiKey = "abcd1234efgh"',
    `this.apiKey = "${REDACTED}"`,
  ],
  [
    'assign process.env',
    'assign-double-quoted',
    'process.env.DB_PASSWORD = "hunter22"',
    `process.env.DB_PASSWORD = "${REDACTED}"`,
  ],
  [
    'assign os.environ index',
    'assign-double-quoted',
    'os.environ["DB_PASSWORD"] = "hunter22"',
    `os.environ["DB_PASSWORD"] = "${REDACTED}"`,
  ],
  [
    'ini .my.cnf',
    'ini-bare',
    '[client]\nuser = root\npassword = hunter22\n',
    `[client]\nuser = root\npassword = ${REDACTED}\n`,
  ],
  [
    'ini .pypirc',
    'ini-bare',
    `[pypi]\nusername = __token__\npassword = ${pypiTok}`,
    `[pypi]\nusername = __token__\npassword = ${REDACTED}`,
  ],
  [
    'ini aws credentials',
    'ini-bare',
    '[default]\naws_session_token = IQoJb3JpZ2luX2VjEJr//////////wEaCXVz',
    `[default]\naws_session_token = ${REDACTED}`,
  ],
  [
    'pypi token',
    'pypi-token',
    `twine upload -p ${pypiTok} dist/*`,
    `twine upload -p ${REDACTED} dist/*`,
  ],
  [
    'presigned s3 url',
    'query-credential',
    'https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEJr&X-Amz-Signature=3f7a9b',
    `https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Security-Token=${REDACTED}&X-Amz-Signature=${REDACTED}`,
  ],
  [
    'query oauth_client_secret',
    'query-credential',
    'https://x.io/cb?oauth_client_secret=abc123&a=1',
    `https://x.io/cb?oauth_client_secret=${REDACTED}&a=1`,
  ],
  [
    'query camelCase',
    'query-credential',
    'GET /v1?accessToken=abc123def',
    `GET /v1?accessToken=${REDACTED}`,
  ],
  [
    'query password then more params',
    'query-credential',
    'postgres://db/app?sslmode=require&password=pw&application_name=x',
    `postgres://db/app?sslmode=require&password=${REDACTED}&application_name=x`,
  ],
  [
    'cli --token',
    'query-credential',
    'vercel deploy --token=Xy9AbC123def456',
    `vercel deploy --token=${REDACTED}`,
  ],
  [
    'cli --access-token',
    'query-credential',
    'doctl auth init --access-token=dop_v1_abc123def456',
    `doctl auth init --access-token=${REDACTED}`,
  ],
  [
    'cli --api-key',
    'query-credential',
    'tool --api-key=abcd1234efgh',
    `tool --api-key=${REDACTED}`,
  ],
  [
    'cli --client-secret',
    'query-credential',
    'login --client-secret=s3cr3tvalue --x',
    `login --client-secret=${REDACTED} --x`,
  ],
  // Rules that previously had no case where only they apply.
  [
    'bearer in other header',
    'bearer',
    'curl -H "X-Token: Bearer abcdefgh12345"',
    `curl -H "X-Token: Bearer ${REDACTED}"`,
  ],
  // Short enough that the generic sk- rule (20+ chars after `sk-`) cannot match.
  ['anthropic short', 'anthropic', 'key sk-ant-api03-abc end', `key ${REDACTED} end`],
  ['openai', 'openai', 'key sk-abcdefghijklmnopqrstuvwx end', `key ${REDACTED} end`],
  [
    'github token',
    'github-token',
    'tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 end',
    `tok ${REDACTED} end`,
  ],
  [
    'github pat',
    'github-pat',
    'tok github_pat_11ABCDEFG0abcdefghijkl_mnop end',
    `tok ${REDACTED} end`,
  ],
  ['aws access key id', 'aws-access-key-id', 'id AKIAIOSFODNN7EXAMPLE end', `id ${REDACTED} end`],
  [
    'pem',
    'pem-private-key',
    'a\n-----BEGIN EC PRIVATE KEY-----\nMHcC\n-----END EC PRIVATE KEY-----\nb',
    `a\n${REDACTED}\nb`,
  ],
  // Round 4: quoted and space-separated CLI flag values.
  [
    'cli --password="..."',
    'query-credential',
    'mysql -h db -u root --password="S3cretPw!" app',
    `mysql -h db -u root --password=${REDACTED} app`,
  ],
  [
    "cli --api-key='...'",
    'query-credential',
    "tool --api-key='abcd1234efgh'",
    `tool --api-key=${REDACTED}`,
  ],
  [
    'cli --token VALUE',
    'cli-flag-space',
    'vercel deploy --token Xy9AbC123def456',
    `vercel deploy --token ${REDACTED}`,
  ],
  [
    'cli --password "two words"',
    'cli-flag-space',
    'mysql --password "my pass" db',
    `mysql --password ${REDACTED} db`,
  ],
  [
    'cli --client-secret VALUE',
    'cli-flag-space',
    'login --client-secret s3cr3tvalue --x',
    `login --client-secret ${REDACTED} --x`,
  ],
  // Documented choice: a boolean-looking flag still redacts its next argument.
  [
    'cli ambiguous --show-token ARG (fail closed)',
    'cli-flag-space',
    'gh auth status --show-token foo',
    `gh auth status --show-token ${REDACTED}`,
  ],
  // access_key / secret_key / private_key as parameter names.
  [
    'query access_key',
    'query-credential',
    'http://api.ipstack.com/check?access_key=0123456789abcdef',
    `http://api.ipstack.com/check?access_key=${REDACTED}`,
  ],
  [
    'cli --access_key= --secret_key=',
    'query-credential',
    's3cmd --access_key=DO00ABCDEF --secret_key=AbCdEf0123456789AbCdEf0123456789AbCdEf01234',
    `s3cmd --access_key=${REDACTED} --secret_key=${REDACTED}`,
  ],
  ['query private_key', 'query-credential', '?private_key=abc123def', `?private_key=${REDACTED}`],
  // Custom auth headers.
  [
    'header X-Vault-Token',
    'auth-header',
    'curl -H "X-Vault-Token: hvs.CAESIJabcdef0123456789" https://vault:8200/v1/x',
    `curl -H "X-Vault-Token: ${REDACTED}" https://vault:8200/v1/x`,
  ],
  [
    'header X-Access-Token',
    'auth-header',
    'curl -H "X-Access-Token: 0123456789abcdef" x',
    `curl -H "X-Access-Token: ${REDACTED}" x`,
  ],
  [
    'header X-Shopify-Access-Token',
    'auth-header',
    // Split so no token-shaped literal sits in the source (push protection).
    'curl -H "X-Shopify-Access-Token: ' + 'shpat_' + '0123456789abcdef0123456789abcdef' + '" x',
    `curl -H "X-Shopify-Access-Token: ${REDACTED}" x`,
  ],
  [
    'header custom Secret',
    'auth-header',
    'X-Webhook-Secret: whsec_0123456789abcdef',
    `X-Webhook-Secret: ${REDACTED}`,
  ],
  // .npmrc for any registry.
  [
    'npmrc _authToken',
    'npmrc-auth',
    '//npm.pkg.example.com/:_authToken=AKCp8nAbCdEf0123456789',
    `//npm.pkg.example.com/:_authToken=${REDACTED}`,
  ],
  [
    'npmrc _auth',
    'npmrc-auth',
    '//registry.example.com/:_auth=dXNlcjpwYXNz',
    `//registry.example.com/:_auth=${REDACTED}`,
  ],
  [
    'npmrc _password',
    'npmrc-auth',
    '//registry.example.com/:_password=aHVudGVyMg==',
    `//registry.example.com/:_password=${REDACTED}`,
  ],
  // Long prefixes.
  [
    'compose 7-segment key',
    'yaml-bare',
    'environment:\n  SPRING_SECURITY_OAUTH2_CLIENT_REGISTRATION_GITHUB_CLIENT_SECRET: 0a1b2c3d4e5f6789',
    `environment:\n  SPRING_SECURITY_OAUTH2_CLIENT_REGISTRATION_GITHUB_CLIENT_SECRET: ${REDACTED}`,
  ],
  [
    'assign 4-segment key',
    'assign-double-quoted',
    'ACME_BILLING_DB_RO_PASSWORD = "hunter22"',
    `ACME_BILLING_DB_RO_PASSWORD = "${REDACTED}"`,
  ],
  [
    'json 4-segment key',
    'kv-double-quoted',
    '{"ACME_BILLING_DB_RO_PASSWORD": "hunter22"}',
    `{"ACME_BILLING_DB_RO_PASSWORD": "${REDACTED}"}`,
  ],
  [
    'spring properties dotted key',
    'ini-bare',
    'spring.datasource.url=jdbc:x\nspring.datasource.password = hunter22',
    `spring.datasource.url=jdbc:x\nspring.datasource.password = ${REDACTED}`,
  ],
  [
    'spring properties no spaces',
    'ini-bare',
    'spring.datasource.password=hunter22',
    `spring.datasource.password=${REDACTED}`,
  ],
  // .netrc.
  [
    'netrc one line',
    'netrc-inline',
    'machine api.heroku.com login me@example.com password 01234567-89ab-cdef-0123-456789abcdef',
    `machine api.heroku.com login me@example.com password ${REDACTED}`,
  ],
  [
    'netrc default line',
    'netrc-inline',
    'default login anonymous password me@example.com',
    `default login anonymous password ${REDACTED}`,
  ],
  [
    'netrc multi-line',
    'netrc-line',
    'machine github.com\n  login me\n  password ghx_abc123def\n',
    `machine github.com\n  login me\n  password ${REDACTED}\n`,
  ],
]

const ruleByName = (name: string) => {
  const rule = BUILTIN_RULES.find((r) => r.name === name)
  if (!rule) throw new Error(`no rule ${name}`)
  return rule
}

describe('built-in rules: positives', () => {
  test.each(POSITIVES)('%s', (_label, _rule, input, expected) => {
    expect(redactString(input)).toBe(expected)
  })

  test.each(POSITIVES)(
    '%s: rule %s fires on its own and its hint is present',
    (_l, name, input) => {
      const rule = ruleByName(name)
      const ci = rule.re.flags.includes('i')
      const hay = ci ? input.toLowerCase() : input
      expect(rule.hint?.some((h) => hay.includes(ci ? h.toLowerCase() : h))).toBe(true)
      expect(input.replace(rule.re, rule.replacement)).not.toBe(input)
    },
  )
})

describe('built-in rules: negatives', () => {
  test.each([
    ['google too long', 'AIza' + 'B'.repeat(36)],
    ['google inside alnum run', 'x' + google],
    ['stripe too short', 'sk_live_abc123'],
    ['stripe unknown mode', 'sk_prod_' + 'a1B2'.repeat(6)],
    ['npm config var', 'npm_config_cache=/tmp/npm'],
    ['npm too short', 'npm_' + 'A'.repeat(20)],
    ['sendgrid wrong shape', 'SG.abc.def'],
    ['twilio non-hex', 'SK' + 'g'.repeat(32)],
    ['twilio inside hex run', 'ab' + twilio],
    ['slack unknown prefix', 'xoxz-1234567890-abcdef'],
    ['slack docs host', 'https://api.slack.com/services/T000/B000'],
    ['azure empty value', 'AccountKey= ;x'],
    ['python password kwarg', 'login(user, password=password)'],
    ['conn env reference', 'Password=$DB_PASS'],
    ['aws secret without key name', `value = ${awsSecret}`],
    ['query non-sensitive', 'https://x.io/?page=2&tokens=5&sort=asc'],
    ['url with port, no password', 'http://localhost:8080/path'],
    ['header short value', 'Cookie: a=1'],
    ['header code value', 'const headers = { Authorization: `Bearer ${token}` }'],
    ['env reference', 'DB_PASSWORD=$SECRET_FROM_VAULT'],
    ['env quoted reference', 'export API_TOKEN="${API_TOKEN}"'],
    ['env non-sensitive', 'BYPASS_MODE=on'],
    ['env PATH', 'export PATH=/usr/bin'],
    ['json short value', '{"password": "abc"}'],
    ['json non-sensitive key', '{"passwords_enabled": "true", "tokenizer": "bpe"}'],
    ['json number value', '{"token": 5}'],
    ['yaml type annotation', 'interface A {\n  token: string\n  password: string | undefined\n}'],
    ['yaml object literal', '  secret: process.env.SECRET,'],
    ['yaml variable', 'password: ${DB_PASSWORD}'],
    ['gitlab too short', 'glpat-short123'],
    ['hugging face too short', 'hf_' + 'a'.repeat(33)],
    ['hugging face inside word', 'shf_' + 'a'.repeat(34)],
    ['google oauth too short', 'ya29.short'],
    ['jwt inside word', 'xeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc'],
    ['shell PWD is the cwd', 'PWD=/home/user/project'],
    ['indented python attribute', 'def f():\n    password = config.password\n'],
    ['python comparison', 'if password == "abcd1234":'],
    ['cli flag variable', 'deploy --token=$VERCEL_TOKEN'],
    ['pypi head only', 'pypi-AgEIcHlwaS5vcmc' + 'A'.repeat(20)],
    ['cli --token $VAR', 'deploy --token $VERCEL_TOKEN'],
    ['cli --token followed by a flag', 'tool --token --verbose'],
    ['cli --password-stdin', 'echo "$PW" | docker login -u me --password-stdin ghcr.io'],
    ['cli unrelated flag with word token', 'git commit --message token'],
    ['css custom property', ':root { --color-token: #fff; }'],
    ['code building a query string', 'const url = "/x?token=" + token + "&x=1"'],
    ['ts object property (no header)', '  token: req.headers.authorization,'],
    ['netrc-like prose', 'Use the default login page; the password field is required.'],
    ['indented prose with password', '    password reset is required for all users'],
    ['npmrc non-secret key', '//registry.example.com/:always-auth=true'],
    ['env KEY not last segment', 'SORT_KEY_NAME=created_at'],
    ['env variable after $', 'echo $DB_PASSWORD=x'],
    ['assign unquoted call', 'password = get_pw()'],
    ['assign short quoted', 'token = "abc"'],
    ['query after space (kwarg)', 'f(x, token=t)'],
  ])('%s', (_name, input) => {
    expect(redactString(input)).toBe(input)
  })

  // The aws-secret-key rule itself needs exactly 40 chars; as an INI line the
  // value is still redacted by ini-bare (fail closed).
  test('aws secret wrong length: aws rule skips it, ini-bare still redacts the line', () => {
    const input = `aws_secret_access_key = ${awsSecret.slice(1)}`
    const rule = ruleByName('aws-secret-key')
    expect(input.replace(rule.re, rule.replacement)).toBe(input)
    expect(redactString(input)).toBe(`aws_secret_access_key = ${REDACTED}`)
  })

  // Decision: MAX_TOKENS=100 is NOT redacted. The env rule matches whole
  // `_`-separated segments, and TOKENS is not the TOKEN segment, so no
  // minimum value length is needed. (MAX_TOKEN=100 would be redacted.)
  test('MAX_TOKENS=100 is not redacted', () => {
    expect(redactString('MAX_TOKENS=100')).toBe('MAX_TOKENS=100')
  })
})

describe('false positives in ordinary text', () => {
  const ts = [
    "import { readFile } from 'node:fs/promises'",
    'interface Config {',
    '  token: string',
    '  password?: string',
    '}',
    'export async function login(password: string): Promise<void> {',
    "  const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ password }) })",
    '  const headers = { Authorization: `Bearer ${token}` }',
    '  if (!res.ok) throw new Error(`login failed: ${res.status}`)',
    '}',
  ].join('\n')
  const py = [
    'def get_token(session):',
    '    token = session.headers.get("Authorization")',
    '    if not token:',
    '        raise ValueError("missing password")',
    '    return requests.get(url, headers={"Authorization": token}, timeout=10)',
    'def connect(password: str = None):',
    '    return db.connect(user="app", password=password)',
  ].join('\n')
  const sh = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'export PATH=/usr/bin:$PATH',
    'for f in src/*.ts; do echo "$f"; done',
    'git log --oneline | head -n 5',
    'API_TOKEN=$API_TOKEN npm run deploy',
    'grep -r "password" ./docs',
  ].join('\n')

  test.each([
    ['typescript', ts],
    ['python', py],
    ['shell', sh],
    ['file paths', '/home/user/project/src/secret-manager/token.ts C:\\Users\\me\\api_key.txt'],
    ['git sha', 'commit 3f786850e387550fdab836ed7e6dc881de23001b (HEAD -> main)'],
    ['uuid', 'id 123e4567-e89b-12d3-a456-426614174000 and 550E8400-E29B-41D4-A716-446655440000'],
    ['BYPASS_MODE', 'BYPASS_MODE=on'],
    ['PATH', 'export PATH=/usr/bin'],
    ['MAX_TOKENS', 'MAX_TOKENS=100'],
    [
      'prose',
      'Please reset your password before logging in; the password policy requires 12 characters. Tokens expire daily.',
    ],
  ])('%s untouched', (_name, input) => {
    expect(redactString(input)).toBe(input)
  })

  test('200 KB base64 data URI untouched', () => {
    const bytes = Buffer.from(
      Array.from({ length: 150_000 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 13) & 255),
    )
    const blob = 'data:image/png;base64,' + bytes.toString('base64')
    expect(blob.length).toBeGreaterThan(200_000)
    expect(redactString(blob)).toBe(blob)
  })
})

describe('rule table and limits', () => {
  test('every built-in rule has a name, a global regex and a replacement', () => {
    const names = new Set<string>()
    for (const rule of BUILTIN_RULES) {
      expect(rule.name).toBeTruthy()
      expect(rule.re.flags).toContain('g')
      expect(typeof rule.replacement).toBe('string')
      names.add(rule.name)
    }
    expect(names.size).toBe(BUILTIN_RULES.length)
  })

  test('every rule has a positive test case', () => {
    const covered = new Set(POSITIVES.map(([, rule]) => rule))
    expect(BUILTIN_RULES.map((r) => r.name).filter((n) => !covered.has(n))).toEqual([])
  })

  test('MAX_USER_SCAN_CHARS is 1 MiB', () => {
    expect(MAX_USER_SCAN_CHARS).toBe(1_048_576)
  })
})

describe('depth cap', () => {
  test(`10k-level nesting does not throw; subtrees deeper than ${MAX_DEPTH} are REDACTED`, () => {
    let deep: Record<string, unknown> = { leaf: 'AKIAIOSFODNN7EXAMPLE' }
    for (let i = 0; i < 10_000; i++) deep = { child: deep }
    let out: unknown
    expect(() => {
      out = redactValue(deep)
    }).not.toThrow()
    let node = out as Record<string, unknown>
    for (let i = 0; i < MAX_DEPTH; i++) node = node.child as Record<string, unknown>
    expect(typeof node).toBe('object')
    expect(node.child).toBe(REDACTED)
  })

  test('nesting within the cap is preserved', () => {
    const v = { a: { b: { c: [{ d: 'ok', password: 'x' }] } } }
    expect(redactValue(v)).toEqual({ a: { b: { c: [{ d: 'ok', password: REDACTED }] } } })
  })

  test('deep arrays also hit the cap', () => {
    let deep: unknown = ['x']
    for (let i = 0; i < 10_000; i++) deep = [deep]
    expect(() => redactValue(deep)).not.toThrow()
  })
})

describe('time budget', () => {
  const time = (s: string) => {
    const t0 = performance.now()
    redactString(s)
    return performance.now() - t0
  }

  test('1 MB mixed string redacts quickly', () => {
    const chunk = [
      'const x = tasks.map((t) => t.id) // token handling',
      'DB_PASSWORD=hunter22 and "password": "hunter22" and api_key: abcd1234',
      'Authorization: Bearer abcdefgh12345678 https://u:p@h.io/?token=abc',
      'AKIAIOSFODNN7EXAMPLE sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz0123',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'Please reset your password; SK and AIza and xox and npm_ appear in prose.',
    ].join('\n')
    const big = (chunk + '\n').repeat(Math.ceil(1_048_576 / (chunk.length + 1)))
    expect(big.length).toBeGreaterThanOrEqual(1_048_576)
    redactString(big) // warm up
    const out = redactString(big)
    expect(out).not.toMatch(/hunter22|abcdefgh12345678|AKIAIOSFODNN7/)
    expect(time(big)).toBeLessThan(1000)
  })

  const timeRule = (re: RegExp, repl: string, s: string) => {
    const t0 = performance.now()
    s.replace(re, repl)
    return performance.now() - t0
  }

  // Each input contains a hint of the rule it targets, so the regex really
  // runs; the rule is also timed alone so an earlier rule cannot mask it. The
  // first four were quadratic before their fixes (seconds to minutes).
  test.each([
    ['connection-string-password', 'pwd='.repeat(20_000) + ')'],
    ['connection-string-password', 'password='.repeat(10_000) + ','],
    ['connection-string-password', 'password=a '.repeat(95_000)],
    ['jwt', 'eyJ-'.repeat(250_000)],
    ['connection-string-password', 'Pwd=x '.repeat(5000)],
    ['url-credentials', 'a.'.repeat(500_000) + '://'],
    ['env-assignment', (' ' + 'PASS_'.repeat(13) + 'X').repeat(15_000)],
    ['auth-header', 'Authorization: ' + 'a'.repeat(1_000_000)],
    ['kv-double-quoted', '"password": "' + 'a'.repeat(1_000_000)],
    ['yaml-bare', 'password: ' + 'a,'.repeat(500_000)],
    ['kv-double-quoted', '"token": "'.repeat(100_000)],
  ])('adversarial %s stays fast', (name, s) => {
    const rule = ruleByName(name)
    const ci = rule.re.flags.includes('i')
    const hay = ci ? s.toLowerCase() : s
    expect(rule.hint?.some((h) => hay.includes(ci ? h.toLowerCase() : h))).toBe(true)
    expect(timeRule(rule.re, rule.replacement, s)).toBeLessThan(2000)
    expect(time(s)).toBeLessThan(2000)
  })

  // Scaling sweep: real key literals for every rule, crossed with terminators,
  // in two shapes ((literal + term) repeated, and literal repeated + one term).
  // Each rule runs alone on the inputs that contain one of its hints (the
  // only inputs it would ever see). A case is slow if the 80k input exceeds
  // 1 s or scales worse than 8x the 20k input (plus a floor), on two tries.
  const LITERALS = [
    'password=',
    'pwd=',
    'Pwd=',
    'PASSWORD=',
    'token=',
    'api_key = "',
    'api_key = ',
    '"secret": "',
    "'secret': '",
    'secret:',
    'secret: ',
    'password: ',
    'Authorization: ',
    'authorization: Bearer ',
    'Bearer ',
    'Cookie: ',
    'X-Auth-Token: ',
    'client_secret=',
    'X-Amz-Signature=',
    '--token=',
    '&pwd=',
    '?sig=',
    'PGPASSWORD=',
    'MYSQL_ROOT_PASSWORD=',
    'MYSQL_ROOT_PASSWORD: ',
    'export DB_PASSWORD=',
    'os.environ["DB_PASSWORD"] = "',
    'this.apiKey = "',
    '\\"password\\": \\"',
    'aws_secret_access_key = ',
    'secretAccessKey: ',
    'AccountKey=',
    'redis://:',
    'https://u:',
    'https://hooks.slack.com/services/',
    '-----BEGIN PRIVATE KEY-----',
    'eyJ',
    'eyJa.',
    'AKIA',
    'AIza',
    'sk-',
    'sk-ant-',
    'sk_live_',
    'ghp_',
    'github_pat_',
    'npm_',
    'SG.',
    'SK',
    'xoxb-',
    'xapp-',
    'glpat-',
    'hf_',
    'ya29.',
    'pypi-AgEIcHlwaS5vcmc',
  ]
  const TERMINATORS = ['', ' ', ',', '(', ')', ';', '"', "'", '\n', '\\', '&', ']', '}']

  test('every rule scales linearly on key-literal x terminator inputs', () => {
    const slow: string[] = []
    let cases = 0
    for (const rule of BUILTIN_RULES) {
      const ci = rule.re.flags.includes('i')
      const hints = (rule.hint ?? []).map((h) => (ci ? h.toLowerCase() : h))
      for (const lit of LITERALS) {
        const hay = ci ? lit.toLowerCase() : lit
        if (!hints.some((h) => hay.includes(h))) continue
        for (const term of TERMINATORS) {
          for (const shape of ['unit', 'tail'] as const) {
            const build = (n: number) =>
              shape === 'unit'
                ? (lit + term).repeat(Math.ceil(n / (lit.length + term.length)))
                : lit.repeat(Math.ceil(n / lit.length)) + term
            const big = build(80_000)
            cases++
            if (timeRule(rule.re, rule.replacement, big) < 50) continue
            const small = build(20_000)
            let ok = false
            let detail = ''
            for (let attempt = 0; attempt < 2 && !ok; attempt++) {
              const ts = timeRule(rule.re, rule.replacement, small)
              const tb = timeRule(rule.re, rule.replacement, big)
              ok = tb < 1000 && tb < 8 * ts + 50
              detail = `20k=${ts.toFixed(0)}ms 80k=${tb.toFixed(0)}ms`
            }
            if (!ok)
              slow.push(
                `${rule.name} lit=${JSON.stringify(lit)} term=${JSON.stringify(term)} ${shape} ${detail}`,
              )
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1000)
    expect(slow).toEqual([])
  }, 120_000)

  // Structural shapes aimed at the bounded prefixes, lookbehind starts and
  // the connection-string branches, against every rule (no hint filter).
  const SHAPES: Array<[string, (n: number) => string]> = [
    ["'a-'", (n) => 'a-'.repeat(n / 2)],
    ["'a'*32+'-'", (n) => ('a'.repeat(32) + '-').repeat(n / 33)],
    ["'.'+'a'*32", (n) => ('.' + 'a'.repeat(32)).repeat(n / 33)],
    ["'a_'*3+'a'*32+' '", (n) => ('a_'.repeat(3) + 'a'.repeat(32) + ' ').repeat(n / 39)],
    ["'x-'*n+'password='", (n) => 'x-'.repeat(n / 2) + 'password='],
    ["('pwd='*64+'\\n')", (n) => ('pwd='.repeat(64) + '\n').repeat(n / 257)],
  ]

  test('every rule scales linearly on structural shapes', () => {
    const slow: string[] = []
    for (const rule of BUILTIN_RULES) {
      for (const [label, build] of SHAPES) {
        const big = build(80_000)
        if (timeRule(rule.re, rule.replacement, big) < 50) continue
        const small = build(20_000)
        let ok = false
        let detail = ''
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          const ts = timeRule(rule.re, rule.replacement, small)
          const tb = timeRule(rule.re, rule.replacement, big)
          ok = tb < 1000 && tb < 8 * ts + 50
          detail = `20k=${ts.toFixed(0)}ms 80k=${tb.toFixed(0)}ms`
        }
        if (!ok) slow.push(`${rule.name} shape=${label} ${detail}`)
      }
    }
    expect(slow).toEqual([])
  }, 60_000)

  test("1 MB 'pwd='.repeat(262144)+')' through redactString stays under 1 s", () => {
    const s = 'pwd='.repeat(262_144) + ')'
    expect(s.length).toBeGreaterThan(1_000_000)
    expect(time(s)).toBeLessThan(1000)
  })
})
