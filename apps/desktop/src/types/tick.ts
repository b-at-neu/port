// Renderer-safe shapes for the tick engine — what one repository's tick would dispatch, what it holds back and why, and what each in-flight claim resolves to. No import here may reach a Node builtin — only `main/pipeline/tick/` computes these.
import type { PipelineItemKind } from '@/types/github'
import type { MirrorFailure } from '@/types/pipeline-state'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { StageHandback, StageOutcomeKind } from '@/types/stage-session'
import type { StageLabelResult } from '@/types/stage-labels'
import type { RefreshMemoEntry } from '@/utils/pipeline/gates'
import type { Stage } from '@/utils/pipeline/ticket'
import type { TicketView } from '@/utils/pipeline/stages'

/** A bare four-way key, never the session index's hyphenated `PortStageAgent` — this one names *what to dispatch next*, matching `models.<key>`, not *what already ran*. */
export type StageAgent = 'plan' | 'impl' | 'review' | 'revise'

/** Why the app's own label write for a stage session was refused or never made — reported on Needs you, never guessed past. */
export type HandoffRefusal = 'moved' | 'no-handback' | 'unknown-handback' | 'pr-unverified' | 'write-failed' | 'unresolvable-label' | 'no-plan-file' | 'empty-plan-file'

/** One stage session this app's own launcher recorded as ended, projected from `DispatchRecord`s that are not `started` and carry a non-`null` outcome — `main/pipeline/tick/repair.ts`'s own session-shape evidence, newest per number. */
export interface EndedStage {
  readonly agent: StageAgent
  readonly number: number
  readonly outcome: StageOutcomeKind
  readonly at: string
  /** How the app's own hand-back write went — `null` while pending or when this outcome writes nothing. */
  readonly labels: StageLabelResult | null
}

/** Why a trigger-stage item is held rather than actionable — first hit wins: `unowned` before `other-operator` before `session-required` before `contended`. `cycle-cap`/`zero-diff`/`check-hold`/`integration-red` are checked per-item after that ladder, and `integration-green` marks a pull request the integration-red hold hands to a refresh; this app computes the decision and the report, never the write. */
export type TickHeldReason =
  | 'unowned'
  | 'other-operator'
  | 'session-required'
  | 'contended'
  | 'cycle-cap'
  | 'zero-diff'
  | 'check-hold'
  | 'integration-red'
  | 'integration-green'
  | 'conflicting'
  | 'mergeability-unknown'

/** `TickHeld.escalation`'s own shape — `null` for every reason except `cycle-cap`/`zero-diff`/`check-hold`/`integration-red`, which carry the count and cap, or the held checks and their deadline, without re-deriving either from raw review data. */
export type TickEscalation =
  | { readonly kind: 'cycle-cap'; readonly count: number; readonly cap: number }
  | { readonly kind: 'zero-diff' }
  | { readonly kind: 'check-hold'; readonly checks: readonly string[]; readonly state: 'pending' | 'red'; readonly escalateAt: string | null }
  /** `expired` is the hold window running out, which is what `observe.ts` escalates; until then it is a plain hold with `escalateAt` as its deadline. */
  | { readonly kind: 'integration-red'; readonly checks: readonly string[]; readonly state: 'red' | 'unreadable'; readonly escalateAt: string | null; readonly expired: boolean }

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
  /** The ticket stage this candidate runs. */
  readonly stage: Stage
  /** Run provenance only — no decision reads it. */
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
  readonly stage: Stage
  /** Run provenance only — no decision reads it. */
  readonly trigger: LabelKey
  readonly reason: TickHeldReason
  readonly contention: TickContention | null
  /** Populated only for `reason: 'cycle-cap'` / `'zero-diff'` / `'check-hold'` / `'integration-red'`, `null` for every other reason. */
  readonly escalation: TickEscalation | null
}

