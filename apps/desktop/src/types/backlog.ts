// Renderer-safe contract for the Backlog screen's list; no import here may reach a Node builtin.
import type { PipelineFailureKind } from '@/types/github'
import type { RepoId } from '@/utils/repos'

// An open issue carrying no vocabulary label — genuinely unclaimed.
export interface BacklogItem {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly updatedAt: string
  readonly assignees: readonly string[]
}

// `total > scanned` renders as truncated; `viewer: null` is a viewer-query error only.
export type BacklogResponse =
  | { readonly ok: true; readonly items: readonly BacklogItem[]; readonly scanned: number; readonly total: number; readonly viewer: string | null; readonly fetchedAt: string }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string; readonly fetchedAt: string }

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
