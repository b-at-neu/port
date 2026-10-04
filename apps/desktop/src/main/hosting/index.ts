// #98/#103: the public surface `main/channels/hosting.ts` and
// `main/index.ts` import — never `./handle`, `./store`, `./options`,
// `./classify`, `./sdk`, `./fork`, `./persist`, `./restore`, or `./input`
// directly.
export { createHostedStore, defaultHostedStoreDeps, DEFAULT_SESSION_LIMIT, ENDED_RETAIN_LIMIT, SESSION_LIMIT_CEILING } from './store'
export type { HostedStore, HostedStoreDeps, StartSessionParams } from './store'

export { createHostingPersistence } from './persist'
export type { HostingPersistedState, HostingPersistence, PersistedOpenEntry } from './persist'

export type {
  AgentSummary,
  CommandSummary,
  ComponentCheck,
  HostedSessionSnapshot,
  HostedTask,
  HostingCapacity,
  LiveBlock,
  LiveBlockKind,
  PartialUpdate,
  PendingPermission,
  PermissionDecision,
  PluginLoad,
  PluginRequest,
  RestorableSession,
  SessionAttachResult,
  SessionCapabilities,
  SessionCloseResult,
  SessionDismissResult,
  SessionEnd,
  SessionEndReason,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionGrantItem,
  SessionInterruptResult,
  SessionInvokeResult,
  SessionKey,
  SessionOrigin,
  SessionPermissionAnswerResult,
  SessionPhase,
  SessionRateLimit,
  SessionRestoreDiscardResult,
  SessionRestoreResult,
  SessionRole,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
} from '../../shared/hosting/types'
export { PERMISSION_DECISIONS } from '../../shared/hosting/types'

// #265: the dispatcher role's own options shape — `dispatch/dispatcher.ts`
// is the one caller outside this directory that ever names it.
export type { SessionOptionsRole } from './options'

// #219: the live projector — the public surface for main/hosting/handle.ts
// and main/hosting/store.ts, never imported directly from ./project.
export { createSessionProjector, ENTRY_RETAIN_LIMIT } from './project'
export type { SessionProjector, SessionProjectorWindow } from './project'
