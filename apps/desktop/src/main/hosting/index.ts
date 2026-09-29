// #98: the public surface `main/channels/hosting.ts` and `main/index.ts`
// import — never `./handle`, `./store`, `./options`, `./classify`, `./sdk`,
// `./fork`, or `./input` directly.
export { createHostedStore, defaultHostedStoreDeps, MAX_HOSTED_SESSIONS } from './store'
export type { HostedStore, HostedStoreDeps, StartSessionParams } from './store'

export type {
  HostedSessionSnapshot,
  PendingPermission,
  PermissionDecision,
  SessionAttachResult,
  SessionCloseResult,
  SessionEnd,
  SessionEndReason,
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
