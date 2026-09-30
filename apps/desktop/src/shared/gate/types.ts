// Renderer-safe contract for the plan gate dialog (#92, "the gate you hit
// most"). No import here may reach a Node builtin — `apps/desktop/src/main/
// actions/gate.ts` is the only place that resolves a repository, spawns
// `gh`, or writes a claim file, but the renderer is this ticket's own
// consumer, the same rule `shared/claim/types.ts` and `shared/actions/
// types.ts` already state for themselves.
import type { ClaimRead, ClaimWriteResult, WriteOutcome } from '../writes/types'

/** The two decisions the dialog's Reviewing step offers — validated at
 *  `main/channels/gate.ts` against this exact list, the same reason
 *  `shared/claim/types.ts` keeps `PLAN_GATE_CHOICES` beside `PlanGateChoice`. */
export const GATE_DECISIONS = ['approve', 'request-changes'] as const
export type GateDecision = (typeof GATE_DECISIONS)[number]

/** Recorded verbatim as `AuditEntry.action` — the verb in the log and the
 *  verb in the UI can never drift. */
export const GATE_ACTIONS = ['approve-plan', 'request-plan-changes'] as const
export type GateAction = (typeof GATE_ACTIONS)[number]

/** `docs/COORDINATION.md`'s own stand-down copy names this owner; pinned by
 *  `scripts/checks/desktop-gate.ts` against that file. */
export const GATE_CLAIM_OWNER = 'port-desktop'

/** The preflight `main/actions/gate.ts` composes: the item's own identity
 *  and labels, the ticket body split at `IMPLEMENTATION_PLAN_HEADING`, the
 *  session-required reason (never re-derived by this dialog — `main/state/
 *  link.ts`'s own slot detector is the one source), and whether the issue
 *  opted into `auto plan`. */
export interface GatePreflight {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly viewer: string
  /** The body above `## Implementation Plan` — rendered when there is no
   *  plan block at all, so the dialog never shows a blank review step. */
  readonly ticketMarkdown: string
  /** The plan block, heading included — `null` when the issue's body never
   *  carried `## Implementation Plan` at all. */
  readonly planMarkdown: string | null
  readonly sessionRequired: boolean
  readonly sessionRequiredReason: string | null
  readonly autoPlan: boolean
  readonly readAt: string
}

/** `classifyGate`'s verdict. `not-at-plan-review` carries the labels
 *  actually observed, so the refusal names what changed rather than a bare
 *  "no longer answerable". `assignedElsewhere` is advisory only — the claim
 *  is the authorization here (plan's own **Data & contracts**), never a
 *  second refusal. */
export type GateVerdict =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-an-issue' }
  | { readonly kind: 'not-at-plan-review'; readonly observed: readonly string[] }
  | { readonly kind: 'answerable'; readonly noPlanBlock: boolean; readonly assignedElsewhere: readonly string[] }

/** `'gate:preflight'`'s response — `claim` rides along on every arm, since
 *  the Claim step renders regardless of whether the item itself resolved. */
export type GatePreflightResponse =
  | { readonly kind: 'resolved'; readonly preflight: GatePreflight; readonly verdict: GateVerdict; readonly claim: ClaimRead }
  | { readonly kind: 'unresolved'; readonly claim: ClaimRead }
  | { readonly kind: 'failed'; readonly message: string; readonly claim: ClaimRead }

/** `'gate:answer'`'s response. `refused` covers a verdict that turned
 *  non-`answerable` between the review step and the answer. `comment-failed`
 *  is the one new failure mode this ticket's ordering introduces — a feedback
 *  comment that could not post aborts before any label is ever touched.
 *  `answered` forwards `main/writes/`'s own `WriteOutcome` for the label
 *  swap unchanged; `comment` is `null` on an `approve` decision, which never
 *  posts one. */
export type GateAnswerResponse =
  | { readonly kind: 'refused'; readonly verdict: Exclude<GateVerdict, { kind: 'answerable' }> }
  | { readonly kind: 'preflight-failed'; readonly message: string }
  | { readonly kind: 'comment-failed'; readonly comment: WriteOutcome }
  | { readonly kind: 'answered'; readonly comment: WriteOutcome | null; readonly labels: WriteOutcome }

/** `'gate:claim:set'`'s response — `takeGateClaim`/`releaseGateClaim` re-read
 *  after writing, so the response always carries the state as it now is
 *  rather than as it was asked to be. */
export type GateClaimResponse = { readonly kind: 'ok'; readonly claim: ClaimRead } | { readonly kind: 'failed'; readonly result: ClaimWriteResult }
