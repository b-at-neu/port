import type { PendingPermission, SessionKey, SessionOrigin } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'

interface SessionEntry {
  readonly repoId: RepoId | null
  /** This session's folder, for a null-`repoId` session's own display label. */
  readonly folder: string
  /** Carried alongside the pending list so the dialog names the session the same way the rail does. */
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
