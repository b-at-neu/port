// The dispatch module's public surface (#110) — no consumer imports
// `./store`, `./halt`, or `./resolve` directly, the same rail
// `main/writes/index.ts` and `main/actions/index.ts` already follow.
export { createDrainStore } from './store'
export type { DrainStore, SetDrainResult } from './store'

export { defaultHaltDispatchDeps, haltDispatch } from './halt'
export type { HaltDispatchDeps, HaltDispatchParams } from './halt'

export { resolveDispatchControl } from './resolve'
export type { ResolveDispatchControlDeps } from './resolve'
