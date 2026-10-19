// Pure projection from one repository's `backlog:list` query state into what `screen.tsx` renders — no DOM, no IPC call.
import type { BacklogGroupView, BacklogLabelFilter, BacklogQueryLike } from '@/types/backlog'
import type { RepoId } from '@/utils/repos'
import { backlogFailureCopy, backlogInvokeErrorCopy, backlogTruncatedCopy } from '@/renderer/backlog/copy'
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
    updatedAt: item.updatedAt,
    labels: item.labels,
    subIssueCount: item.subIssueCount,
  }))
  const truncatedNote = response.total > response.scanned ? backlogTruncatedCopy(response.scanned) : null
  return { kind: 'loaded', repoId, repo, items: applyLabelFilter(rows, filter), totalCount: rows.length, labelOptions: labelOptionsOf(rows, filter), truncatedNote }
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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// "3h ago"-shaped text, coarse on purpose — `exactTime` is what a tooltip is for.
export function relativeAge(iso: string, now: Date): string {
  const deltaMs = now.getTime() - new Date(iso).getTime()
  if (deltaMs < MINUTE) return 'just now'
  if (deltaMs < HOUR) return `${String(Math.floor(deltaMs / MINUTE))}m ago`
  if (deltaMs < DAY) return `${String(Math.floor(deltaMs / HOUR))}h ago`
  return `${String(Math.floor(deltaMs / DAY))}d ago`
}

export function exactTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