/** An in-flight claim's resolution. `session-required` never reaches `classifyUnmatched` — an operator's own interactive session has no `TaskList` entry, so it must never read as a stall. `matched` is this app's analogue of a live `TaskList` hit. `reset` is renamed `stalled-confirmed` here, since this app resets nothing. */
/** `interrupted` is a new claim class the stall ladder never resets — a transcript is activity, never liveness; only Resume/Restart (operator-only) ever clears it. */
export type TickClaimClass = 'session-required' | 'matched' | 'no-record' | 'suspect' | 'stalled-confirmed' | 'capped' | 'interrupted'

export interface TickClaim {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly stage: Stage
  readonly class: TickClaimClass
  /** `true` only for `stalled-confirmed`, so a retry is never offered on a class the operator cannot yet act on. */
  readonly retryable: boolean
}

/** Why a repository's tick could not decide anything this pass. A blind repository reports **no** actionable/held/claims counts, since an empty array would be indistinguishable from a genuinely quiet repository. */
export type TickBlind =
  | { readonly reason: 'not-ready' }
  | { readonly reason: 'github-unavailable'; readonly message: string }
  | { readonly reason: 'viewer-unknown' }
  | { readonly reason: 'stale-read'; readonly ageMs: number }

/** The machine-observation write families this app ports from the cockpit's cadence, plus one report-only kind (`refresh-deferred`) that authorises no write of its own. `observe.ts`'s `observationsOf` is the only producer, except for `plan-missing`, which `main/pipeline/tick/repair.ts`'s `repairsOf` produces. */
export type TickObservationKind = 'liveness-reset' | 'cycle-cap' | 'zero-diff' | 'integration-red' | 'refresh' | 'refresh-stuck' | 'refresh-deferred' | 'withdraw-approval' | 'plan-missing' | 'adopt' | 'rerun-checks'

/** Which GitHub fact an adoption was read from. */
export type AdoptionEvidence = 'plan' | 'pr' | 'review' | 'head-moved' | 'held-verdict'

interface TickObservationBase {
  readonly number: number
  readonly itemKind: PipelineItemKind
}

export type TickObservation =
  | (TickObservationBase & { readonly kind: 'liveness-reset'; readonly stage: Stage })
  | (TickObservationBase & { readonly kind: 'cycle-cap'; readonly count: number; readonly cap: number })
  | (TickObservationBase & { readonly kind: 'zero-diff'; readonly count: number; readonly headRefOid: string })
  | (TickObservationBase & { readonly kind: 'integration-red'; readonly checks: readonly string[]; readonly headRefOid: string })
  | (TickObservationBase & {
      readonly kind: 'refresh'
      readonly from: Stage
      readonly headRefOid: string
      readonly count: number
      /** `'integration-green'` is a refresh that resumes review, not one that clears a conflict, so it posts no `## Rebase required` comment. */
      readonly cause: 'conflict' | 'integration-green'
    })
  | (TickObservationBase & {
      readonly kind: 'refresh-stuck'
      readonly from: Stage
      readonly reason: 'same-sha' | 'consecutive-cap'
      readonly sha: string
      readonly count: number
    })
  | (TickObservationBase & { readonly kind: 'refresh-deferred' })
  | (TickObservationBase & {
      readonly kind: 'withdraw-approval'
      /** `'human'` is a red check that grades the pull request's own review history, which no revision can clear. */
      readonly route: 'revise' | 'human'
      readonly red: readonly { readonly name: string | null; readonly conclusion: string | null; readonly url: string | null }[]
      readonly headRefOid: string
    })
  | (TickObservationBase & { readonly kind: 'plan-missing' })
  /** `trigger` is the stage's own trigger label, which with `agent` names the hand-back table row `main/pipeline/transitions.ts` applies. */
  | (TickObservationBase & { readonly kind: 'adopt'; readonly agent: StageAgent; readonly stage: Stage; readonly trigger: LabelKey; readonly handback: StageHandback; readonly evidence: AdoptionEvidence })
  | (TickObservationBase & { readonly kind: 'rerun-checks'; readonly runs: readonly { readonly check: string; readonly runId: string }[]; readonly headRefOid: string })

