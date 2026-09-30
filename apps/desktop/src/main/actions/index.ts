// The public surface of the single-label operator actions (#94) and the
// plan gate/claim composition roots (#92) — no consumer imports `./apply`,
// `./resume`, `./claim`, or `./gate` directly, the mirror of
// `main/writes/index.ts`'s own re-export rail.
export { applyItemAction, defaultApplyItemActionDeps } from './apply'
export type { ApplyItemActionDeps, ApplyItemActionParams, ItemActionRequest, ReadyEntry } from './apply'

export { recoverPausedTrigger } from './resume'
export type { RecoverPausedTriggerParams, RecoverPausedTriggerResult } from './resume'

export { applyClaimLabels } from './claim'

export { defaultGateDeps, gateAnswer, gateClaimRead, gateClaimSet, gatePreflight } from './gate'
export type { GateAnswerParams, GateClaimReadParams, GateClaimSetParams, GateDeps, GatePreflightParams } from './gate'
