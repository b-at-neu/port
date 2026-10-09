// Renderer-safe shapes for the tick engine (#105) — what one repository's
// tick would dispatch, what it holds back and why, and what each in-flight
// claim resolves to. No import here may reach a Node builtin — `main/tick/`
// is this ticket's only computer, but the renderer's tick strip is the
// eventual consumer, so this file compiles under `typecheck:web` too, the
// same rule `shared/state/types.ts` and `shared/board/types.ts` already
// state for themselves.
import type { PipelineItemKind } from '../github/types'
import type { LabelKey } from '../labels/vocabulary'
import type { RepoId } from '../repos'

/** The stage-agent map's own value union — a bare four-way key, never the
 *  session index's hyphenated `PortStageAgent` (`'plan-agent'`), because
 *  this one names *what to dispatch next*, matching `port.config.json`'s own
 *  `models.<key>` keys, not *what already ran*. */
export type StageAgent = 'plan' | 'impl' | 'review' | 'revise'

/** Why a trigger-stage item is held rather than actionable — first hit wins
 *  in `planTick`: `unowned` before `other-operator` before
 *  `session-required` before `contended`, mirroring
 *  `ReconciledItem.waitingOn`'s own ladder with an ownership check inserted
 *  ahead of the session-required one, and the file-contention gate applied
 *  only to the impl candidates that survive all three. `cycle-cap`/
 *  `zero-diff` (#108) are checked per-item, after that ladder and before the
 *  file-contention gate — a `revise`/`review` candidate that would escalate
 *  to `needsHuman` moves from `actionable` to `held` naming why, since this
 *  app computes the decision and the report, never the write (the real
 *  escalation lands beside the eventual dispatch call, per the plan's own
 *  **Risks / notes**). */
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

/** `TickHeld.escalation`'s own shape (#108) — `null` for every reason above
 *  except `cycle-cap`/`zero-diff`, which carry the count and the cap, or the
 *  zero-diff fact, without re-deriving either from raw review data.
 *  `refresh-wins`/`conflicting`/`mergeability-unknown` (#265) authorise no
 *  write, so they carry no escalation either. */
export type TickEscalation = { readonly kind: 'cycle-cap'; readonly count: number; readonly cap: number } | { readonly kind: 'zero-diff' }

/** The file-contention gate's own held detail (`scripts/port-tick/contention.ts`'s
 *  `gateCandidates`) — populated only for `reason: 'contended'`, `null` for
 *  the other three reasons, since none of them names a blocker or a path
 *  list. */
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
  /** `true` when this candidate's plan carried no ` ```files ` fence at all
   *  — it dispatches unchecked rather than held, per "Fail-open on an
   *  unstructured plan": silently holding every pre-contract plan would
   *  stall the pipeline harder than the collision the gate prevents. */
  readonly unchecked: boolean
  /** The current review cycle count and cap (#108) — populated only for a
   *  `revise`/`review` candidate that carries a cycle count, `null` for
   *  every other agent, so a pull request approaching the cap is visible on
   *  hover before it ever holds. */
  readonly cycle: { readonly count: number; readonly cap: number } | null
}

export interface TickHeld {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly reason: TickHeldReason
  readonly contention: TickContention | null
  /** Populated only for `reason: 'cycle-cap'` / `'zero-diff'`, `null` for
   *  every other reason — the file-contention gate's own `contention`
   *  field, mirrored for this pair (#108). */
  readonly escalation: TickEscalation | null
}

/**
 * An in-flight claim's own resolution. `session-required` never reaches
 * `classifyUnmatched` at all — an operator's own interactive session has no
 * `TaskList` entry to match, so it must never be read as a stall
 * (RECOVERY.md → "Liveness"). `matched` is this app's own analogue of a live
 * `TaskList` hit: an attached agent or session this app's own scan found
 * active. The remaining four are `classifyUnmatched`'s own literals, with
 * its `reset` renamed `stalled-confirmed` here — this app resets nothing, so
 * borrowing the engine's verb for an action it does not perform would be a
 * false claim (plan's own **Implementation**).
 */
