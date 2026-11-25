import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import type { LedgerRead } from '@/types/budget'
import type { ClaimPreflightFetch, FetchItemsByNumberParams, GatePreflightFetch, GitHubRepoRef, ItemsByNumberFetch, ItemStatesRead } from '@/types/github'
import type { GithubPrecheckOutcome } from '@/types/state'
import type { PostCommentParams, WriteOutcome } from '@/types/writes'
import type { RepoId } from '@/utils/repos'

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
