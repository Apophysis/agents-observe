// hooks/scripts/lib/agents/claude-code.mjs
// Claude-Code-specific hook lib. Composes default.mjs and overrides
// agentClass + adds Claude-specific lifecycle flags
// (clearsNotification, stopsSession, resolveProject) per the three-layer
// contract spec.

import { readFileSync } from 'node:fs'
import { defaultLib } from './default.mjs'

// Hooks that should explicitly clear pending notifications
// (Claude-Code-specific naming).
const CLEARS_NOTIFICATION = new Set(['UserPromptSubmit'])
// Hooks that mark the session as terminally stopped.
const STOPS_SESSION = new Set(['SessionEnd'])

export function buildEnv(config) {
  return defaultLib.buildEnv(config)
}

/**
 * Build the event envelope for a Claude Code hook payload. Composes the
 * default lib then overrides agentClass and adds Claude-specific flags.
 *
 * @param {object} config
 * @param {object} log
 * @param {object} payload Raw hook payload from Claude Code.
 * @returns {{ envelope: object, hookEvent: string, toolName: string }}
 */
export function buildHookEvent(config, log, payload) {
  const result = defaultLib.buildHookEvent(config, log, payload)
  result.envelope.agentClass = 'claude-code'

  const flags = result.envelope.flags ?? {}
  const hookName = result.envelope.hookName
  if (CLEARS_NOTIFICATION.has(hookName)) flags.clearsNotification = true
  if (STOPS_SESSION.has(hookName)) flags.stopsSession = true
  // SessionStart re-resolves project lazily (cwd may newly be available).
  if (hookName === 'SessionStart') flags.resolveProject = true

  if (Object.keys(flags).length > 0) result.envelope.flags = flags
  return result
}

/**
 * Scan a Claude Code transcript jsonl for the session slug and the
 * git branch. Both fields are top-level on hook entries (e.g.
 * `{ "slug": "...", "gitBranch": "...", ... }`), so we read line-by-line
 * and extract either one as soon as we see it. Returns as soon as both
 * are found; the slug takes priority for the response but both are
 * surfaced to the server so it can fall back to git.branch.
 *
 * Shape returned matches the shared getSessionInfo contract:
 *   { slug: string|null, git: { branch: string|null, repository_url: null } }
 *
 * `repository_url` is always null for Claude Code since the transcripts
 * don't carry the remote origin.
 *
 * @param {object} args
 * @param {string} [args.transcriptPath] Absolute path to the jsonl transcript.
 * @param {string} [args.transcript_path] Snake-case alias accepted for
 *   back-compat with older callers.
 * @param {string} [args.agentClass] The session's agent class — always
 *   "claude-code" by the time this handler is dispatched, but kept in
 *   the arg signature for symmetry with other agents.
 * @param {string|null} [args.cwd] Working dir of the session when the
 *   callback was requested. Currently unused; reserved for future
 *   heuristics (e.g. git-repo discovery via `git -C <cwd>`).
 * @param {object} ctx
 * @param {object} ctx.log Logger with debug/warn/etc.
 */
export function getSessionInfo(args, { log }) {
  const transcriptPath = args?.transcriptPath ?? args?.transcript_path
  if (!transcriptPath) {
    log.debug('claude-code.getSessionInfo: no transcriptPath provided')
    return null
  }

  let content
  try {
    content = readFileSync(transcriptPath, 'utf8')
  } catch (err) {
    log.warn(`claude-code.getSessionInfo: cannot read transcript ${transcriptPath}: ${err.message}`)
    return null
  }

  let slug = null
  let branch = null
  let title = null

  let pos = 0
  while (pos < content.length) {
    const nextNewline = content.indexOf('\n', pos)
    const end = nextNewline === -1 ? content.length : nextNewline
    const line = content.slice(pos, end).trim()
    pos = end + 1
    if (!line) continue
    // Cheap pre-check: only parse lines that could contain what we want.
    const hasSlug = slug === null && line.includes('"slug"')
    const hasBranch = branch === null && line.includes('"gitBranch"')
    const hasTitle = title === null && line.includes('"type":"user"')
    if (!hasSlug && !hasBranch && !hasTitle) continue

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (slug === null && typeof entry.slug === 'string' && entry.slug) {
      slug = entry.slug
    }
    if (branch === null && typeof entry.gitBranch === 'string' && entry.gitBranch) {
      branch = entry.gitBranch
    }
    if (title === null) title = titleFromEntry(entry)
    if (slug !== null && branch !== null && title !== null) break
  }

  if (slug === null && branch === null && title === null) {
    log.debug(`claude-code.getSessionInfo: no slug, gitBranch or prompt in ${transcriptPath}`)
  } else {
    log.debug(`claude-code.getSessionInfo: slug=${slug} branch=${branch} title=${title}`)
  }

  return {
    slug,
    git: { branch, repository_url: null },
    title,
  }
}

const TITLE_MAX = 48

/**
 * Short session title from the first real user prompt: the first
 * non-empty line, hook/system blocks stripped, cut at a word boundary.
 * Returns null for meta entries, sidechains, slash-command echoes and
 * anything that is empty once stripped.
 */
export function titleFromEntry(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return null
  const c = entry.message?.content
  let text = typeof c === 'string' ? c : null
  if (Array.isArray(c)) text = c.find((b) => b?.type === 'text' && typeof b.text === 'string')?.text
  if (!text) return null
  text = text.replace(/<system-reminder[\s\S]*?<\/system-reminder[^>]*>/g, '').trim()
  if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) return null
  // Skip lines that are only a wrapper tag (e.g. <pasted_content id="..">).
  const first = text.split('\n').find((l) => l.trim() && !/^\s*<\/?[\w-]+[^>]*>\s*$/.test(l))
  const flat = first?.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20))}…`
}
