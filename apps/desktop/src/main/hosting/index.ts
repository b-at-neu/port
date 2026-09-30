// #98: the public surface `main/channels/hosting.ts` and `main/index.ts`
// import — never `./handle`, `./store`, `./options`, `./classify`, `./sdk`,
// `./fork`, or `./input` directly.
export { createHostedStore, defaultHostedStoreDeps, MAX_HOSTED_SESSIONS } from './store'
export type { HostedStore, HostedStoreDeps, StartSessionParams } from './store'

export type {
  HostedSessionSnapshot,
  LiveBlock,
  LiveBlockKind,
  PartialUpdate,
  PendingPermission,
  PermissionDecision,
  SessionAttachResult,
  SessionCloseResult,
  SessionEnd,
  SessionEndReason,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionGrantItem,
  SessionInterruptResult,
  SessionKey,
  SessionOrigin,
  SessionPermissionAnswerResult,
  SessionPhase,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
} from '../../shared/hosting/types'
export { PERMISSION_DECISIONS } from '../../shared/hosting/types'

// #219: the live projector — the public surface for main/hosting/handle.ts
// and main/hosting/store.ts, never imported directly from ./project.
export { createSessionProjector, ENTRY_RETAIN_LIMIT } from './project'
export type { SessionProjector, SessionProjectorWindow } from './project'
