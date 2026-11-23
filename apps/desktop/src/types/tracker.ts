import type { LabelVocabulary, RepoLabels } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import type { LedgerRead } from '@/types/budget'
import type {
  ClaimPreflightFetch,
  FetchItemsByNumberParams,
  GatePreflightFetch,
  GitHubRepoRef,
  ItemStatesRead,
  ItemsByNumberFetch,
  PipelineFailureKind,
  PipelineItem,
  RateLimitInfo,
  TruncatedSet,
  UnavailableAlias,
} from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { GithubPrecheckOutcome } from '@/types/state'
import type { PostCommentParams, WriteOutcome } from '@/types/writes'

export interface BoardIssuesParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  /** The store's issue refs: non-null makes them, not the swept labels, the set of issues read. `null` is the label path. */
  readonly tracked: readonly TrackedRef[] | null
}

/** The issue half of the board read. Fails closed: a failed read is never an empty one. */
export type BoardIssuesRead =
  | {
      readonly ok: true
      /** Swept issues, detail-read, in sweep order; only the store's own when `tracked` was given. */
      readonly swept: readonly PipelineItem[]
      /** Tracked issues the sweep did not return, read by number, in ref order. */
      readonly tracked: readonly PipelineItem[]
      /** Tracked issues the read found closed or gone, in ref order. */
      readonly closed: readonly number[]
      /** The signed-in account's login; `null`, never a guess, when absent or dropped. */
      readonly viewer: string | null
      readonly repoLabels: RepoLabels
      readonly unavailable: readonly UnavailableAlias[]
      readonly truncated: readonly TruncatedSet[]
      readonly rateLimit: RateLimitInfo
    }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string }

export interface ListBacklogParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  /** The store's tracked issue numbers; `null` is a labels view, where membership falls back to the vocabulary names. */
  readonly tracked: ReadonlySet<number> | null
  readonly now?: () => Date
}

export interface ReadTicketParams {
  readonly repo: GitHubRepoRef
  readonly number: number
  readonly now?: () => Date
}

export interface ReadItemStatesParams {
  readonly repo: GitHubRepoRef
  readonly numbers: readonly number[]
}

export interface ReadPreflightParams {
  readonly repo: GitHubRepoRef
  readonly number: number
  readonly now?: () => Date
}

export interface ReadLedgerParams {
  readonly owner: string
  readonly name: string
  readonly issue: number
}

/**
 * Every issue-side read and write the app makes, behind one seam. The implementation binds its own transport, so no param carries one.
 *
 * `readItemsByNumber`, `readItemStates` and the preflights resolve a number that may be a pull request: on GitHub issues and pull requests share one number space, so they stay one round trip until ticket keys separate the two.
 */
export interface Tracker {
  readonly readBoardIssues: (params: BoardIssuesParams) => Promise<BoardIssuesRead>
  /** Whether the tracker's own change signal moved since the last call; the first call only primes it. A failure is a value, never a throw. */
  readonly precheck: (params: { readonly repoId: RepoId; readonly repo: GitHubRepoRef }) => Promise<GithubPrecheckOutcome>
  /** Drops whatever the tracker remembers for a repository, so a re-added one starts from a fresh prime. */
  readonly forget: (repoId: RepoId) => void
  readonly readItemsByNumber: (params: Omit<FetchItemsByNumberParams, 'github'>) => Promise<ItemsByNumberFetch>
  readonly readItemStates: (params: ReadItemStatesParams) => Promise<ItemStatesRead>
  readonly readClaimPreflight: (params: ReadPreflightParams) => Promise<ClaimPreflightFetch>
  readonly readGatePreflight: (params: ReadPreflightParams) => Promise<GatePreflightFetch>
  readonly listBacklog: (params: ListBacklogParams) => Promise<BacklogResponse>
  readonly readTicket: (params: ReadTicketParams) => Promise<BacklogDetailResponse>
  readonly readLedger: (params: ReadLedgerParams) => Promise<LedgerRead>
  readonly postPlanBody: (params: PostCommentParams) => Promise<WriteOutcome>
}
