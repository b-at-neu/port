// Renderer-safe contract for the Backlog screen's list. No import here may
// reach a Node builtin, so this file compiles under tsconfig.web.json too.
import type { PipelineFailureKind } from '../github/types'

// An open issue carrying no vocabulary label — genuinely unclaimed.
export interface BacklogItem {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly updatedAt: string
  readonly assignees: readonly string[]
}

// `total > scanned` renders as truncated, never as complete. `viewer: null`
// is a viewer-query error only, never folded into `ok: false`.
export type BacklogResponse =
  | { readonly ok: true; readonly items: readonly BacklogItem[]; readonly scanned: number; readonly total: number; readonly viewer: string | null; readonly fetchedAt: string }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string; readonly fetchedAt: string }
