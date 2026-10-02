// The dispatch module's public surface (#110, #265) — no consumer imports
// `./store`, `./halt`, `./resolve`, `./dispatcher`, `./turn`, or `./select`
// directly, the same rail `main/writes/index.ts` and `main/actions/index.ts`
// already follow.
export { createDrainStore } from './store'
export type { DrainStore, SetDrainResult } from './store'

export { defaultHaltDispatchDeps, haltDispatch } from './halt'
export type { HaltDispatchDeps, HaltDispatchParams } from './halt'

export { resolveDispatchClaimSet, resolveDispatchControl, resolveDispatchRelay } from './resolve'
export type { ResolveDispatchClaimSetDeps, ResolveDispatchControlDeps, ResolveDispatchRelayDeps } from './resolve'

export { createDispatcher } from './dispatcher'
export type { CreateDispatcherParams, Dispatcher } from './dispatcher'

export { createDispatchRuntime } from './runtime'
export type { DispatchRuntime } from './runtime'

export { composeDispatchTurn, composeRelayTurn, DISPATCH_PROMPT, DISPATCHER_INSTRUCTIONS, DISPATCHER_MODEL, missingAgentOf, REFRESH_PROMPT, specFor } from './turn'
export type { DispatchSpec } from './turn'

export { confirmStarted, markUnconfirmed, REDISPATCH_FLOOR_MS, selectDispatches } from './select'
export type { ConfirmStartedResult, SelectDispatchesParams } from './select'
