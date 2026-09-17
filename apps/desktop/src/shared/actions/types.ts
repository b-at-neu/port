// Renderer-safe contract for the four single-label operator actions (#94):
// pause, resume, retry, gate. No import here may reach a Node builtin —
// `apps/desktop/src/main/actions/` is the only place that calls
// `applyLabels`, but the renderer is this ticket's own consumer, the same
// rule `shared/writes/types.ts` and `shared/claim/types.ts` already state for
// themselves.
import type { LabelKey } from '../labels/vocabulary'
import type { LabelPrecondition, WriteOutcome } from '../writes/types'

/** The literal strings recorded verbatim as `AuditEntry.action` — the verb
 *  in the log and the verb in the UI can never drift, since nothing else
 *  names an operator action. */
export const OPERATOR_ACTIONS = ['pause', 'resume', 'retry', 'gate'] as const
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number]

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
