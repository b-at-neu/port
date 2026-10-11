// Renderer-safe reconciled shapes for the unified state model. No import here may reach a Node builtin — only `main/state/` joins the four adapters. A condition a human or the environment could cause is a value, never a throw.
import type { LabelKey, VocabularyReport } from '../labels/vocabulary'
import type { LabelRole } from '../labels/defaults'
import type { CheckContext, Mergeable, PipelineFailureKind, PipelineItemKind, PullRequestCommentNode, RateLimitInfo, ReviewNode, TruncatedSet, UnavailableAlias } from '../github/types'
import type { RepoDiagnostic, RepoId, RepoProblem } from '../repos'
import type { DenialsRead, UnresolvedReason } from '../local/types'
import type { PortStageAgent, SessionScan } from '../sessions/types'

/** One role-bearing label this item carries — every co-present label stays here even though `stage` resolves a single winner. Markers are excluded — they surface separately as `marked`/`autoPlan`. */
export interface StageLabel {
  readonly key: LabelKey
  readonly name: string
  readonly role: LabelRole
}

/** `stageOf`'s result. `stage: null` is a real state, never an error. `stageAmbiguous` is `true` when more than one distinct role is present; the precedence still resolves `stage`, it never hides the co-presence. */
export interface StageResult {
  readonly stages: readonly StageLabel[]
  readonly stage: LabelRole | null
  readonly stageAmbiguous: boolean
  readonly marked: boolean
  readonly autoPlan: boolean
}

/** From `stage.role` plus the attachment ladder. `stalled` is a report, never a proof — a session scan that could not run is absence of evidence and never produces this verdict. */
export type ItemStatus = 'waiting' | 'in-flight' | 'stalled' | 'gated' | 'terminal' | 'unstaged' | 'interrupted'

/** Why `status` reads the way it does — distinguishes "nothing claims this" from "the transcript hasn't moved" from "the app couldn't even check". */
export type StatusEvidence = 'sessions-unavailable' | 'agent-active' | 'session-active' | 'all-dormant' | 'no-claimant'

/** Accompanies `status: 'waiting'`, first hit wins: `nobody` is unassigned; `operator-session` means the `SESSION REQUIRED` marker holds; `cockpit` is the ordinary case. */
export type WaitingOn = 'cockpit' | 'operator-session' | 'nobody'

/** Why `linked` is `null` — an issue at `pr opened` whose pull request
 *  merged is `counterpart-not-open`, never rendered as "awaiting merge". */
export type LinkReason = 'no-closing-keyword' | 'counterpart-not-open'

export type AgentAttachMatch = 'direct' | 'linked'

/** An `AgentRecord` matched to this item, directly or via its linked counterpart. */
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

/** A `SessionRecord` matched to this item — carries `role`/`roleEvidence` so an operator-session claim is visibly a session, never indistinguishable from a dispatched subagent. */
export interface AttachedSession {
  readonly sessionId: string
  readonly role: 'cockpit' | 'implement' | 'other'
  readonly roleEvidence: 'worktree-name' | 'stage-agent' | 'first-prompt' | null
  readonly activity: 'active' | 'idle' | 'dormant'
  readonly idleMs: number
  readonly lastActivityAt: string
  readonly match: AgentAttachMatch
}

/** A `WorktreeEntry` whose `correlation.number` matches this item. An entry with `unresolved` set is never guessed onto an item — it lands in `uncorrelatedWorktrees` instead. */
export interface AttachedWorktree {
  readonly path: string
  readonly branch: string | null
  readonly producer: 'operator' | 'dispatched' | 'other'
  readonly rung: 'upstream-branch' | 'branch-name' | 'directory-basename' | 'head-subject'
  readonly locked: boolean
  readonly prunable: boolean
}

/** Why a number named by a worktree or an agent record never appeared in the open-only sweep — resolved through `fetchItemsByNumber`, never inferred. `recheck-unavailable` is never collapsed into `number-not-found`. */
export type OrphanReason = 'item-merged' | 'item-closed' | 'item-open-unlabelled' | 'number-not-found' | 'recheck-unavailable'

