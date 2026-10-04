// The dispatch module's public surface (#110, #265) — no consumer imports
// `./store`, `./halt`, `./resolve`, `./dispatcher`, `./turn`, or `./select`
// directly, the same rail `main/writes/index.ts` and `main/actions/index.ts`
// already follow.
export { createRunStateStore } from './store'
export type { RunStateStore, SetRunStateResult } from './store'

export { defaultHaltDispatchDeps, haltDispatch } from './halt'
export type { HaltDispatchDeps, HaltDispatchParams } from './halt'

export { registeredRepoIds, resolveDispatchClaimSet, resolveDispatchControl, resolveDispatchRelay } from './resolve'
export type { ResolveDispatchClaimSetDeps, ResolveDispatchControlDeps, ResolveDispatchRelayDeps } from './resolve'

export { createDispatcher } from './dispatcher'
export type { CreateDispatcherParams, Dispatcher } from './dispatcher'

export { createDispatchRuntime } from './runtime'
export type { DispatchRuntime } from './runtime'

export { composeDispatchTurn, composeRelayTurn, DISPATCH_PROMPT, DISPATCHER_INSTRUCTIONS, DISPATCHER_MODEL, missingAgentOf, REFRESH_PROMPT, specFor } from './turn'
export type { DispatchSpec } from './turn'

export { confirmStarted, markUnconfirmed, REDISPATCH_FLOOR_MS, selectDispatches } from './select'
export type { ConfirmStartedResult, SelectDispatchesParams } from './select'

export { BUDGET_SESSION, BUDGET_VERDICTS, budgetLiveSets, budgetRoute, dispatchArgs, escalationBody, OUTDATED_SCRIPT_SENTINEL, parseSweepLine, parseVerdict, resetArgs, sweepArgs } from './budget'
export type { BudgetVerdict } from './budget'

export { createBudgetGate } from './budget-gate'
export type { BudgetCheckResult, BudgetGate, BudgetGateFailure, BudgetResetResult, BudgetSweepResult, NodeRunner as BudgetNodeRunner } from './budget-gate'

export { observationWrite } from './observation'
export type { ObservationWritePlan, WriteObservation } from './observation'
