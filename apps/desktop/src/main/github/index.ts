// The public surface #79 imports — never `../platform/gh` directly. A second
// adapter that spawns `gh` itself, or hand-rolls a second failure
// classifier, is exactly the drift `apps/desktop/src/main/platform/` and
// this directory exist to prevent (ENGINEERING §1).
export type { FetchClaimPreflightParams, FetchItemsByNumberParams, FetchItemStatesParams, FetchPipelineItemsParams, GhRunner, RepoRef } from './adapter'
export { applyItemStates, fetchClaimPreflight, fetchItemsByNumber, fetchItemStates, fetchPipelineItems } from './adapter'

export { fetchGatePreflight } from './gate'
export type { FetchGatePreflightParams } from './gate'

export type {
  BlockerRead,
  ClaimBlocker,
  ClaimPreflightFetch,
  ClaimPreflightItem,
  GatePreflightFetch,
  GatePreflightItem,
  ItemRef,
  ItemsByNumberFetch,
  ItemState,
  ItemStatesFetch,
  PipelineFailureKind,
  PipelineFetch,
  PipelineItem,
  PipelineItemKind,
  QueriedLabel,
  RateLimitInfo,
  ResolvedItem,
  TruncatedSet,
  UnavailableAlias,
} from '../../shared/github/types'
