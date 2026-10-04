// The public surface `main/state/watcher.ts` imports — never `./plan`,
// `./ledger`, `./ownership`, `./liveness`, `./routing`, or `./contention`
// directly.
export { planTick } from './plan'
export type { PlanTickParams } from './plan'

export { dispatchableFrom, observableFrom } from './dispatchable'

export { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from './ledger'
export type { DispatchLedger, RefreshMemo, UnknownStreaks } from './ledger'

export { AGENT_FOR_IN_FLIGHT, AGENT_FOR_TRIGGER, REFRESH_PAIR } from './routing'

export { classifyUnmatched, RETRY_TRIGGER } from './liveness'
export type { LedgerRow, LedgerState, UnmatchedClass, UnmatchedResult } from './liveness'

export { partitionOwnership } from './ownership'
export type { OwnershipItem, OwnershipPartition } from './ownership'

export { parseFilesBlock, gateCandidates } from './contention'
export type { ClaimedItem, OccupiedEntry, GateHeld, GateResult } from './contention'

export { approvedReverify, capRefreshes, cycleCapExceeded, zeroDiffGate, codeReviewCount, mergeabilityRoute, refreshDecision, refreshWins } from './gates'
export type { ApprovedReverifyResult, ApprovedReverifyVerdict, CommentNode, MergeabilityAction, RefreshCandidate, RefreshDecisionResult, RefreshMemoEntry, RefreshWinsResult, ReviewNode, ZeroDiffAction } from './gates'

export { conclusionOf, isConcluded, reduceRollup, rollupVerdict } from './checks'
export type { Disposition, RollupVerdict } from './checks'

export { observationsOf } from './observe'
export type { ObservationsOfParams } from './observe'
