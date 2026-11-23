// Pure projection from one repository's `backlog:list` query state into what `screen.tsx` renders — no DOM, no IPC call.
import type { BacklogGroupView, BacklogLabelFilter, BacklogQueryLike } from '@/types/backlog'
import type { RepoId } from '@/utils/repos'
import { backlogFailureCopy, backlogInvokeErrorCopy, backlogTruncatedCopy } from '@/renderer/backlog/copy'
import { buildEpicLayout } from '@/renderer/backlog/epics'
import { EMPTY_FILTER, applyLabelFilter, labelOptionsOf } from '@/renderer/backlog/filter'

function assigneeLine(assignees: readonly string[], viewer: string | null): string | null {
  const others = assignees.filter((login) => login !== viewer)
  if (others.length === 0) return null
  return others.map((login) => `@${login}`).join(', ')
}

export function buildBacklogGroup(repoId: RepoId, repo: string, query: BacklogQueryLike, filter: BacklogLabelFilter = EMPTY_FILTER): BacklogGroupView {
  if (query.data === undefined) {
    if (query.status === 'error') return { kind: 'invoke-error', repoId, repo, message: backlogInvokeErrorCopy(repo) }
    return { kind: 'loading', repoId, repo }
  }

  const response = query.data
  if (!response.ok) return { kind: 'read-error', repoId, repo, message: backlogFailureCopy(repo, response.kind, response.message) }

  const rows = response.items.map((item) => ({
    repoId,
    repo,
    number: item.number,
    title: item.title,
    url: item.url,
    assignee: assigneeLine(item.assignees, response.viewer),
    createdAt: item.createdAt,
    labels: item.labels,
    subIssueCount: item.subIssueCount,
    blockers: item.blockers,
    blocking: item.blocking,
    parent: item.parent,
    children: item.children,
  }))
  const truncatedNote = response.total > response.scanned ? backlogTruncatedCopy(response.scanned) : null
  const items = applyLabelFilter(rows, filter)
  const layout = buildEpicLayout(rows, new Set(items.map((row) => row.number)))
  return { kind: 'loaded', repoId, repo, items, totalCount: rows.length, labelOptions: labelOptionsOf(rows, filter), truncatedNote, layout }
}

// The header's `staleSince` line — the earliest read still shown behind a group whose refetch has since failed.
export function staleSinceAt(groups: readonly { readonly query: BacklogQueryLike }[]): number | null {
  let earliest: number | null = null
  for (const { query } of groups) {
    if (!query.isError || query.data === undefined) continue
    if (earliest === null || query.dataUpdatedAt < earliest) earliest = query.dataUpdatedAt
  }
  return earliest
}
