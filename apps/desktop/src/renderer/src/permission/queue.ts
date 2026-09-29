// #99: the cross-session permission queue — pure, no DOM. This file is the
// whole dead-prompt rule: nothing is on screen that the latest snapshot for
// its session does not list. `applySnapshot` replaces that session's
// entries wholesale (an `ended` snapshot, or one with no pending requests,
// clears them), so a request withdrawn by an interrupt, a session end, or
// an SDK-side cancel disappears on the very next `session:status` push.
import type { HostedSessionSnapshot, PendingPermission, SessionKey } from '../../../shared/hosting/types'
import type { RepoId } from '../../../shared/repos'

interface SessionEntry {
  readonly repoId: RepoId
  readonly permissions: readonly PendingPermission[]
}

export type PermissionQueue = ReadonlyMap<SessionKey, SessionEntry>

export const EMPTY_QUEUE: PermissionQueue = new Map()

export interface QueuedPermission {
  readonly sessionKey: SessionKey
  readonly repoId: RepoId
  readonly permission: PendingPermission
}

/** Folds one snapshot into the queue — the whole update unit `session:status`
 *  and `session:list` both use, so seeding from a boot-time list and
 *  applying a live push are the same operation repeated once per entry. */
export function applySnapshot(queue: PermissionQueue, snapshot: HostedSessionSnapshot): PermissionQueue {
  const next = new Map(queue)
  if (snapshot.pendingPermissions.length === 0) {
    next.delete(snapshot.sessionKey)
  } else {
    next.set(snapshot.sessionKey, { repoId: snapshot.repoId, permissions: snapshot.pendingPermissions })
  }
  return next
}

/** For boot (`session:list`) and for a renderer reload — every pending
 *  request reappears in its original order because `applySnapshot` is
 *  folded left to right over the same list a fresh render would use. */
export function seed(snapshots: readonly HostedSessionSnapshot[]): PermissionQueue {
  let queue: PermissionQueue = EMPTY_QUEUE
  for (const snapshot of snapshots) queue = applySnapshot(queue, snapshot)
  return queue
}

/** Oldest `requestedAt` first across every session, `permissionId` as a
 *  stable tiebreak — the single ordering the dialog, the "1 of n waiting"
 *  counter, and the document title all read from. */
export function ordered(queue: PermissionQueue): readonly QueuedPermission[] {
  const items: QueuedPermission[] = []
  for (const [sessionKey, entry] of queue) {
    for (const permission of entry.permissions) {
      items.push({ sessionKey, repoId: entry.repoId, permission })
    }
  }
  items.sort((a, b) => {
    const byTime = a.permission.requestedAt.localeCompare(b.permission.requestedAt)
    return byTime !== 0 ? byTime : a.permission.permissionId.localeCompare(b.permission.permissionId)
  })
  return items
}
