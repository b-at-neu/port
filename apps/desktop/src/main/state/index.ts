// The public surface #80 imports — never `../github`, `../local`, or
// `../sessions` directly. This directory composes those three adapters plus
// the registry's own `RepositoryEntry`; a second reader reaching around it
// is exactly the drift this module exists to prevent (ENGINEERING §1).
export { readPipelineState } from './read'
export type { ReadPipelineStateParams } from './read'

export { reconcileRepository } from './reconcile'
export type { ReconcileRepositoryInput, RepoSessionSlice } from './reconcile'

export { stageOf, STAGE_PRECEDENCE } from './stage'
export { closingReference, sessionRequiredAt, SESSION_REQUIRED_PREFIX } from './link'
export { attachAgents, attachSessions, attachWorktrees, collectOrphanNumbers } from './attach'
export type { AttachTarget } from './attach'

export type {
  AgentAttachMatch,
  AttachedAgent,
  AttachedSession,
  AttachedWorktree,
  FreshnessEntry,
  ItemStatus,
  LinkReason,
  OrphanItem,
  OrphanReason,
  PipelineState,
  ReconciledItem,
  RepositoryFreshness,
  RepositoryState,
  StageLabel,
  StageResult,
  StatusEvidence,
  WaitingOn,
} from '../../shared/state/types'
