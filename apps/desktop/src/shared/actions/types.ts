// Renderer-safe contract for the single-label operator actions: pause, resume, retry, stop, gate. No import here may reach a Node builtin.
import type { LabelKey } from '../labels/vocabulary'
import type { LabelPrecondition, WriteOutcome } from '../writes/types'

/** Recorded verbatim as `AuditEntry.action`; `refresh` needs no comment or operator choice, so it stays out of `OperatorDecision` below. */
export const OPERATOR_ACTIONS = ['pause', 'resume', 'retry', 'stop', 'gate', 'refresh'] as const
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number]

/** The two actions that need a comment and, for unblock, an operator choice of route. */
export const OPERATOR_DECISIONS = ['unblock', 'revise'] as const
export type OperatorDecision = (typeof OPERATOR_DECISIONS)[number]

/** Unblock's own fork — which trigger the cleared item goes back to. */
export const UNBLOCK_ROUTES = ['revision', 'review'] as const
export type UnblockRoute = (typeof UNBLOCK_ROUTES)[number]

/** The `LabelWriteRequest` key-level shape; the main side supplies the rest from the registry entry, never from a plan a caller could forge. */
export interface ActionPlan {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly addAssignees: readonly string[]
  readonly removeAssignees: readonly string[]
  readonly expect: LabelPrecondition
  /** Forwarded to `LabelWriteRequest.action` unchanged. */
  readonly action: string
}

/** Why an action is unavailable: `not-applicable` is a role/marker mismatch; `not-owned` and `viewer-unknown` are ownership refusals applied ahead of every plan. */
export type ActionRefusal = 'not-applicable' | 'not-owned' | 'viewer-unknown'

export type ActionAvailability = { readonly available: true; readonly plan: ActionPlan } | { readonly available: false; readonly reason: ActionRefusal }

/** `'item:action'`'s response. Every `ok: false` arm is a refusal reached before `applyLabels` is called; `moved` is a stale renderer view, not the write-time race `precondition-failed` covers. */
export type ItemActionResult =
  | { readonly ok: true; readonly outcome: WriteOutcome }
  | { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string }
  | { readonly ok: false; readonly reason: 'not-owned'; readonly owners: readonly string[] }
  | { readonly ok: false; readonly reason: 'viewer-unknown' }
  | { readonly ok: false; readonly reason: 'repo-unavailable' }
  | { readonly ok: false; readonly reason: 'no-pause-record' }
  | { readonly ok: false; readonly reason: 'pause-record-unresolvable' }

/** `cycle-cap`: revise would only escalate straight back. `rebase-decisions`: an open rebase escalation this app can't record. */
export type DecisionRefusal = ActionRefusal | 'cycle-cap' | 'rebase-decisions'

/** `null` when no escalation reason was found; the dialog shows the cap warning before a route is picked. */
export interface UnblockContext {
  readonly reason: string | null
  readonly cyclesUsed: number
  readonly cap: number
}

export interface ReviseContext {
  readonly headRefOid: string
  readonly cyclesUsed: number
  readonly cap: number
}

export type DecisionAvailability =
  | { readonly available: true; readonly context: UnblockContext | ReviseContext }
  | { readonly available: false; readonly reason: DecisionRefusal }

/** Same shape family as `ItemActionResult`, with `comment`/`labels` replacing `outcome` since a decision writes both. */
export type ItemDecisionResult =
  | { readonly ok: true; readonly comment: WriteOutcome | null; readonly labels: WriteOutcome }
  | { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string }
  | { readonly ok: false; readonly reason: 'not-owned'; readonly owners: readonly string[] }
  | { readonly ok: false; readonly reason: 'viewer-unknown' }
  | { readonly ok: false; readonly reason: 'repo-unavailable' }
  | { readonly ok: false; readonly reason: 'refused'; readonly refusal: DecisionRefusal | 'note-invalid'; readonly problem?: string }
  | { readonly ok: false; readonly reason: 'verify-failed'; readonly message: string }
  | { readonly ok: false; readonly reason: 'comment-failed'; readonly comment: WriteOutcome }

/** `reviseNoteProblem` refuses anything longer, before a single byte reaches `gh`. */
export const MAX_REVISE_NOTE_CHARS = 10_000
