// Renderer-safe contract for the Backlog screen's list; no import here may reach a Node builtin.
import type { BlockerRead, ClaimBlocker, PipelineFailureKind } from '@/types/github'
import type { RepoId } from '@/utils/repos'

// `color` is GitHub's own six-digit lowercase hex without the `#`, or `null` when missing or malformed.
export interface BacklogLabel {
  readonly name: string
  readonly color: string | null
}

// An open issue carrying no vocabulary label — genuinely unclaimed.
export interface BacklogItem {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly updatedAt: string
  readonly assignees: readonly string[]
  readonly labels: readonly BacklogLabel[]
  readonly subIssueCount: number
  readonly blockers: BlockerRead
}

// `exclude` wins over `include`; a non-empty `include` keeps an item carrying any one of its names.
export interface BacklogLabelFilter {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

export interface LabelOption {
  readonly label: BacklogLabel
  readonly count: number
  readonly state: 'any' | 'only' | 'hidden'
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
  readonly labels: readonly BacklogLabel[]
  readonly subIssueCount: number
  readonly blockers: BlockerRead
}

// What Work on must confirm before claiming; `truncation` is set when the blocker page held fewer than exist.
export interface WorkOnReasons {
  readonly blockers: readonly ClaimBlocker[]
  readonly truncation: { readonly shown: number; readonly total: number } | null
  readonly subIssueCount: number
}

export type BacklogGroupView =
  | { readonly kind: 'loading'; readonly repoId: RepoId; readonly repo: string }
  | { readonly kind: 'invoke-error'; readonly repoId: RepoId; readonly repo: string; readonly message: string }
  | { readonly kind: 'read-error'; readonly repoId: RepoId; readonly repo: string; readonly message: string }
  | {
      readonly kind: 'loaded'
      readonly repoId: RepoId
      readonly repo: string
      readonly items: readonly BacklogRowView[]
      readonly totalCount: number
      readonly labelOptions: readonly LabelOption[]
      readonly truncatedNote: string | null
    }

// `status` stays `'success'` on a refetch over previously-good data, so `isError`/`dataUpdatedAt` carry that fact separately.
export interface BacklogQueryLike {
  readonly status: 'pending' | 'error' | 'success'
  readonly data: BacklogResponse | undefined
  readonly isError: boolean
  readonly dataUpdatedAt: number
}