export interface OrphanItem {
  readonly number: number
  readonly kind: PipelineItemKind | null
  readonly from: 'worktree' | 'agent'
  readonly reason: OrphanReason
}

/** Every shape one reconciled item carries. `sources` names which adapters actually contributed a fact to this item — freshness lives once per repository, not copied per item. */
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
  /** The plan's own ` ```files ` fence, parsed for issues only. `null` is "no file list" (dispatches unchecked); `[]` is a fence that parsed to nothing — the two are never collapsed. */
  readonly claimedFiles: readonly string[] | null
  /** Copied straight off `PipelineItem`, pull-request only — `null` for an issue. Feeds `scripts/port-tick/gates.ts`'s `cycleCapExceeded`/`zeroDiffGate`. */
  readonly headRefOid: string | null
  /** Copied straight off `PipelineItem`, pull-request only — `null` for an issue. Feeds `scripts/port-tick/gates.ts`'s `mergeabilityRoute`. */
  readonly mergeable: Mergeable
  readonly reviews: readonly ReviewNode[] | null
  readonly comments: readonly PullRequestCommentNode[] | null
  /** `codeReviewCount(reviews)`, precomputed here so the renderer never re-derives it from raw review bodies — `null` for an issue. */
  readonly reviewCycleCount: number | null
  /** Copied straight off `PipelineItem`, pull-request only — `null` for an issue. Feeds `scripts/port-tick/checks.ts`'s `rollupVerdict` for the approval-withdrawal observation. */
  readonly checkRollup: readonly CheckContext[] | null
}

/** `{ at }` when the source answered, `{ unavailable: <reason> }` when it did not — never a stale-looking timestamp standing in for "did not run". */
export type FreshnessEntry = { readonly at: string } | { readonly unavailable: string }

export interface RepositoryFreshness {
  readonly github: FreshnessEntry
  readonly itemStates: FreshnessEntry
  readonly sessions: FreshnessEntry
  readonly worktrees: FreshnessEntry
  readonly denials: FreshnessEntry
}

/** A worktree correlated to a number the open sweep never returned would otherwise vanish entirely. `registered` is every entry `readWorktrees` returned; `null`, never `0`, when the worktree source itself failed. */
export interface WorktreeTotals {
  readonly registered: number
  readonly attached: number
  readonly uncorrelated: number
}

/** One repository's reconciled view. A non-`ready` entry is a `RepositoryState` too, never a dropped row — it carries `RepoProblem` verbatim rather than silently omitting a misconfigured repository. */
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
      readonly vocabulary: VocabularyReport
      readonly unavailable: readonly UnavailableAlias[]
      readonly truncated: readonly TruncatedSet[]
      readonly rateLimit: RateLimitInfo
      readonly freshness: RepositoryFreshness
      readonly worktreeTotals: WorktreeTotals | null
      /** The signed-in account's own login, carried straight off `PipelineFetch.viewer` — `null`, never a guess, when unresolvable. */
      readonly viewer: string | null
      /** `entry.config.modules.approvalGate`, copied onto every item read so the ungated selection and `actionsFor` never need a second config read. */
      readonly approvalGate: boolean
      /** Every module-gated label key this repository currently has turned off, so `planTick` never needs a second config read to report a gated stage as absent. */
      readonly disabled: readonly LabelKey[]
      /** `entry.config.concurrency`, copied the same way `approvalGate` is, so `planTick`'s file-contention gate never needs a second config read. */
      readonly concurrency: { readonly sharedFiles: readonly string[]; readonly overlapThreshold: number }
      /** `entry.config.reviewCycleCap`, copied the same way `approvalGate` is, so `decisionsFor` never needs a second config read. */
      readonly reviewCycleCap: number
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

/** The top-level result `readPipelineState` returns — `sessions` is the whole `SessionScan` at this level, never per repository: one machine-wide call, machine-level facts. */
export interface PipelineState {
  readonly repositories: readonly RepositoryState[]
  readonly sessions: SessionScan
  readonly readAt: string
}