/** One `autoPlan` issue at `planReview` alone, assigned to the viewer — the app's own auto-plan swap acts on this set while it owns the repository. */
export interface TickAutoApproval {
  readonly number: number
}

/** `main/pipeline/tick/repair.ts`'s own report-only shapes — a human decision is needed, since repairing any of these would be a guess. */
export type TickLabelRepairShape = 'handback-unlabelled' | 'mirror-failed' | 'plan-missing-approved' | 'pr-missing'

export interface TickLabelRepair {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly shape: TickLabelRepairShape
  /** Where the ticket stood; `null` when it is not tracked. */
  readonly view: TicketView | null
  readonly agent: StageAgent | null
  /** Why the app's own hand-back write was refused — `null` for every shape that does not come from one. */
  readonly reason: HandoffRefusal | null
  /** The label mirror write that failed — `null` for every shape but `mirror-failed`. */
  readonly mirror: MirrorFailure | null
}

/** One repository's own tick — `planTick`'s whole result. `disabledStages` is always `[]` on a blind repository. */
export interface TickReport {
  readonly repoId: RepoId
  readonly displayName: string
  readonly blind: TickBlind | null
  readonly actionable: readonly TickActionable[]
  readonly held: readonly TickHeld[]
  readonly claims: readonly TickClaim[]
  /** Every `autoPlan` issue at `planReview` alone, assigned to the viewer — `[]` on a blind report. `main/pipeline/tick/dispatchable.ts`'s `autoApprovableFrom` is the only reader under `main/`. */
  readonly autoApprovals: readonly TickAutoApproval[]
  /** Every module-gated stage key this repository's config currently turns off — a gated stage is absent from the UI, never a stage rendered at zero. */
  readonly disabledStages: readonly LabelKey[]
  /** This repository's own GitHub source's next-due instant — `null` on a blind report: a repository this tick could not decide anything for has no decision instant to report either. */
  readonly nextTickAt: string | null
  /** The machine-observation writes the app would make (or has made) this pass, under the `dispatch` claim — always `[]` on a blind report. */
  readonly observations: readonly TickObservation[]
  /** Every half-labelled ticket `main/pipeline/tick/repair.ts` could not repair unambiguously this pass — always `[]` on a blind report. */
  readonly labelRepairs: readonly TickLabelRepair[]
}

export interface RefreshMemo {
  readonly get: (repoId: RepoId, number: number) => RefreshMemoEntry | undefined
  readonly set: (repoId: RepoId, number: number, entry: RefreshMemoEntry) => void
  readonly clear: (repoId: RepoId, number: number) => void
}

/** The head each pull request's failed checks were last re-run on, so one head is re-run once. Same per-process, restart-forgets lifetime as `RefreshMemo`. */
export interface RerunMemo {
  readonly get: (repoId: RepoId, number: number) => string | undefined
  readonly set: (repoId: RepoId, number: number, headRefOid: string) => void
}

export interface UnknownStreaks {
  readonly get: (repoId: RepoId, number: number) => number
  readonly set: (repoId: RepoId, number: number, streak: number) => void
  readonly clear: (repoId: RepoId, number: number) => void
}

/** The Needs-you "Dispatch anyway" override — same per-process, restart-forgets lifetime as `UnknownStreaks`/`RefreshMemo`; `prune` drops an entry no longer among this tick's structured candidates. */
export interface ForceDispatch {
  readonly has: (repoId: RepoId, number: number) => boolean
  readonly set: (repoId: RepoId, number: number) => void
  readonly clear: (repoId: RepoId, number: number) => void
  readonly prune: (repoId: RepoId, keep: ReadonlySet<number>) => void
}

