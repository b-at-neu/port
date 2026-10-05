// Renderer-safe contract for the Backlog screen's list; no import here may reach a Node builtin.
import type { PipelineFailureKind } from '../github/types'

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
