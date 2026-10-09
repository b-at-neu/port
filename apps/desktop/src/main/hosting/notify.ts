// The one notification decider: pure notificationFor() over consecutive snapshots, plus
// createNotifier()'s baseline tracker. Fires only when no port window is focused — a missing
// nudge costs one glance, a spurious one trains the operator to ignore them (docs/ENGINEERING.md §4).
import type { HostedSessionSnapshot } from '../../shared/hosting/types'
import { sessionDisplayLabel } from '../../shared/hosting/label'

export type NotificationKind = 'needs-you' | 'finished' | 'ended'

export interface SessionNotification {
  readonly kind: NotificationKind
  readonly title: string
  readonly body: string
}

function endedBody(snapshot: HostedSessionSnapshot): string {
  return snapshot.end?.reason === 'completed' ? 'The session ended.' : 'The session ended unexpectedly. Open it to see why.'
}

/** `previous === null` (the first snapshot of a session) never notifies. */
export function notificationFor(previous: HostedSessionSnapshot | null, next: HostedSessionSnapshot, repoLabel: string): SessionNotification | null {
  if (previous === null) return null
  const title = sessionDisplayLabel(next, repoLabel)

  if (next.phase === 'ended' && previous.phase !== 'ended') {
    return { kind: 'ended', title, body: endedBody(next) }
  }

  const previousIds = new Set(previous.pendingPermissions.map((p) => p.permissionId))
  const newPermission = next.pendingPermissions.find((p) => !previousIds.has(p.permissionId))
  if (newPermission !== undefined) {
    return { kind: 'needs-you', title, body: `Allow or deny ${newPermission.toolName}: Claude is waiting for your permission.` }
  }

  if ((next.phase === 'streaming' || next.phase === 'interrupting') === false && (previous.phase === 'streaming' || previous.phase === 'interrupting') && next.pendingPermissions.length === 0) {
    return { kind: 'finished', title, body: "Claude finished. Reply when you're ready." }
  }

  return null
}

export interface CreateNotifierParams {
  readonly isAppFocused: () => boolean
  readonly show: (notification: SessionNotification, snapshot: HostedSessionSnapshot) => void
  readonly repoLabel: (snapshot: HostedSessionSnapshot) => string
}

export interface SessionNotifier {
  /** Computes the transition against this session's last-seen snapshot, and calls `show` only
   *  when `isAppFocused()` is false. A focused transition still updates the baseline, so
   *  focusing then blurring never replays it. */
  observe(snapshot: HostedSessionSnapshot): void
}

export function createNotifier(params: CreateNotifierParams): SessionNotifier {
  const lastSeen = new Map<string, HostedSessionSnapshot>()

  return {
    observe(snapshot) {
      const previous = lastSeen.get(snapshot.sessionKey) ?? null
      if (snapshot.phase === 'ended') lastSeen.delete(snapshot.sessionKey)
      else lastSeen.set(snapshot.sessionKey, snapshot)

      const notification = notificationFor(previous, snapshot, params.repoLabel(snapshot))
      if (notification !== null && !params.isAppFocused()) params.show(notification, snapshot)
    },
  }
}
