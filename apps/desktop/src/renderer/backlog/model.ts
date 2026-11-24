// The Backlog page's pure decisions: which repositories list tickets, what the body shows, and which page state that is.
import type { PageStateKind } from '@/renderer/components/page-state'
import { backlogReposInvokeErrorCopy, backlogReposReadErrorCopy } from '@/renderer/backlog/copy'
import { visibleRepos } from '@/renderer/backlog/sections'
import type { ReposListResponse } from '@/types/ipc'
import { isReadyRepo } from '@/utils/repos'
import type { RepoId, RepositoryEntry } from '@/utils/repos'

export interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

export type BacklogBody =
  | { readonly kind: 'unknown-repo'; readonly repoId: RepoId }
  | { readonly kind: 'no-repos' }
  | { readonly kind: 'scoped-not-ready' }
  | { readonly kind: 'all-hidden' }
  | { readonly kind: 'groups' }

export interface BacklogView {
  readonly readyRepos: readonly ReadyRepo[]
  readonly notReadyRepos: readonly RepositoryEntry[]
  readonly shownRepos: readonly ReadyRepo[]
  readonly body: BacklogBody
}

function bodyOf(params: { readonly entries: readonly RepositoryEntry[]; readonly knownList: boolean; readonly scopedRepo: RepoId | null; readonly ready: readonly ReadyRepo[]; readonly shown: readonly ReadyRepo[] }): BacklogBody {
  const { entries, knownList, scopedRepo, ready, shown } = params
  if (scopedRepo !== null && knownList && !entries.some((entry) => entry.id === scopedRepo)) return { kind: 'unknown-repo', repoId: scopedRepo }
  if (ready.length === 0) return { kind: 'no-repos' }
  if (shown.length === 0) return scopedRepo !== null ? { kind: 'scoped-not-ready' } : { kind: 'all-hidden' }
  return { kind: 'groups' }
}

export function backlogView(params: { readonly reposData: ReposListResponse | undefined; readonly scopedRepo: RepoId | null; readonly hidden: ReadonlySet<RepoId> }): BacklogView {
  const { reposData, scopedRepo, hidden } = params
  const knownList = reposData?.ok === true
  const entries = reposData?.ok === true ? reposData.repositories : []
  const readyRepos = entries.filter(isReadyRepo).map((entry) => ({ id: entry.id, repo: entry.config.repo }))
  const notReadyRepos = entries.filter((entry) => !isReadyRepo(entry) && (scopedRepo === null || entry.id === scopedRepo))
  const shownRepos = scopedRepo !== null ? readyRepos.filter((repo) => repo.id === scopedRepo) : visibleRepos(readyRepos, hidden)
  return { readyRepos, notReadyRepos, shownRepos, body: bodyOf({ entries, knownList, scopedRepo, ready: readyRepos, shown: shownRepos }) }
}

interface ReposQueryLike {
  readonly data: ReposListResponse | undefined
  readonly status: 'pending' | 'error' | 'success'
}

/** A failed read with nothing in hand is an error, never "no repositories"; a reply that says `ok: false` is shown, not hidden. */
export function backlogPageState(query: ReposQueryLike, view: BacklogView): { readonly state: PageStateKind; readonly errorMessage: string } {
  const { data, status } = query
  if (data === undefined) return status === 'error' ? { state: 'error', errorMessage: backlogReposInvokeErrorCopy() } : { state: 'loading', errorMessage: '' }
  if (!data.ok) return { state: 'error', errorMessage: backlogReposReadErrorCopy(data.message) }
  return { state: view.body.kind === 'groups' ? 'ready' : 'empty', errorMessage: '' }
}
