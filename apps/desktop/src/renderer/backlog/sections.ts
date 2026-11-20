// Pure Backlog section logic — which repositories show, and which rows keyboard navigation can reach.
import type { RepoId } from '@/utils/repos'
import { epicBodyEntries } from '@/renderer/backlog/epics'
import type { BacklogEpicGroup, BacklogGroupView, BacklogRowView } from '@/types/backlog'

interface RepoRef {
  readonly id: RepoId
}

export function rowKey(repoId: RepoId, number: number): string {
  return `${repoId}:${String(number)}`
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

function epicRows(group: BacklogEpicGroup, collapsedEpics: ReadonlySet<string>): BacklogRowView[] {
  const { epic, unplaced } = group
  if (collapsedEpics.has(rowKey(epic.repoId, epic.number))) return [epic]
  const body = epicBodyEntries(group).flatMap((entry) => (entry.kind === 'wave' ? entry.wave.rows : epicRows(entry.group, collapsedEpics)))
  return [epic, ...body, ...unplaced]
}

export function navigableRows(groups: readonly BacklogGroupView[], collapsed: ReadonlySet<RepoId>, collapsedEpics: ReadonlySet<string>): BacklogRowView[] {
  return groups.flatMap((group) => {
    if (group.kind !== 'loaded' || collapsed.has(group.repoId)) return []
    return group.layout.entries.flatMap((entry) => (entry.kind === 'row' ? [entry.row] : epicRows(entry.group, collapsedEpics)))
  })
}
