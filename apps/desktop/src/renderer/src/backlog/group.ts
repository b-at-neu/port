// Pure projection from one repository's `backlog:list` query state into what `screen.tsx` renders — no DOM, no IPC call.
import type { BacklogResponse } from '../../../shared/backlog/types'
import type { RepoId } from '../../../shared/repos'
import { backlogFailureCopy, backlogInvokeErrorCopy, backlogTruncatedCopy } from './copy'

export interface BacklogRowView {
  readonly repoId: RepoId
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly url: string
  readonly assignee: string | null
  readonly updatedAt: string
}

export type BacklogGroupView =
  | { readonly kind: 'loading'; readonly repoId: RepoId; readonly repo: string }
  | { readonly kind: 'invoke-error'; readonly repoId: RepoId; readonly repo: string; readonly message: string }
  | { readonly kind: 'read-error'; readonly repoId: RepoId; readonly repo: string; readonly message: string }
  | { readonly kind: 'loaded'; readonly repoId: RepoId; readonly repo: string; readonly items: readonly BacklogRowView[]; readonly truncatedNote: string | null }

// `status` stays `'success'` on a refetch over previously-good data, so `isError`/`dataUpdatedAt` carry that fact separately.
export interface BacklogQueryLike {
  readonly status: 'pending' | 'error' | 'success'
  readonly data: BacklogResponse | undefined
  readonly isError: boolean
  readonly dataUpdatedAt: number
}

function assigneeLine(assignees: readonly string[], viewer: string | null): string | null {
  const others = assignees.filter((login) => login !== viewer)
  if (others.length === 0) return null
  return others.map((login) => `@${login}`).join(', ')
}

export function buildBacklogGroup(repoId: RepoId, repo: string, query: BacklogQueryLike): BacklogGroupView {
  if (query.data === undefined) {
    if (query.status === 'error') return { kind: 'invoke-error', repoId, repo, message: backlogInvokeErrorCopy(repo) }
    return { kind: 'loading', repoId, repo }
  }

  const response = query.data
  if (!response.ok) return { kind: 'read-error', repoId, repo, message: backlogFailureCopy(repo, response.kind, response.message) }

  const items = response.items.map((item) => ({
    repoId,
    repo,
    number: item.number,
    title: item.title,
    url: item.url,
    assignee: assigneeLine(item.assignees, response.viewer),
    updatedAt: item.updatedAt,
  }))
  const truncatedNote = response.total > response.scanned ? backlogTruncatedCopy(response.scanned) : null
  return { kind: 'loaded', repoId, repo, items, truncatedNote }
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
