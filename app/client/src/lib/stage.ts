import type { Agent, ParsedEvent } from '@/types'

/** Shape of GET /api/stages. Extra per-stage fields are ignored here. */
export interface StageMapping {
  main: string
  stages: Record<string, { label: string; [key: string]: unknown }>
}

export type StageKind = 'base' | 'needs-input' | 'done' | 'failed'

export interface Stage {
  label: string
  kind: StageKind
}

export const NEEDS_INPUT_LABEL = 'Needs input'
export const DONE_LABEL = 'Done'
export const FAILED_LABEL = 'Failed'

const NEEDS_INPUT_NOTIFICATIONS = new Set(['permission_prompt', 'agent_needs_input'])

/** Hooks from the same agent that mean a pending prompt was answered or abandoned. */
const RESOLVING_HOOKS = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'SubagentStop',
  'StopFailure',
])

/** Hooks that show the agent working again after a Stop. */
const RESUMING_HOOKS = new Set([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'SubagentStart',
  'SessionStart',
])

function isMainAgent(agent: Agent): boolean {
  return agent.id === agent.sessionId || (!agent.parentAgentId && !agent.agentType)
}

/** The agent an event belongs to. SubagentStop names its target in the payload. */
function eventAgentId(e: ParsedEvent): string {
  if (e.hookName === 'SubagentStop') {
    const target = (e.payload as Record<string, unknown> | null)?.agent_id
    if (typeof target === 'string' && target) return target
  }
  return e.agentId
}

function isNeedsInputEvent(e: ParsedEvent): boolean {
  if (e.hookName === 'PermissionRequest') return true
  if (e.hookName === 'Notification') {
    const t = (e.payload as Record<string, unknown> | null)?.notification_type
    return typeof t === 'string' && NEEDS_INPUT_NOTIFICATIONS.has(t)
  }
  return false
}

/**
 * Pure stage derivation for one agent. Never stored: recomputed from the
 * event stream, so replaying the same events yields the same result.
 * Returns null (no badge) for unknown agent types or missing mapping.
 */
export function deriveStage(
  agent: Agent,
  events: readonly ParsedEvent[],
  mapping: StageMapping | null | undefined,
): Stage | null {
  if (!mapping) return null
  let base: string | undefined
  if (isMainAgent(agent)) {
    base = mapping.main
  } else if (agent.agentType && Object.hasOwn(mapping.stages ?? {}, agent.agentType)) {
    base = mapping.stages[agent.agentType]?.label
  }
  if (typeof base !== 'string' || !base) return null

  // Order independent of input order so replay is deterministic.
  const mine = events
    .filter((e) => eventAgentId(e) === agent.id)
    .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)

  let pending = false
  let terminal: 'done' | 'failed' | null = null
  for (const e of mine) {
    const h = e.hookName
    if (RESOLVING_HOOKS.has(h)) pending = false
    if (isNeedsInputEvent(e)) pending = true
    if (h === 'Stop' || h === 'SubagentStop') terminal = 'done'
    else if (h === 'StopFailure') terminal = 'failed'
    else if (RESUMING_HOOKS.has(h)) terminal = null
  }

  if (pending) return { label: NEEDS_INPUT_LABEL, kind: 'needs-input' }
  if (terminal === 'failed') return { label: FAILED_LABEL, kind: 'failed' }
  if (terminal === 'done') return { label: DONE_LABEL, kind: 'done' }
  return { label: base, kind: 'base' }
}