export type TickClaimClass = 'session-required' | 'matched' | 'no-record' | 'suspect' | 'stalled-confirmed' | 'capped'

export interface TickClaim {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly inFlight: LabelKey
  readonly class: TickClaimClass
  /** `RETRY_TRIGGER`'s own target for this claim's in-flight key — set only
   *  for `stalled-confirmed`, so a retry is never offered on a class the
   *  operator cannot yet act on. */
  readonly retryKey: LabelKey | null
}

/**
 * Why a repository's tick could not decide anything this pass. A blind
 * repository reports **no** actionable/held/claims counts — an empty array
 * standing in for "nothing to do" here would be indistinguishable from a
 * genuinely quiet repository, which is exactly the ambiguity `TickReport`
 * exists to remove (ENGINEERING §4 — the tick fails closed on actions,
 * never on reporting).
 */
export type TickBlind =
  | { readonly reason: 'not-ready' }
  | { readonly reason: 'github-unavailable'; readonly message: string }
  | { readonly reason: 'viewer-unknown' }
  | { readonly reason: 'stale-read'; readonly ageMs: number }

/** The four machine-observation write families #292 ports from the cockpit's
 *  own cadence, plus one report-only kind the board's hover state names but
 *  that authorises no write of its own (`refresh-deferred` — a refresh
 *  candidate this pass already capped at `capRefreshes`'s own per-tick
 *  limit). The prior unverifiable-withdrawal kind is retired (#300): the app
 *  now applies a repository's `CLAUDE.md` overrides itself, so withdrawal
 *  has nothing left it cannot safely verify. `main/tick/observe.ts`'s
 *  `observationsOf` is the only producer; `main/tick/dispatchable.ts`'s
 *  `observableFrom` narrows this to the write-bearing subset the dispatcher
 *  may actually act on. */
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

/** One `autoPlan` issue at `planReview` alone, assigned to the viewer (#313)
 *  — the app's own auto-plan swap acts on this set while it owns the
 *  repository, mirroring the cockpit's own unprompted `autoPlan` swap
 *  (`docs/COORDINATION.md` → "The decision"). */
export interface TickAutoApproval {
  readonly number: number
}

/** One repository's own tick — `planTick`'s whole result. `disabledStages`
 *  is always `[]` on a blind repository, the same direction as
 *  `actionable`/`held`/`claims`. */
export interface TickReport {
  readonly repoId: RepoId
  readonly displayName: string
  readonly blind: TickBlind | null
  readonly actionable: readonly TickActionable[]
  readonly held: readonly TickHeld[]
  readonly claims: readonly TickClaim[]
  /** #313: every `autoPlan` issue at `planReview` alone, assigned to the
   *  viewer — `[]` on a blind report, the same direction as
   *  `actionable`/`held`/`claims`. `main/tick/dispatchable.ts`'s
   *  `autoApprovableFrom` is the only function under `main/` allowed to
   *  read this. */
  readonly autoApprovals: readonly TickAutoApproval[]
  /** Every module-gated stage key this repository's config currently turns
   *  off (`LabelVocabulary.disabled`, carried onto `RepositoryState`) — a
   *  gated stage is absent from the UI, never a stage rendered at zero. */
  readonly disabledStages: readonly LabelKey[]
  /** This repository's own GitHub source's next-due instant
   *  (`nextDueAt(health.github, now)`, passed into `planTick` as
   *  `nextDecisionAt`) — `null` on a blind report, the same direction as
   *  every count above: a repository this tick could not decide anything
   *  for has no decision instant to report either (#62 — a field that
   *  cannot express "no timer" is the bug this app exists to not repeat). */
  readonly nextTickAt: string | null
  /** #292: the machine-observation writes the app would make (or has made)
   *  this pass, under the `dispatch` claim — always `[]` on a blind report,
   *  the same direction as `actionable`/`held`/`claims`. */
  readonly observations: readonly TickObservation[]
}
