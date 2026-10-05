// The sidebar footer's own read of `claude`/`gh` status (#316) — replaces
// the deleted `runtime.ts` strip with one status dot. Pure over the two
// queries' own result shape, so it is testable with a plain object rather
// than a real `QueryObserverResult`. The Settings screen's own richer
// "Check again" re-fetch is a separate ticket (#318-E); this is read-only.
import type { QueryObserverResult } from '@tanstack/react-query'
import type { RuntimePreflight } from '../../../shared/runtime/types'
import type { GhStatus } from '../../../shared/gh/types'

export type FooterStatusKind = 'success' | 'danger' | 'idle'

export interface FooterStatus {
  readonly status: FooterStatusKind
  readonly tooltip: string
}

/** A check that could not run is never shown as passing (ENGINEERING §4) —
 *  `idle` while either query is still loading or has no data yet, never a
 *  default `success`. */
export function footerStatus(preflightQuery: Pick<QueryObserverResult<RuntimePreflight>, 'status' | 'data'>, ghQuery: Pick<QueryObserverResult<GhStatus>, 'status' | 'data'>): FooterStatus {
  if (preflightQuery.status === 'pending' || ghQuery.status === 'pending') {
    return { status: 'idle', tooltip: 'Checking Claude Code and gh…' }
  }
  if (preflightQuery.status === 'error' || ghQuery.status === 'error') {
    return { status: 'idle', tooltip: "gh: Couldn't check" }
  }

  const preflight = preflightQuery.data
  const gh = ghQuery.data
  if (preflight === undefined || gh === undefined) {
    return { status: 'idle', tooltip: 'Checking Claude Code and gh…' }
  }

  if (gh.kind === 'unknown') {
    return { status: 'idle', tooltip: "gh: Couldn't check" }
  }

  const claudeOk = preflight.diagnosis === 'unverified' || preflight.diagnosis === 'verified'
  const ghOk = gh.kind === 'signed-in'

  if (claudeOk && ghOk) {
    return { status: 'success', tooltip: 'Claude Code and gh are ready' }
  }

  const claudeClause = claudeOk ? null : preflight.diagnosis === 'cli-missing' || preflight.diagnosis === 'bundled-fallback' ? 'Not installed' : 'Not ready'
  const ghClause = gh.kind === 'signed-in' ? null : gh.kind === 'missing' ? 'Not installed' : 'Signed out'

  const clauses = [claudeClause !== null ? `Claude Code: ${claudeClause}` : null, ghClause !== null ? `gh: ${ghClause}` : null].filter((clause): clause is string => clause !== null)

  return { status: 'danger', tooltip: clauses.join(' · ') }
}
