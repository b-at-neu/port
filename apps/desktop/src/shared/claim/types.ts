// Renderer-safe contract for the claim dialog (the "work on #N" flow). No import here may reach a Node builtin — only `main/claim.ts` resolves a repository, spawns `gh`, or writes a label.
import type { BlockerRead, PipelineItemKind } from '../github/types'
import type { WriteOutcome } from '../writes/types'

/** IPC-validated at `main/ipc.ts` against this exact list — a literal union carries no runtime list of its own to check a request against. */
export const PLAN_GATE_CHOICES = ['review', 'auto'] as const
export type PlanGateChoice = (typeof PLAN_GATE_CHOICES)[number]

/** The flattened reading `classifyPreflight`/`buildClaimRequest` consume, built only once the item is known to exist. */
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

/** `others` is the assignee set the take-over branch would remove; `closed`/`blockers` are advisory, never refusals themselves. */
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

/** `'claim:preflight'`'s response. `unresolved` is the `not-found` verdict with nothing further to attach; `failed` is a fetch that could not complete at all. */
export type ClaimPreflightResponse =
  | { readonly kind: 'resolved'; readonly preflight: ClaimPreflight; readonly verdict: ClaimVerdict }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'failed'; readonly message: string }

/** `'claim:apply'`'s response. `moved` is the consent-binding refusal — a fresh read no longer matches, so nothing is written. `refused` covers a verdict that turned non-`claimable` between the review step and the write. */
export type ClaimApplyResponse =
  | { readonly kind: 'moved'; readonly confirmed: readonly string[]; readonly current: readonly string[]; readonly readAt: string }
  | { readonly kind: 'refused'; readonly verdict: Exclude<ClaimVerdict, { kind: 'claimable' }> }
  | { readonly kind: 'preflight-failed'; readonly message: string }
  | { readonly kind: 'write'; readonly outcome: WriteOutcome }
