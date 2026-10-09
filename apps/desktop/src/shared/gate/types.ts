// Renderer-safe contract for the plan gate dialog. No import here may reach a Node builtin — only `main/actions/gate.ts` resolves a repository, spawns `gh`, or reads `.agents/cockpit.json`.
import type { OwnershipSummary, WriteOutcome } from '../writes/types'

/** The two decisions the dialog's Reviewing step offers — validated at `main/channels/gate.ts` against this exact list. */
export const GATE_DECISIONS = ['approve', 'request-changes'] as const
export type GateDecision = (typeof GATE_DECISIONS)[number]

/** Recorded verbatim as `AuditEntry.action`. `auto-approve-plan` is never a dialog decision — it is the auto-plan snapshot consumer's own, so the audit log can tell an automatic approval from a click. */
export const GATE_ACTIONS = ['approve-plan', 'request-plan-changes', 'auto-approve-plan'] as const
export type GateAction = (typeof GATE_ACTIONS)[number]

/** The preflight `main/actions/gate.ts` composes: the item's identity and labels, the ticket body split at `IMPLEMENTATION_PLAN_HEADING`, the session-required reason, and whether the issue opted into `auto plan`. */
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

/** `classifyGate`'s verdict. `not-at-plan-review` carries the labels actually observed. `assignedElsewhere` is advisory only, never a second refusal. */
export type GateVerdict =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-an-issue' }
  | { readonly kind: 'not-at-plan-review'; readonly observed: readonly string[] }
  | { readonly kind: 'answerable'; readonly noPlanBlock: boolean; readonly assignedElsewhere: readonly string[] }

/** `'gate:preflight'`'s response — `ownership` rides along on every arm, since the dialog disables its actions under `terminal`/`unreadable` regardless of whether the item resolved. */
export type GatePreflightResponse =
  | { readonly kind: 'resolved'; readonly preflight: GatePreflight; readonly verdict: GateVerdict; readonly ownership: OwnershipSummary }
  | { readonly kind: 'unresolved'; readonly ownership: OwnershipSummary }
  | { readonly kind: 'failed'; readonly message: string; readonly ownership: OwnershipSummary }

/** `'gate:answer'`'s response. `comment-failed` means a feedback comment could not post, aborting before any label is touched; `comment` is `null` on `approve`, which never posts one. */
export type GateAnswerResponse =
  | { readonly kind: 'refused'; readonly verdict: Exclude<GateVerdict, { kind: 'answerable' }> }
  | { readonly kind: 'preflight-failed'; readonly message: string }
  | { readonly kind: 'comment-failed'; readonly comment: WriteOutcome }
  | { readonly kind: 'answered'; readonly comment: WriteOutcome | null; readonly labels: WriteOutcome }
