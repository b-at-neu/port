// Pure Backlog section logic — which repositories show, and which rows keyboard navigation can reach.
import type { RepoId } from '@/utils/repos'
import type { BacklogGroupView, BacklogRowView } from '@/types/backlog'

interface RepoRef {
  readonly id: RepoId
}

export function visibleRepos<T extends RepoRef>(repos: readonly T[], hidden: ReadonlySet<RepoId>): T[] {
  return repos.filter((repo) => !hidden.has(repo.id))
}

export function toggleHiddenRepo(hidden: ReadonlySet<RepoId>, id: RepoId): ReadonlySet<RepoId> {
  const next = new Set(hidden)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// Counts only registered repositories, so a stale stored id never skews "2 of 3".
export function repoFilterCount(repos: readonly RepoRef[], hidden: ReadonlySet<RepoId>): { readonly shown: number; readonly total: number } {
  return { shown: visibleRepos(repos, hidden).length, total: repos.length }
}

export function navigableRows(groups: readonly BacklogGroupView[], collapsed: ReadonlySet<RepoId>): BacklogRowView[] {
  return groups.flatMap((group) => (group.kind === 'loaded' && !collapsed.has(group.repoId) ? group.items : []))
}
