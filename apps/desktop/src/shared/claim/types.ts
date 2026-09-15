// Renderer-safe contract for the claim dialog (#93, the "work on #N" flow).
// No import here may reach a Node builtin — `apps/desktop/src/main/claim.ts`
// is the only place that resolves a repository, spawns `gh`, or writes a
// label, but the renderer is this ticket's consumer, so this file compiles
// under `tsconfig.web.json` too, the same rule `shared/writes/types.ts`
// states for itself.
import type { BlockerRead, PipelineItemKind } from '../github/types'
import type { WriteOutcome } from '../writes/types'

/** IPC-validated at `main/ipc.ts` against this exact list — a bare string
 *  literal union carries no runtime list of its own to check a request
 *  against, the same reason `shared/labels/vocabulary.ts` keeps `LABEL_KEYS`
 *  beside `LabelKey`. */
export const PLAN_GATE_CHOICES = ['review', 'auto'] as const
export type PlanGateChoice = (typeof PLAN_GATE_CHOICES)[number]

/** The flattened reading `classifyPreflight`/`buildClaimRequest` consume —
 *  one item's fields plus the viewer's own login and when it was all read,
 *  built by `main/claim.ts` from `ClaimPreflightFetch`'s `item`/`viewer`/
 *  `fetchedAt` only once the item is known to exist. */
export interface ClaimPreflight {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly viewer: string
  readonly blockers: BlockerRead
  readonly readAt: string
}

/** `classifyPreflight`'s verdict — a refusal carries only what its own copy
 *  needs, `claimable` carries what the review step and `buildClaimRequest`
 *  both need. `others` is the assignee set the take-over branch would
 *  remove; `closed`/`blockers` are advisory, never refusals themselves. */
export type ClaimVerdict =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-an-issue' }
  | { readonly kind: 'already-claimed'; readonly markerName: string }
  | {
      readonly kind: 'claimable'
      readonly assigneeSituation: 'unassigned' | 'mine' | 'others'
      readonly others: readonly string[]
      readonly closed: boolean
      readonly blockers: BlockerRead
    }

/** `'claim:preflight'`'s response. `unresolved` is the `not-found` verdict
 *  with nothing further to attach — the renderer already has the repo and
 *  number it asked about, so no `ClaimPreflight` is needed to say "#N
 *  doesn't exist". `failed` is a fetch that could not complete at all
 *  (network, auth, an unresolvable viewer login). */
export type ClaimPreflightResponse =
  | { readonly kind: 'resolved'; readonly preflight: ClaimPreflight; readonly verdict: ClaimVerdict }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'failed'; readonly message: string }

/** `'claim:apply'`'s response. `moved` is the consent-binding refusal —
 *  `confirmedAssignees` no longer matches a fresh read, so nothing is
 *  written. `refused` covers a verdict that turned non-`claimable` between
 *  the review step and the write (the item vanished, became a pull request,
 *  or picked up the marker label from elsewhere). `write` forwards
 *  `main/writes/`'s own outcome unchanged — `applied`/`no-op`/
 *  `precondition-failed`/etc render by name, exhaustively, on the renderer
 *  side. */
export type ClaimApplyResponse =
  | { readonly kind: 'moved'; readonly confirmed: readonly string[]; readonly current: readonly string[]; readonly readAt: string }
  | { readonly kind: 'refused'; readonly verdict: Exclude<ClaimVerdict, { kind: 'claimable' }> }
  | { readonly kind: 'preflight-failed'; readonly message: string }
  | { readonly kind: 'write'; readonly outcome: WriteOutcome }
