// Fails closed: keeps only addRules(allow)/addDirectories/setMode(acceptEdits), rewriting destination to 'session'.
import type { SessionGrantItem } from '../../shared/hosting/types'
import type { PermissionUpdate } from './sdk'

export interface SessionGrant {
  readonly updates: readonly PermissionUpdate[]
  readonly summary: readonly SessionGrantItem[]
}

/** `null` when nothing survives narrowing, so the dialog omits the grant option entirely. */
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
