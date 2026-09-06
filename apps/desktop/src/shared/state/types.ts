// Renderer-safe reconciled shapes for the unified state model (#79). No
// import here may reach a Node builtin — apps/desktop/src/main/state/ is the
// only place that joins the four adapters (#74/#76/#77/#78), but the
// renderer is the eventual consumer of these shapes over IPC (#80), so this
// file compiles under `typecheck:web` too. The error rule is #72's,
// unchanged: a condition a human or the environment could cause is a value,
// never a throw.
import type { LabelKey } from '../labels/vocabulary'
import type { LabelRole } from '../labels/defaults'
import type { PipelineFailureKind, PipelineItemKind, RateLimitInfo, TruncatedSet, UnavailableAlias } from '../github/types'
import type { RepoDiagnostic, RepoId, RepoProblem } from '../repos'
import type { DenialsRead, UnresolvedReason } from '../local/types'
import type { PortStageAgent, SessionScan } from '../sessions/types'

/** One role-bearing label this item carries — every co-present label stays
 *  here even though `stage` resolves a single winner (Decision, the
 *  precedence never discards a fact). Markers (`claude`, `auto plan`) are
 *  excluded — they surface separately as `marked`/`autoPlan`. */
export interface StageLabel {
  readonly key: LabelKey
  readonly name: string
  readonly role: LabelRole
}

/**
 * `stageOf`'s result. `stage: null` is a real state (`status: 'unstaged'`),
 * never an error — an item carrying only markers has no stage at all.
 * `stageAmbiguous` is `true` when more than one distinct role is present
 * (e.g. a preview-database refresh deliberately leaves `approved` in place
 * beside `refreshing`) — the precedence still resolves `stage`, it never
 * hides the co-presence.
 */
export interface StageResult {
  readonly stages: readonly StageLabel[]
  readonly stage: LabelRole | null
  readonly stageAmbiguous: boolean
  readonly marked: boolean
  readonly autoPlan: boolean
}

/**
 * From `stage.role` plus the attachment ladder (Decision 2). `stalled` is a
 * **report, never a proof** — `TaskList` is the only real liveness evidence
 * and this app has none (PIPELINE.md → "Liveness"). A session scan that
 * could not run, or a repository with no session slice, is *absence of
 * evidence* and never produces this verdict — a check that could not run is
 * not a check that found nothing.
 */
export type ItemStatus = 'waiting' | 'in-flight' | 'stalled' | 'gated' | 'terminal' | 'unstaged'

/** Why `status` reads the way it does — named so an operator can tell
 *  "nothing claims this" (`no-claimant`) from "the transcript has not moved
 *  in an hour" (`all-dormant`) from "the app could not even check"
 *  (`sessions-unavailable`). */
export type StatusEvidence = 'sessions-unavailable' | 'agent-active' | 'session-active' | 'all-dormant' | 'no-claimant'

/**
 * Accompanies `status: 'waiting'`, first hit wins:
 * - `nobody` — unassigned, so no cockpit's assignee-filtered tick can see it.
 * - `operator-session` — the `SESSION REQUIRED` marker slot holds — the item
 *   keeps its trigger label and is never dispatched by any cockpit.
 * - `cockpit` — otherwise, the ordinary case.
 */
export type WaitingOn = 'cockpit' | 'operator-session' | 'nobody'

/** Why `linked` is `null` — an issue at `pr opened` whose pull request
 *  merged is `counterpart-not-open`, never rendered as "awaiting merge". */
export type LinkReason = 'no-closing-keyword' | 'counterpart-not-open'

export type AgentAttachMatch = 'direct' | 'linked'

/** The ticket's "in-flight agent with stage/model/id" — an `AgentRecord`
 *  (#78) matched to this item, directly or via its linked counterpart. */
export interface AttachedAgent {
  readonly agentId: string
  readonly agentType: string
  readonly stage: PortStageAgent | null
  readonly model: string | null
  readonly activity: 'active' | 'idle' | 'dormant'
  readonly idleMs: number
  readonly lastActivityAt: string
  readonly match: AgentAttachMatch
}

/** A `SessionRecord` (#78) matched to this item — carries `role`/
 *  `roleEvidence` so an operator-session claim is visibly a session, never
 *  indistinguishable from a dispatched subagent. */
export interface AttachedSession {
  readonly sessionId: string
  readonly role: 'cockpit' | 'implement' | 'other'
  readonly roleEvidence: 'worktree-name' | 'stage-agent' | 'first-prompt' | null
  readonly activity: 'active' | 'idle' | 'dormant'
  readonly idleMs: number
  readonly lastActivityAt: string
  readonly match: AgentAttachMatch
}

/** A `WorktreeEntry` (#77) whose `correlation.number` matches this item. An
 *  entry with `unresolved` set is never guessed onto an item — it lands in
 *  the repository-level `uncorrelatedWorktrees` instead, with its reason
 *  intact. */
