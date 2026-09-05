// The public surface #79 imports — never `./sdk` or `./adapter` directly. A
// second reader spawning the SDK itself, or hand-rolling a second classifier,
// is exactly the drift this directory exists to prevent (ENGINEERING §1).
export type { ReadSessionStateParams } from './adapter'
export { readSessionState } from './adapter'

export type { RepoRef } from './classify'
export { PORT_STAGE_AGENTS } from './classify'

export type {
  Activity,
  AgentRecord,
  MetaProblem,
  MetaProblemKind,
  PortStageAgent,
  RoleEvidence,
  SessionFailureKind,
  SessionRecord,
  SessionRef,
  SessionRole,
  SessionScan,
} from '../../shared/sessions/types'
export { ACTIVE_WITHIN_MS, IDLE_WITHIN_MS } from '../../shared/sessions/types'
