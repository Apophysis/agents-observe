// app/server/src/utils/slug.ts
//
// Phase 3: the heuristic project-dir + multi-candidate slug helpers
// went away. The new project resolver only needs a single deterministic
// slug for find-or-create-by-slug.

/**
 * Derive a slug from an absolute path. Pure: take the basename,
 * lowercase, replace runs of non-alphanumeric with a single hyphen,
 * trim leading/trailing hyphens. Returns 'unnamed' for empty input.
 *
 * Examples:
 *   /Users/joe/Development/my-app          -> 'my-app'
 *   /Users/joe/.claude/projects/-MyApp     -> 'myapp'
 *   /Users/joe/.codex/sessions/2026/04/17  -> '17'
 *
 * Note: Phase 3 intentionally does NOT collapse Codex's /YYYY/MM/DD
 * structure into a single date slug. The hook lib is the right place
 * for that mapping if Codex needs it; the server stays neutral.
 */
export function deriveSlugFromPath(p: string): string {
  if (!p) return 'unnamed'
  // Split on both separators: the server runs in Linux but sessions can
  // report Windows paths (C:\Users\joe\app), which posix basename() leaves whole.
  const base = p.split(/[\\/]+/).filter(Boolean).pop() || 'unnamed'
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'unnamed'
}