export interface AttachedWorktree {
  readonly path: string
  readonly branch: string | null
  readonly producer: 'operator' | 'dispatched' | 'other'
  readonly rung: 'upstream-branch' | 'branch-name' | 'directory-basename' | 'head-subject'
  readonly locked: boolean
  readonly prunable: boolean
}

/** Why a number named by a worktree or an agent record never appeared in the
 *  open-only sweep (#79 Decision 4) — resolved through `fetchItemsByNumber`,
 *  never inferred. `recheck-unavailable` is its own value: a failed re-check
 *  is never collapsed into `number-not-found`. */
export type OrphanReason = 'item-merged' | 'item-closed' | 'item-open-unlabelled' | 'number-not-found' | 'recheck-unavailable'

export interface OrphanItem {
  readonly number: number
  readonly kind: PipelineItemKind | null
  readonly from: 'worktree' | 'agent'
  readonly reason: OrphanReason
}

/** Every shape one reconciled item carries. `sources` names which adapters
 *  actually contributed a fact to *this* item — freshness itself lives once
 *  per repository (Decision 5), not copied per item. */
export interface ReconciledItem {
  readonly repoId: RepoId
  readonly repo: string
  readonly kind: PipelineItemKind
  readonly number: number
  readonly title: string
  readonly url: string
  readonly assignees: readonly string[]
  readonly stage: LabelRole | null
  readonly stages: readonly StageLabel[]
  readonly stageAmbiguous: boolean
  readonly marked: boolean
  readonly autoPlan: boolean
  readonly status: ItemStatus
  readonly statusEvidence: StatusEvidence | null
  readonly waitingOn: WaitingOn | null
  readonly sessionRequired: boolean
  readonly linked: number | null
  readonly linkReason: LinkReason | null
  readonly agents: readonly AttachedAgent[]
  readonly sessions: readonly AttachedSession[]
  readonly worktrees: readonly AttachedWorktree[]
  readonly state: string
  readonly mergedAt: string | null
  readonly matchedKeys: readonly LabelKey[]
  readonly sources: readonly ('github' | 'itemStates' | 'sessions' | 'worktrees' | 'denials')[]
}

/** `{ at }` when the source answered, `{ unavailable: <reason> }` when it did
 *  not — never a stale-looking timestamp standing in for "did not run".
 *  `itemStates` additionally reports `'no re-check needed'`, a distinct
 *  value from an actual failure, when there were no orphan numbers to check. */
export type FreshnessEntry = { readonly at: string } | { readonly unavailable: string }

export interface RepositoryFreshness {
  readonly github: FreshnessEntry
  readonly itemStates: FreshnessEntry
  readonly sessions: FreshnessEntry
  readonly worktrees: FreshnessEntry
  readonly denials: FreshnessEntry
}

/**
 * One repository's reconciled view. A non-`ready` entry is a `RepositoryState`
 * too, never a dropped row — it carries #74's own `RepoProblem` verbatim,
 * because silently omitting a misconfigured repository from a cross-repo
 * board is the invisibility class this app is organised against. Direction
 * of failure: closed on the answer, open on reporting — a partial GitHub
 * response is the one case returning `ok: true` alongside `unavailable`; no
 * path returns `items: []` for a read that did not succeed.
 */
export type RepositoryState =
  | {
      readonly ok: true
      readonly repoId: RepoId
      readonly repo: string
      readonly displayName: string
      readonly items: readonly ReconciledItem[]
      readonly orphans: readonly OrphanItem[]
      readonly uncorrelatedWorktrees: readonly { readonly path: string; readonly reason: UnresolvedReason }[]
      readonly denials: DenialsRead
      readonly diagnostics: readonly RepoDiagnostic[]
      readonly unavailable: readonly UnavailableAlias[]
      readonly truncated: readonly TruncatedSet[]
      readonly rateLimit: RateLimitInfo
      readonly freshness: RepositoryFreshness
    }
  | {
      readonly ok: false
      readonly repoId: RepoId
      readonly displayName: string
      readonly reason: 'not-ready'
      readonly problem: RepoProblem
    }
  | {
      readonly ok: false
      readonly repoId: RepoId
      readonly repo: string
      readonly displayName: string
      readonly reason: 'github-unavailable'
      readonly kind: PipelineFailureKind
      readonly message: string
      readonly freshness: RepositoryFreshness
    }

/** The top-level result `readPipelineState` returns — `sessions` is #78's
 *  whole `SessionScan` at this level, never per repository (Decision 5): it
 *  is one machine-wide call, and its `unattributed`/`unresolved` counts are
 *  machine-level facts, not any one repository's. */
export interface PipelineState {
  readonly repositories: readonly RepositoryState[]
  readonly sessions: SessionScan
  readonly readAt: string
}
