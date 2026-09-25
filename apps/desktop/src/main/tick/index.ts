// The public surface `main/state/watcher.ts` imports — never `./plan`,
// `./ledger`, `./ownership`, `./liveness`, `./routing`, or `./contention`
// directly.
export { planTick } from './plan'
export type { PlanTickParams } from './plan'

export { createDispatchLedger } from './ledger'
export type { DispatchLedger } from './ledger'

export { AGENT_FOR_TRIGGER } from './routing'

export { classifyUnmatched, RETRY_TRIGGER } from './liveness'
export type { LedgerRow, LedgerState, UnmatchedClass, UnmatchedResult } from './liveness'

export { partitionOwnership } from './ownership'
export type { OwnershipItem, OwnershipPartition } from './ownership'

export { parseFilesBlock, gateCandidates } from './contention'
export type { ClaimedItem, OccupiedEntry, GateHeld, GateResult } from './contention'
