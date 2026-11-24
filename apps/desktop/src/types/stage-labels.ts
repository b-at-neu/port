// Renderer-safe shapes for the state writes the app makes on a stage session's behalf: claim, rollback, hand-back and the next turn after a block.
import type { PipelineItemKind } from '@/types/github'
import type { StageHandback, StageOutcomeKind } from '@/types/stage-session'
import type { HandoffRefusal, StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { Stage, Ticket } from '@/utils/pipeline/ticket'

/** `revise` split by its trigger: a refresh runs the same agent against a different set of labels and tokens. */
export type StageMode = StageAgent | 'refresh'

/** The ticket stage a mode works on. */
export function stageOfMode(mode: StageMode): Stage {
  return mode === 'impl' ? 'implement' : mode
}

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

/** One typed change to a ticket; the transition table is the only thing that turns it into a new ticket. */
export type TicketEvent =
  | { readonly kind: 'claim'; readonly stage: Stage }
  | { readonly kind: 'rollback'; readonly stage: Stage }
  | { readonly kind: 'error-reset'; readonly stage: Stage }
  | { readonly kind: 'blocked'; readonly stage: 'implement' }
  | { readonly kind: 'resumed-turn'; readonly stage: 'implement' }
  | { readonly kind: 'handback'; readonly stage: Stage; readonly token: string; readonly arg: string | null; readonly pr: number | null; readonly via: 'session' | 'adopt' }
  | { readonly kind: 'merged' }
  /** A label add/remove request an operator path still sends; the table re-derives the ticket from the keys. */
  | {
      readonly kind: 'labels'
      readonly itemKind: PipelineItemKind
      readonly add: readonly LabelKey[]
      readonly remove: readonly LabelKey[]
      readonly expect: { readonly present: readonly LabelKey[]; readonly absent: readonly LabelKey[] }
      readonly action: string
      /** The ticket a new pull request belongs to, when its branch names one. */
      readonly issue: number | null
    }

export type TableResult = { readonly ok: true; readonly ticket: Ticket; readonly changed: boolean } | { readonly ok: false; readonly reason: 'moved' | 'unknown-handback' }

/** What a stage write came to. `retryable` is true only for a failure a later attempt can plausibly clear. */
export type StageLabelResult = { readonly kind: 'applied' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal; readonly detail: string | null }

export type StageTransitionResult = { readonly kind: 'applied' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal; readonly retryable: boolean; readonly detail: string | null }
