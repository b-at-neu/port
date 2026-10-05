// Renderer-safe contract for the single-label operator actions (#94, #110):
// pause, resume, retry, stop, gate. No import here may reach a Node builtin —
// `apps/desktop/src/main/actions/` is the only place that calls
// `applyLabels`, but the renderer is this ticket's own consumer, the same
// rule `shared/writes/types.ts` and `shared/claim/types.ts` already state for
// themselves.
import type { LabelKey } from '../labels/vocabulary'
import type { LabelPrecondition, WriteOutcome } from '../writes/types'

/** The literal strings recorded verbatim as `AuditEntry.action` — the verb
 *  in the log and the verb in the UI can never drift, since nothing else
 *  names an operator action. `refresh` needs no comment and no operator
 *  choice, so it goes through this same single-label plan rather than
 *  `OperatorDecision` below. */
export const OPERATOR_ACTIONS = ['pause', 'resume', 'retry', 'stop', 'gate', 'refresh'] as const
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number]

/** The two actions that need a comment and, for unblock, an operator choice
 *  of route — `decide.ts`'s own sibling contract to `OperatorAction` above. */
export const OPERATOR_DECISIONS = ['unblock', 'revise'] as const
export type OperatorDecision = (typeof OPERATOR_DECISIONS)[number]

/** Unblock's own fork — which trigger the cleared item goes back to. */
export const UNBLOCK_ROUTES = ['revision', 'review'] as const
export type UnblockRoute = (typeof UNBLOCK_ROUTES)[number]

/** The `LabelWriteRequest` key-level shape minus `repoId`/`repo`/`kind`/
 *  `number`/`vocabulary` — the main side supplies those from the registry
 *  entry and the request itself, never from a plan a caller could forge. */
export interface ActionPlan {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly addAssignees: readonly string[]
  readonly removeAssignees: readonly string[]
  readonly expect: LabelPrecondition
  /** The operator-facing verb, forwarded to `LabelWriteRequest.action`
   *  unchanged. */
  readonly action: string
}

/** Why an action is unavailable for this item — `not-applicable` covers
 *  every role/marker mismatch (the ordinary "this button doesn't apply
 *  here" case), `not-owned` and `viewer-unknown` are the two ownership
 *  refusals `actionsFor` applies ahead of every plan. */
export type ActionRefusal = 'not-applicable' | 'not-owned' | 'viewer-unknown'

export type ActionAvailability = { readonly available: true; readonly plan: ActionPlan } | { readonly available: false; readonly reason: ActionRefusal }

/** `'item:action'`'s response. `ok: true` forwards `main/writes/`'s own
 *  `WriteOutcome` unchanged — `applied`/`no-op`/`precondition-failed`/etc
 *  render by name, exhaustively, on the renderer side, the same rule
 *  `ClaimApplyResponse.write` already follows. Every `ok: false` arm is a
 *  refusal `applyItemAction`/`recoverPausedTrigger` reach *before*
 *  `applyLabels` is ever called — `moved` is the renderer's own stale view
 *  (the row was drawn against an earlier stage), never the write-time race
 *  `applyLabels`'s own `precondition-failed` outcome already covers. */
export type ItemActionResult =
  | { readonly ok: true; readonly outcome: WriteOutcome }
  | { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string }
  | { readonly ok: false; readonly reason: 'not-owned'; readonly owners: readonly string[] }
  | { readonly ok: false; readonly reason: 'viewer-unknown' }
  | { readonly ok: false; readonly reason: 'repo-unavailable' }
  | { readonly ok: false; readonly reason: 'no-pause-record' }
  | { readonly ok: false; readonly reason: 'pause-record-unresolvable' }

/** `cycle-cap` (revise would only escalate straight back) and
 *  `rebase-decisions` (an open rebase escalation this app can't record). */
export type DecisionRefusal = ActionRefusal | 'cycle-cap' | 'rebase-decisions'

/** The escalation reason found (`null` when none), plus the review-cycle
 *  count, so the dialog can show the cap warning before a route is picked. */
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

/** The same shape family as `ItemActionResult`, with `comment`/`labels`
 *  replacing the single `outcome` since a decision writes both. */
export type ItemDecisionResult =
  | { readonly ok: true; readonly comment: WriteOutcome | null; readonly labels: WriteOutcome }
  | { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string }
  | { readonly ok: false; readonly reason: 'not-owned'; readonly owners: readonly string[] }
  | { readonly ok: false; readonly reason: 'viewer-unknown' }
  | { readonly ok: false; readonly reason: 'repo-unavailable' }
  | { readonly ok: false; readonly reason: 'refused'; readonly refusal: DecisionRefusal | 'note-invalid'; readonly problem?: string }
  | { readonly ok: false; readonly reason: 'verify-failed'; readonly message: string }
  | { readonly ok: false; readonly reason: 'comment-failed'; readonly comment: WriteOutcome }

/** The operator's own request text ceiling — `reviseNoteProblem` refuses
 *  anything longer, before a single byte reaches `gh`. */
export const MAX_REVISE_NOTE_CHARS = 10_000
