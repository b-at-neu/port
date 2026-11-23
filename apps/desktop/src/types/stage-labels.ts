// Renderer-safe shapes for the label writes the app makes on a stage session's behalf: claim, rollback, hand-back and the next turn after a block.
import type { PipelineItemKind } from '@/types/github'
import type { StageHandback, StageOutcomeKind } from '@/types/stage-session'
import type { HandoffRefusal, StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'

/** `revise` split by its trigger: a refresh runs the same agent against a different set of labels and tokens. */
export type StageMode = StageAgent | 'refresh'

/** The plan file a completed `plan-written` hand-back left behind, read before the worktree was removed. */
export type StagePlanFile = { readonly kind: 'read'; readonly body: string } | { readonly kind: 'missing'; readonly detail: string | null } | { readonly kind: 'empty' }

export type StageEvent =
  | { readonly kind: 'claim' }
  | { readonly kind: 'rollback' }
  | { readonly kind: 'resumed-turn' }
  /** A hand-back the finished work already implies, read from GitHub rather than from a session. */
  | { readonly kind: 'adopt'; readonly handback: StageHandback }
  /** `plan` is `null` for every outcome except a completed `plan-written`. */
  | { readonly kind: 'outcome'; readonly outcome: StageOutcomeKind; readonly handback: StageHandback | null; readonly plan: StagePlanFile | null }

/** One label write the table plans. `numberFrom: 'arg'` names the pull request a `pr-opened` hand-back carries. */
export interface StagePlannedWrite {
  readonly itemKind: PipelineItemKind
  readonly numberFrom: 'item' | 'arg'
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly action: string
}

export type StageTransition = { readonly kind: 'write'; readonly writes: readonly StagePlannedWrite[] } | { readonly kind: 'none' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal }

/** What a stage label write came to. `retryable` is true only for a failure a later attempt can plausibly clear. */
export type StageLabelResult = { readonly kind: 'applied' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal; readonly detail: string | null }

export type StageTransitionResult = { readonly kind: 'applied' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal; readonly retryable: boolean; readonly detail: string | null }
