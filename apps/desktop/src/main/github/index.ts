// The public surface #79 imports — never `../platform/gh` directly. A second
// adapter that spawns `gh` itself, or hand-rolls a second failure
// classifier, is exactly the drift `apps/desktop/src/main/platform/` and
// this directory exist to prevent (ENGINEERING §1).
export type { FetchItemsByNumberParams, FetchItemStatesParams, FetchPipelineItemsParams, GhRunner, RepoRef } from './adapter'
export { applyItemStates, fetchItemsByNumber, fetchItemStates, fetchPipelineItems } from './adapter'

export type {
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
