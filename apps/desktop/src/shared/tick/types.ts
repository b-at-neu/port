// Renderer-safe shapes for the tick engine — what one repository's tick would dispatch, what it holds back and why, and what each in-flight claim resolves to. No import here may reach a Node builtin — only `main/tick/` computes these.
import type { PipelineItemKind } from '../github/types'
import type { LabelKey } from '../labels/vocabulary'
import type { RepoId } from '../repos'

/** A bare four-way key, never the session index's hyphenated `PortStageAgent` — this one names *what to dispatch next*, matching `models.<key>`, not *what already ran*. */
export type StageAgent = 'plan' | 'impl' | 'review' | 'revise'

/** Why a trigger-stage item is held rather than actionable — first hit wins: `unowned` before `other-operator` before `session-required` before `contended`. `cycle-cap`/`zero-diff` are checked per-item after that ladder; this app computes the decision and the report, never the write. */
export type TickHeldReason =
  | 'unowned'
  | 'other-operator'
  | 'session-required'
  | 'contended'
  | 'cycle-cap'
  | 'zero-diff'
  | 'refresh-wins'
  | 'conflicting'
  | 'mergeability-unknown'

/** `TickHeld.escalation`'s own shape — `null` for every reason except `cycle-cap`/`zero-diff`, which carry the count and cap without re-deriving either from raw review data. */
export type TickEscalation = { readonly kind: 'cycle-cap'; readonly count: number; readonly cap: number } | { readonly kind: 'zero-diff' }

/** The file-contention gate's own held detail — populated only for `reason: 'contended'`, `null` for the other reasons. */
export interface TickContention {
  readonly blocker: number
  readonly blockerStage: string
  readonly depth: number
  readonly paths: readonly string[]
}

export interface TickActionable {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly agent: StageAgent
  /** `true` when this candidate's plan carried no ` ```files ` fence at all — it dispatches unchecked rather than held, since holding every pre-contract plan would stall the pipeline harder than the collision the gate prevents. */
  readonly unchecked: boolean
  /** The current review cycle count and cap, populated only for a `revise`/`review` candidate, so a pull request approaching the cap is visible on hover before it ever holds. */
  readonly cycle: { readonly count: number; readonly cap: number } | null
}

export interface TickHeld {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly reason: TickHeldReason
  readonly contention: TickContention | null
  /** Populated only for `reason: 'cycle-cap'` / `'zero-diff'`, `null` for every other reason. */
  readonly escalation: TickEscalation | null
}

/** An in-flight claim's resolution. `session-required` never reaches `classifyUnmatched` — an operator's own interactive session has no `TaskList` entry, so it must never read as a stall. `matched` is this app's analogue of a live `TaskList` hit. `reset` is renamed `stalled-confirmed` here, since this app resets nothing. */
export type TickClaimClass = 'session-required' | 'matched' | 'no-record' | 'suspect' | 'stalled-confirmed' | 'capped'

export interface TickClaim {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly inFlight: LabelKey
  readonly class: TickClaimClass
  /** `RETRY_TRIGGER`'s own target for this claim's in-flight key — set only for `stalled-confirmed`, so a retry is never offered on a class the operator cannot yet act on. */
  readonly retryKey: LabelKey | null
}

/** Why a repository's tick could not decide anything this pass. A blind repository reports **no** actionable/held/claims counts, since an empty array would be indistinguishable from a genuinely quiet repository. */
export type TickBlind =
  | { readonly reason: 'not-ready' }
  | { readonly reason: 'github-unavailable'; readonly message: string }
  | { readonly reason: 'viewer-unknown' }
  | { readonly reason: 'stale-read'; readonly ageMs: number }

/** The machine-observation write families this app ports from the cockpit's cadence, plus one report-only kind (`refresh-deferred`) that authorises no write of its own. `observe.ts`'s `observationsOf` is the only producer. */
export type TickObservationKind = 'liveness-reset' | 'cycle-cap' | 'zero-diff' | 'refresh' | 'refresh-stuck' | 'refresh-deferred' | 'withdraw-approval'

interface TickObservationBase {
  readonly number: number
  readonly itemKind: PipelineItemKind
}

export type TickObservation =
  | (TickObservationBase & { readonly kind: 'liveness-reset'; readonly inFlight: LabelKey; readonly retryKey: LabelKey })
  | (TickObservationBase & { readonly kind: 'cycle-cap'; readonly count: number; readonly cap: number })
  | (TickObservationBase & { readonly kind: 'zero-diff'; readonly count: number; readonly headRefOid: string })
  | (TickObservationBase & { readonly kind: 'refresh'; readonly sourceLabel: LabelKey; readonly headRefOid: string; readonly count: number })
  | (TickObservationBase & {
      readonly kind: 'refresh-stuck'
      readonly sourceLabel: LabelKey
      readonly reason: 'same-sha' | 'consecutive-cap'
      readonly sha: string
      readonly count: number
    })
  | (TickObservationBase & { readonly kind: 'refresh-deferred' })
  | (TickObservationBase & {
      readonly kind: 'withdraw-approval'
      readonly red: readonly { readonly name: string | null; readonly conclusion: string | null; readonly url: string | null }[]
      readonly headRefOid: string
    })

/** One `autoPlan` issue at `planReview` alone, assigned to the viewer — the app's own auto-plan swap acts on this set while it owns the repository. */
export interface TickAutoApproval {
  readonly number: number
}

/** One repository's own tick — `planTick`'s whole result. `disabledStages` is always `[]` on a blind repository. */
export interface TickReport {
  readonly repoId: RepoId
  readonly displayName: string
  readonly blind: TickBlind | null
  readonly actionable: readonly TickActionable[]
  readonly held: readonly TickHeld[]
  readonly claims: readonly TickClaim[]
  /** Every `autoPlan` issue at `planReview` alone, assigned to the viewer — `[]` on a blind report. `main/tick/dispatchable.ts`'s `autoApprovableFrom` is the only reader under `main/`. */
  readonly autoApprovals: readonly TickAutoApproval[]
  /** Every module-gated stage key this repository's config currently turns off — a gated stage is absent from the UI, never a stage rendered at zero. */
  readonly disabledStages: readonly LabelKey[]
  /** This repository's own GitHub source's next-due instant — `null` on a blind report: a repository this tick could not decide anything for has no decision instant to report either. */
  readonly nextTickAt: string | null
  /** The machine-observation writes the app would make (or has made) this pass, under the `dispatch` claim — always `[]` on a blind report. */
  readonly observations: readonly TickObservation[]
}
