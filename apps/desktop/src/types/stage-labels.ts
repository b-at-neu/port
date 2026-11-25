// Renderer-safe shapes for the state writes the app makes on a stage session's behalf: claim, rollback, hand-back and the next turn after a block.
import type { PipelineItemKind } from '@/types/github'
import type { SessionKey } from '@/types/hosting'
import type { StageHandback, StageOutcome, StageOutcomeKind } from '@/types/stage-session'
import type { HandoffRefusal, StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { InterruptedReason, Run, RunDenial, Stage, Ticket } from '@/utils/pipeline/ticket'

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

/** One change to a run the table applies to the ticket that holds it; none of them writes a history row. */
export type RunChange =
  | { readonly kind: 'session'; readonly claudeSessionId: string }
  | { readonly kind: 'joined'; readonly at: string }
  | { readonly kind: 'handback'; readonly outcome: StageOutcome }
  | { readonly kind: 'ended'; readonly outcome: StageOutcome | null }
  | { readonly kind: 'interrupted'; readonly reason: InterruptedReason; readonly detail: string | null; readonly resetsAt: string | null; readonly costUsd: number | null; readonly outcome: StageOutcome | null }
  | { readonly kind: 'resumed'; readonly sessionKey: SessionKey }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'denied'; readonly denial: RunDenial }
  | { readonly kind: 'denial-dismissed'; readonly id: string }
  | { readonly kind: 'denials-cleared'; readonly rule: string }

/** A change to one of a ticket's runs. It writes no history row and never moves the ticket. */
export type RunEvent = { readonly kind: 'run-start'; readonly run: Run } | { readonly kind: 'run'; readonly runId: string; readonly change: RunChange }

/** One typed change to a ticket's own state; the transition table turns it into a new ticket and a history row. */
export type StateEvent =
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

export type TicketEvent = StateEvent | RunEvent

export type TableResult = { readonly ok: true; readonly ticket: Ticket; readonly changed: boolean } | { readonly ok: false; readonly reason: 'moved' | 'unknown-handback' }

/** What a stage write came to. `retryable` is true only for a failure a later attempt can plausibly clear. */
export type StageLabelResult = { readonly kind: 'applied' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal; readonly detail: string | null }

export type StageTransitionResult = { readonly kind: 'applied' } | { readonly kind: 'refused'; readonly reason: HandoffRefusal; readonly retryable: boolean; readonly detail: string | null }
