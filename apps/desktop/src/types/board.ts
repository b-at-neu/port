// Pure types and constants for the board projection. No import here may reach a Node builtin or `src/main/`, so this file compiles under `typecheck:web`.
import type { RepoId } from '@/utils/repos'
import type { ItemStatus, PipelineState, ReconciledItem, RepositoryState, StageLabel } from '@/types/state'
import type { ActionAvailability, DecisionAvailability, ItemActionResult, OperatorAction, OperatorDecision } from '@/types/actions'
import type { StageAgent, TickClaim, TickHeld, TickLabelRepair, TickReport } from '@/types/tick'
import type { BudgetNote, DispatchOwner, RepoDispatchStatus, RunStatesSnapshot } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { AskQuestion } from '@/utils/hosting/controls'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { LabelPalette } from '@/utils/labels/defaults'
import type { StageDenial, InterruptedStage } from '@/types/stage'
import type { Ticket, TicketRef } from '@/types/ticket'
import type { PipelineItemKind } from '@/types/github'

/** The four sources the watcher polls independently; `itemStates` is a dependent re-check fired internally, never independently schedulable. */
export const SOURCE_KINDS = ['github', 'sessions', 'worktrees', 'denials'] as const

export type SourceKind = (typeof SOURCE_KINDS)[number]

/** GitHub is expensive; the three local reads are cheap and run far more often. Shared by the scheduler and the staleness rule so the two agree on "one interval old". */
export const SOURCE_BASE_INTERVAL_MS: Readonly<Record<SourceKind, number>> = {
  github: 60_000,
  sessions: 15_000,
  worktrees: 15_000,
  denials: 15_000,
}

/** Backoff doubles from a source's base interval up to this ceiling. */
export const BACKOFF_CEILING_MS = 15 * 60 * 1000

/** Below this many points remaining, the GitHub source defers to the window's own `resetAt` instead of a doubled guess. */
export const RATE_LIMIT_FLOOR = 200

/** The share of the hourly GraphQL limit the app's own polling may use, across every registered repository. */
export const BUDGET_SHARE = 0.5

/** Used when a read reports no `limit`; 5,000 is the smallest standard hourly budget. */
export const DEFAULT_GRAPHQL_LIMIT = 5000

/** A `stalled` verdict renders as `stalled` only when the GitHub read behind it is within `githubIntervalMs + STALE_GRACE_MS`, wide enough to absorb ordinary poll jitter. */
export const STALE_GRACE_MS = 30_000

export interface SourceHealth {
  readonly lastSuccessAt: string | null
  readonly lastAttemptAt: string | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
  /** Base until a failure doubles it, reset to base on the next success. */
  readonly intervalMs: number
  /** Set only by a rate-limited GitHub failure — overrides the doubled-interval guess with the known reset instant. */
  readonly deferredUntil: string | null
}

export function initialHealth(kind: SourceKind): SourceHealth {
  return {
    lastSuccessAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    lastError: null,
    intervalMs: SOURCE_BASE_INTERVAL_MS[kind],
    deferredUntil: null,
  }
}

/** An unparseable instant reads as not deferred, so a read that is really limited fails cleanly and sets a fresh `deferredUntil`. */
export function isDeferred(health: SourceHealth, now: Date): boolean {
  return health.deferredUntil !== null && Date.parse(health.deferredUntil) > now.getTime()
}

/** One repository's own health across all four sources; `sessions` is the one machine-wide scan's health, copied onto every repository. */
export interface RepositoryHealth {
  readonly repoId: RepoId
  readonly github: SourceHealth
  readonly sessions: SourceHealth
  readonly worktrees: SourceHealth
  readonly denials: SourceHealth
}

export interface PollPolicy {
  readonly baseIntervalMs: Readonly<Record<SourceKind, number>>
  readonly backoffCeilingMs: number
  readonly rateLimitFloor: number
  readonly staleGraceMs: number
}

export const DEFAULT_POLL_POLICY: PollPolicy = {
  baseIntervalMs: SOURCE_BASE_INTERVAL_MS,
  backoffCeilingMs: BACKOFF_CEILING_MS,
  rateLimitFloor: RATE_LIMIT_FLOOR,
  staleGraceMs: STALE_GRACE_MS,
}

