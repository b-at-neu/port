import type { HostedSessionSnapshot, PendingPermission, PermissionDecision, SessionKey, SessionOrigin, SessionPermissionAnswerResult } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'

interface SessionEntry {
  readonly repoId: RepoId | null
  /** This session's folder, for a null-`repoId` session's own display label. */
  readonly folder: string
  /** #103: carried alongside the pending list so the dialog's context line
   *  can name the session with the same `sessionDisplayLabel` the rail
   *  shows — never the raw `sessionKey`. */
  readonly title: string | null
  readonly origin: SessionOrigin
  readonly startedAt: string
  readonly permissions: readonly PendingPermission[]
}

export type PermissionQueue = ReadonlyMap<SessionKey, SessionEntry>

export interface QueuedPermission {
  readonly sessionKey: SessionKey
  readonly repoId: RepoId | null
  readonly folder: string
  readonly title: string | null
  readonly origin: SessionOrigin
  readonly startedAt: string
  readonly permission: PendingPermission
}

export interface PermissionStoreDeps {
  readonly answerPermission: (params: { readonly sessionKey: QueuedPermission['sessionKey']; readonly permissionId: string; readonly decision: PermissionDecision; readonly message: string | null }) => Promise<SessionPermissionAnswerResult>
  readonly sessionList: () => Promise<readonly HostedSessionSnapshot[]>
  readonly subscribeSessionStatus: (listener: (snapshot: HostedSessionSnapshot) => void) => () => void
  readonly now: () => number
  readonly setDocumentTitle: (title: string) => void
}
