// The pure query-state → group-view projection for the Releases screen.
import type { ReleaseGroupView, ReleaseQueryLike, ReleaseStatusResponse } from '@/types/release'
import type { RepoId } from '@/utils/repos'
import { readFailureCopy } from '@/renderer/releases/copy'

export const WATCH_INTERVAL_MS = 60_000

export function buildReleaseGroup(repoId: RepoId, repo: string, query: ReleaseQueryLike): ReleaseGroupView {
  if (query.data === undefined) {
    return query.status === 'error' || query.isError ? { kind: 'error', repoId, repo, message: readFailureCopy(repo, query.errorMessage ?? 'the read was rejected') } : { kind: 'loading', repoId, repo }
  }
  if (!query.data.ok) return { kind: 'error', repoId, repo, message: readFailureCopy(repo, query.data.message) }
  return { kind: 'loaded', repoId, repo, status: query.data.status }
}

/** A refetch runs only while a release waits on a merge — nothing else moves without the operator. */
export function refetchIntervalFor(query: { readonly state: { readonly data: ReleaseStatusResponse | undefined } }): number | false {
  const response = query.state.data
  if (response?.ok !== true) return false
  const kind = response.status.phase.kind
  return kind === 'waiting-bump' || kind === 'waiting-merge' ? WATCH_INTERVAL_MS : false
}

/** The earliest read still shown behind a group whose refetch has since failed. */
export function staleSinceAt(queries: readonly ReleaseQueryLike[]): number | null {
  let earliest: number | null = null
  for (const query of queries) {
    if (!query.isError || query.data === undefined) continue
    if (earliest === null || query.dataUpdatedAt < earliest) earliest = query.dataUpdatedAt
  }
  return earliest
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7)
}