/** The one payload the watcher pushes and the renderer ever reads; `health` and `policy` are carried alongside `state` rather than folded into it. */
export interface BoardSnapshot {
  readonly state: PipelineState
  readonly health: readonly RepositoryHealth[]
  readonly policy: PollPolicy
  /** One `TickReport` per ready repository, computed inside `buildSnapshot()` from the same `PipelineState` above, never a second poll. */
  readonly tick: readonly TickReport[]
  /** Every registered repository's own run state, stamped onto every snapshot; defaults to an empty, paused run-state set when the watcher has no source wired. */
  readonly runStates: RunStatesSnapshot
  /** The watcher's one timer's next due instant — `null` once `stop()` has run, the honest rendering of "no wakeup scheduled". */
  readonly nextWakeupAt: string | null
  readonly emittedAt: string
  /** One row per ready repository, this app's own dispatcher state, computed inside `buildSnapshot()` from `dispatcher.status()`. `[]` when no dispatcher is wired. */
  readonly dispatch: readonly RepoDispatchStatus[]
}

export type GroupBy = 'stage' | 'repo'

/** A presentation verdict — the only value it may change is `stalled` → `in-flight`; it never rewrites `ReconciledItem.status` itself. */
export interface DisplayStatus {
  readonly status: ItemStatus
  readonly staleGithub: boolean
  readonly githubAgeMs: number | null
}

/** A live hosted stage session for this row's item — the app's own dispatch evidence, independent of whether the agent has swapped a label yet. */
export interface LiveStage {
  readonly agent: StageAgent
  readonly trigger: LabelKey
  readonly sessionKey: SessionKey
}

export interface BoardItemRow {
  /** The ticket's status source — the pull request once it carries a stage label, else the issue. Every action and decision acts on this item; every display reads `ticket`. */
  readonly item: ReconciledItem
  readonly ticket: Ticket
  readonly displayStatus: DisplayStatus
  /** `null` when no live stage session matches this item's repository, kind and number. */
  readonly liveStage: LiveStage | null
  readonly stageLabel: StageLabel | null
  /** `actionsFor`'s own result for this item, so the row renders from one already-computed value, never a second derivation client-side. */
  readonly actions: Readonly<Record<OperatorAction, ActionAvailability>>
  /** `decisionsFor`'s own result for this item, same rule as `actions` above. */
  readonly decisions: Readonly<Record<OperatorDecision, DecisionAvailability>>
  /** This item's repository's own `RepositoryState.viewer`, copied onto the row so `phase-history.ts`'s "you" resolution never needs a second repository lookup. */
  readonly viewer: string | null
}

export interface BoardGroup {
  /** The label `key` (grouped by stage) or the `RepoId` (grouped by repo), never a display name, so two repositories renaming a label still group together. */
  readonly key: string
  readonly name: string
  readonly rows: readonly BoardItemRow[]
}

export interface BoardRepositorySummary {
  readonly repoId: RepoId
  readonly displayName: string
  readonly waiting: number
  readonly inFlight: number
  readonly stalled: number
  /** `null` only when the worktree source has never returned a good read for this repository — never `0` standing in for "did not run". */
  readonly worktreeTotal: number | null
  /** The inspector's own burst copy, verbatim — `null` when nothing on this repository's denial log currently qualifies. */
  readonly denialBurst: string | null
}

export interface BoardProjection {
  readonly groupBy: GroupBy
  readonly groups: readonly BoardGroup[]
  /** Every row, sorted the same way `groups` orders them, but unlike `groups` never drops a row whose `stageLabel` matches no `LABEL_DEFAULTS` entry. */
  readonly rows: readonly BoardItemRow[]
  readonly notReady: readonly Extract<RepositoryState, { readonly ok: false }>[]
  readonly repositorySummaries: readonly BoardRepositorySummary[]
  readonly totalItems: number
  /** Every row whose `gate` action is available, from a repository with the `approvalGate` module on. Never populated when the module is off. */
  readonly ungated: readonly BoardItemRow[]
  readonly emittedAt: string
  /** A compact string over every rendered field, deliberately excluding `emittedAt`, so a poll that changed nothing never triggers a rebuild. */
  readonly signature: string
}

export type ItemActionState = { readonly kind: 'pending'; readonly action: OperatorAction } | { readonly kind: 'result'; readonly action: OperatorAction; readonly result: ItemActionResult }

