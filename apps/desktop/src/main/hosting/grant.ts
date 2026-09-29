// #99: narrows the SDK's own permission suggestions into a session-only
// grant, plus its renderer-safe summary. Pure — no I/O, no SDK call.
//
// This fails closed: a narrowing that is too strict costs a repeat prompt.
// One that is too loose writes a permanent rule into
// `.claude/settings.local.json` or `~/.claude/settings.json`, which is
// unrecoverable from inside the app, and in this repository a
// `sessionRequiredPaths` write besides. So the allowlist below keeps exactly
// three suggestion kinds and drops everything else — `replaceRules`,
// `removeRules`, `removeDirectories`, any `setMode` other than
// `acceptEdits`, and above all `bypassPermissions` — and rewrites every kept
// update's `destination` to `'session'` regardless of what the SDK proposed.
import type { SessionGrantItem } from '../../shared/hosting/types'
import type { PermissionUpdate } from './sdk'

export interface SessionGrant {
  readonly updates: readonly PermissionUpdate[]
  readonly summary: readonly SessionGrantItem[]
}

/** Returns `null` when nothing survives narrowing — the dialog then omits
 *  "allow for this session" entirely rather than offering a grant that
 *  would do nothing. */
export function narrowSessionGrant(suggestions: readonly PermissionUpdate[] | undefined): SessionGrant | null {
  if (suggestions === undefined || suggestions.length === 0) return null

  const updates: PermissionUpdate[] = []
  const summary: SessionGrantItem[] = []

  for (const suggestion of suggestions) {
    if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
      updates.push({ ...suggestion, destination: 'session' })
      for (const rule of suggestion.rules) {
        summary.push({ kind: 'rule', toolName: rule.toolName, ruleContent: rule.ruleContent ?? null })
      }
      continue
    }
    if (suggestion.type === 'addDirectories') {
      updates.push({ ...suggestion, destination: 'session' })
      for (const path of suggestion.directories) {
        summary.push({ kind: 'directory', path })
      }
      continue
    }
    if (suggestion.type === 'setMode' && suggestion.mode === 'acceptEdits') {
      updates.push({ ...suggestion, destination: 'session' })
      summary.push({ kind: 'accept-edits' })
      continue
    }
    // `replaceRules` / `removeRules` / `removeDirectories` / any other
    // `setMode` / anything a future SDK bump adds — dropped, not widened.
  }

  if (updates.length === 0) return null
  return { updates, summary }
}
