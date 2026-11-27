import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import type { LedgerRead } from '@/main/github/budget-ledger'
import type { BoardHalf, BoardHalfFailure, ClaimPreflightFetch, FetchItemsByNumberParams, GatePreflightFetch, GitHubRepoRef, ItemsByNumberFetch, ItemStatesRead } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { GithubPrecheckOutcome } from '@/types/state'
import type { PostCommentParams, WriteOutcome } from '@/types/writes'
import type { DisplayVocabulary } from '@/utils/labels/display'
import type { RepoLabels } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

export interface BoardIssuesParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: DisplayVocabulary
  /** The store's issue refs: non-null makes them, not the swept labels, the set of issues read. `null` is the label path. */
  readonly tracked: readonly TrackedRef[] | null
}

/** The issue half of the board read, plus the repository's real label list and the signed-in login — labels and assignment belong to the tracker. */
export type BoardIssuesFetch = (BoardHalf & { readonly repoLabels: RepoLabels; readonly viewer: string | null }) | BoardHalfFailure

export interface ItemNumberParams {
  readonly repo: GitHubRepoRef
  readonly number: number
}

export interface ItemStatesParams {
  readonly repo: GitHubRepoRef
  readonly numbers: readonly number[]
}

export interface BacklogListParams {
  readonly repo: GitHubRepoRef
  /** The store's tracked issue numbers; empty for an unseeded repository until the first poll seeds it. */
  readonly tracked: ReadonlySet<number>
}

export interface LedgerParams {
  readonly owner: string
  readonly name: string
  readonly issue: number
}

export interface TrackerPrecheckParams {
  readonly repoId: RepoId
  readonly repo: GitHubRepoRef
}

/** The vendor-neutral issue tracker. Params carry no transport: an implementation binds its own context when it is built. The by-number reads and both preflights may resolve a pull request, because GitHub gives issues and pull requests one number space. */
export interface Tracker {
  readonly readBoardIssues: (params: BoardIssuesParams) => Promise<BoardIssuesFetch>
  readonly readItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly readItemStates: (params: ItemStatesParams) => Promise<ItemStatesRead>
  readonly readClaimPreflight: (params: ItemNumberParams) => Promise<ClaimPreflightFetch>
  readonly readGatePreflight: (params: ItemNumberParams) => Promise<GatePreflightFetch>
  readonly listBacklog: (params: BacklogListParams) => Promise<BacklogResponse>
  readonly readTicket: (params: ItemNumberParams) => Promise<BacklogDetailResponse>
  readonly readLedger: (params: LedgerParams) => Promise<LedgerRead>
  readonly precheck: (params: TrackerPrecheckParams) => Promise<GithubPrecheckOutcome>
  readonly forget: (repoId: RepoId) => void
  readonly postPlanBody: (params: PostCommentParams) => Promise<WriteOutcome>
}