interface NeedsYouItemBase {
  readonly repoId: RepoId | null
  readonly repo: string | null
  /** The action target — the pull request or issue this row writes to, never the ticket's number. */
  readonly number: number | null
  readonly title: string | null
  readonly url: string | null
  /** The ticket this row belongs to, for display; `null` when no board row matches `number`. */
  readonly ticket: TicketRef | null
  /** The event's own time where the kind has one, else the matched row's `updatedAt`; `null` when neither is known. */
  readonly at: string | null
  /** The board row at this (repoId, number), when one exists — lets `held`/`stalled` reuse its `decisions.unblock` too. */
  readonly matchedRow: BoardItemRow | null
}

/** One row per (repo, number, kind) — an item with two reasons appears twice, each with its own action. */
export type NeedsYouItem =
  | (NeedsYouItemBase & { readonly kind: 'plan-review'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'ready-to-merge'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'needs-human'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'blocked'; readonly row: BoardItemRow })
  | (NeedsYouItemBase & { readonly kind: 'budget'; readonly note: BudgetNote })
  /** `owner` is this held item's own repository's `RepoDispatchStatus.owner` — `null` only when the repository reported none (never rendered: `heldAction` reads it only for a `contended` hold, which never arises on an unready repository). */
  | (NeedsYouItemBase & { readonly kind: 'held'; readonly held: TickHeld; readonly owner: DispatchOwner | null })
  | (NeedsYouItemBase & { readonly kind: 'stalled'; readonly claim: TickClaim })
  | (NeedsYouItemBase & { readonly kind: 'stage-question'; readonly sessionKey: SessionKey; readonly permissionId: string; readonly questions: readonly AskQuestion[] })
  | (NeedsYouItemBase & { readonly kind: 'stage-questions' | 'stage-blocked'; readonly sessionKey: SessionKey; readonly text: string | null })
  | (NeedsYouItemBase & { readonly kind: 'stage-denial'; readonly denial: StageDenial })
  | (NeedsYouItemBase & { readonly kind: 'stage-interrupted'; readonly interrupted: InterruptedStage })
  /** Every usage-limit interruption across all repositories, collapsed into one row — `resetsAt` is the latest known reset, `null` when none is. */
  | (NeedsYouItemBase & { readonly kind: 'usage-limit'; readonly entries: readonly InterruptedStage[]; readonly resetsAt: string | null; readonly repoNames: ReadonlyMap<RepoId, string> })
  | (NeedsYouItemBase & { readonly kind: 'half-labelled'; readonly repair: TickLabelRepair })

/** The Needs you item keys last seen, by repository — `''` for an item with no repository. */
export type NeedsYouBaseline = Readonly<Record<string, readonly string[]>>

/** The groups Needs you renders — `stage-question`/`stage-questions` share `questions`, and `stage-blocked` joins `blocked`. */
export type NeedsYouGroupKey = 'plan-review' | 'ready-to-merge' | 'needs-human' | 'blocked' | 'questions' | 'denied' | 'interrupted' | 'usage-limit' | 'held' | 'stalled' | 'budget' | 'half-labelled'

export const PHASE_KEYS = ['plan', 'planReview', 'implement', 'review', 'revision', 'merge'] as const

export type PhaseKey = (typeof PHASE_KEYS)[number]

export type PhaseSegmentState = 'finished' | 'current-working' | 'current-attention' | 'complete' | 'pending'

/** One of the six phases as `PhaseBar`/`PhaseList` paint it; `palette` is `null` for a pending phase, which has no colour yet. */
export interface PhaseSegment {
  readonly phase: PhaseKey
  readonly state: PhaseSegmentState
  readonly palette: LabelPalette | null
}

/** One phase's "who and when" line — `phase-history.ts`'s own result shape, `null` `at` for a current phase whose only line is a cost reading with no entry behind it. */
export interface PhaseDetail {
  readonly line: string
  readonly at: string | null
}

export type BoardGroupBy = 'phase' | 'repo'

/** One (number, kind) a ticket answers to — its issue or its pull request. */
export interface StageLinkTarget {
  readonly number: number
  readonly kind: PipelineItemKind
}

export type StageLink =
  | { readonly kind: 'live'; readonly agent: StageAgent; readonly sessionKey: SessionKey; readonly at: string; readonly operatorJoined: boolean }
  | { readonly kind: 'transcript'; readonly agent: StageAgent; readonly sessionId: string; readonly at: string; readonly operatorJoined: boolean }
