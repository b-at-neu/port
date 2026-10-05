// The public surface `main/state/watcher.ts` imports — never `./plan`,
// `./ledger`, `./routing`, or the engine's own decision modules directly.
// #348: the app no longer keeps its own copies of ownership/liveness/
// contention/gates/checks — it imports scripts/port-tick/'s own typed
// exports (docs/ENGINEERING.md §1), re-exported here unchanged so every
// existing caller of this barrel stays the same.
export { planTick } from './plan'
export type { PlanTickParams } from './plan'

export { dispatchableFrom, observableFrom } from './dispatchable'

export { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from './ledger'
export type { DispatchLedger, RefreshMemo, UnknownStreaks } from './ledger'

export { AGENT_FOR_IN_FLIGHT, AGENT_FOR_TRIGGER, REFRESH_PAIR } from './routing'

export { classifyUnmatched, RETRY_TRIGGER } from '../../../../../scripts/port-tick/liveness'
export type { LedgerRow, LedgerState, UnmatchedClass, UnmatchedResult } from '../../../../../scripts/port-tick/liveness'

export { partitionOwnership } from '../../../../../scripts/port-tick/classify'
export type { OwnershipPartition } from '../../../../../scripts/port-tick/classify'

export { parseFilesBlock, gateCandidates } from '../../../../../scripts/port-tick/contention'
export type { ClaimedItem, OccupiedEntry, GateHeld, GateResult } from '../../../../../scripts/port-tick/contention'

export { approvedReverify, capRefreshes, codeReviewCount, cycleCapExceeded, zeroDiffGate, mergeabilityRoute, refreshDecision, refreshWins } from '../../../../../scripts/port-tick/gates'
export type { ApprovedReverifyResult, ApprovedReverifyVerdict, CommentNode, MergeabilityAction, RefreshCandidate, RefreshDecisionResult, RefreshMemoEntry, RefreshWinsResult, ReviewNode, ZeroDiffAction } from '../../../../../scripts/port-tick/gates'

export { conclusionOf, isConcluded, reduceRollup, rollupVerdict } from '../../../../../scripts/port-tick/checks'
export type { CheckContext, Disposition, RollupVerdict } from '../../../../../scripts/port-tick/checks'

export { observationsOf } from './observe'
export type { ObservationsOfParams } from './observe'
