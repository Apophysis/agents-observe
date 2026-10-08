// Seed definitions for default filters. The `id` field is the stable
// primary key — never change an existing one or you'll create an
// orphan row. To rename or restructure a default filter, edit the
// fields in place and bump it via the next server start; the seed
// sync will UPDATE the row by id and preserve the user's enabled state.

import type { FilterPattern, FilterDisplay, FilterCombinator } from '../types'

export interface SeedFilter {
  id: string
  name: string
  pillName: string
  display: FilterDisplay
  combinator: FilterCombinator
  patterns: FilterPattern[]
  /** Optional per-filter config bag (color, etc.). Defaults to {}. */
  config?: Record<string, unknown>
}

export const SEED_FILTERS: SeedFilter[] = [
  {
    id: 'default-all',
    name: 'All',
    pillName: 'All',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
    config: { role: 'all-exclusions' },
  },
  {
    id: 'default-dynamic-tool-name',
    name: 'Dynamic tool name',
    pillName: '{toolName}',
    display: 'secondary',
    combinator: 'and',
    patterns: [
      { target: 'hook', regex: '^(PreToolUse|PostToolUse|PostToolUseFailure|PostToolBatch)$' },
    ],
    config: { color: '#7b8494' },
  },
  {
    id: 'default-prompts',
    name: 'Prompts',
    pillName: 'Prompts',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^(UserPromptSubmit|UserPromptExpansion)$' }],
    config: { color: '#c8457a' },
  },
  {
    id: 'default-tools',
    name: 'Tools',
    pillName: 'Tools',
    display: 'primary',
    combinator: 'and',
    // "Tool hooks, with a tool name that isn't Agent / TaskCreate /
    // TaskUpdate / mcp__*". Expressed as: tool hook + non-empty
    // tool name + negated match against the excluded set. The
    // negated pattern was previously a `(?!...)` lookahead; lookahead
    // isn't supported by RE2 (planned backend), so we use the
    // explicit `negate` flag instead.
    patterns: [
      { target: 'hook', regex: '^(PreToolUse|PostToolUse|PostToolUseFailure|PostToolBatch)$' },
      { target: 'tool', regex: '^.+' },
      { target: 'tool', regex: '^(Agent$|TaskCreate$|TaskUpdate$|mcp__)', negate: true },
    ],
    config: { color: '#3a7fdc' },
  },
  {
    id: 'default-agents',
    name: 'Agents',
    pillName: 'Agents',
    display: 'primary',
    combinator: 'or',
    patterns: [
      { target: 'hook', regex: '^(SubagentStart|TeammateIdle)$' },
      { target: 'tool', regex: '^Agent$' },
    ],
    config: { color: '#7a6ee0' },
  },
  {
    id: 'default-tasks',
    name: 'Tasks',
    pillName: 'Tasks',
    display: 'primary',
    combinator: 'or',
    patterns: [
      { target: 'hook', regex: '^(TaskCreated|TaskCompleted)$' },
      { target: 'tool', regex: '^Task(Create|Update)$' },
    ],
    config: { color: '#7a6ee0' },
  },
  {
    id: 'default-mcp',
    name: 'MCP',
    pillName: 'MCP',
    display: 'primary',
    combinator: 'or',
    patterns: [
      { target: 'hook', regex: '^(Elicitation|ElicitationResult)$' },
      { target: 'tool', regex: '^mcp__' },
    ],
    config: { color: '#13917a' },
  },
  {
    id: 'default-session',
    name: 'Session',
    pillName: 'Session',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^(Setup|SessionStart|SessionEnd)$' }],
    config: { color: '#7b8494' },
  },
  {
    id: 'default-permissions',
    name: 'Permissions',
    pillName: 'Permissions',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^PermissionRequest$' }],
    config: { color: '#d4581f' },
  },
  {
    id: 'default-needs-input',
    name: 'Needs input',
    pillName: 'Needs input',
    display: 'primary',
    combinator: 'or',
    // Payload patterns run against JSON.stringify(rawEvent), so the
    // Notification type appears as `"notification_type":"<type>"`.
    // idle_prompt is deliberately not matched.
    patterns: [
      { target: 'hook', regex: '^PermissionRequest$' },
      {
        target: 'payload',
        regex: '"notification_type":\\s*"(permission_prompt|agent_needs_input)"',
      },
    ],
    config: { color: '#b57700' },
  },
  {
    id: 'default-notifications',
    name: 'Notifications',
    pillName: 'Notifications',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^Notification$' }],
    config: { color: '#7b8494' },
  },
  {
    id: 'default-stop',
    name: 'Stop',
    pillName: 'Stop',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^(Stop|StopFailure|SubagentStop|stop_hook_summary)$' }],
    config: { color: '#7b8494' },
  },
  {
    id: 'default-compaction',
    name: 'Compaction',
    pillName: 'Compact',
    display: 'primary',
    combinator: 'and',
    patterns: [{ target: 'hook', regex: '^(PreCompact|PostCompact)$' }],
    config: { color: '#7b8494' },
  },
  {
    id: 'default-config',
    name: 'Config',
    pillName: 'Config',
    display: 'primary',
    combinator: 'and',
    patterns: [
      { target: 'hook', regex: '^(InstructionsLoaded|ConfigChange|CwdChanged|FileChanged)$' },
    ],
    config: { color: '#7b8494' },
  },
  {
    id: 'default-errors',
    name: 'Errors',
    pillName: 'Errors',
    display: 'primary',
    combinator: 'or',
    patterns: [
      { target: 'payload', regex: '"is_error":\\s*true' },
      { target: 'payload', regex: '"error":\\s*"[^"]+' },
    ],
    config: { color: '#d03b3b' },
  },
]
