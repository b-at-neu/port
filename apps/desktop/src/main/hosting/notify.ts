// The one notification decider. Fires only when no port window is focused — a missing nudge
// costs one glance, a spurious one trains the operator to ignore them.
import { BrowserWindow, Notification } from 'electron'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { IpcEventMap } from '@/types/ipc'
import type { RegistryDeps } from '@/types/registry'
import { listRepositories } from '@/main/registry'
import { sessionDisplayLabel } from '@/utils/hosting/label'
import { folderLabel, repoDisplayLabel } from '@/utils/workspace/label'

type NotificationKind = 'needs-you' | 'finished' | 'ended'

interface SessionNotification {
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

  if (next.phase === 'ready' && (previous.phase === 'streaming' || previous.phase === 'interrupting') && next.pendingPermissions.length === 0) {
    return { kind: 'finished', title, body: "Claude finished. Reply when you're ready." }
  }

  return null
}

interface CreateNotifierParams {
  readonly isAppFocused: () => boolean
  readonly show: (notification: SessionNotification, snapshot: HostedSessionSnapshot) => void
  /** Resolved only when a notification is actually about to fire — a registry lookup is too
   *  slow to run on every snapshot, and most snapshots notify nothing. */
  readonly repoLabel: (snapshot: HostedSessionSnapshot) => Promise<string>
}

interface SessionNotifier {
  /** Calls `show` only when unfocused; a focused transition still updates the baseline, so focusing then blurring never replays it. */
  observe(snapshot: HostedSessionSnapshot): void
}

export function createNotifier(params: CreateNotifierParams): SessionNotifier {
  const lastSeen = new Map<string, HostedSessionSnapshot>()

  return {
    observe(snapshot) {
      const previous = lastSeen.get(snapshot.sessionKey) ?? null
      if (snapshot.phase === 'ended') lastSeen.delete(snapshot.sessionKey)
      else lastSeen.set(snapshot.sessionKey, snapshot)

      // A placeholder label decides only whether something would fire; the real label is
      // resolved below, only on that path, and used for the title that's actually shown.
      const wouldNotify = notificationFor(previous, snapshot, '') !== null
      if (!wouldNotify || params.isAppFocused()) return

      void params.repoLabel(snapshot).then(
        (label) => {
          const notification = notificationFor(previous, snapshot, label)
          if (notification !== null) params.show(notification, snapshot)
        },
        () => {
          const notification = notificationFor(previous, snapshot, folderLabel(snapshot.workspace.folder))
          if (notification !== null) params.show(notification, snapshot)
        }
      )
    },
  }
}

/** The real notifier wired to Electron and the repo registry, kept out of `ipc.ts` for its size.
 *  A click focuses (and restores) the first window and asks it to open the session. */
export function createAppNotifier(params: { readonly registryDeps: RegistryDeps; readonly broadcast: (command: IpcEventMap['app:command']) => void }): SessionNotifier {
  return createNotifier({
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    repoLabel: async (snapshot) => {
      if (snapshot.repoId === null) return folderLabel(snapshot.workspace.folder)
      const list = await listRepositories(params.registryDeps)
      const entry = list.ok ? list.repositories.find((r) => r.id === snapshot.repoId) : undefined
      return repoDisplayLabel(entry, snapshot.workspace.folder)
    },
    show: (notification, snapshot) => {
      if (!Notification.isSupported()) return
      const native = new Notification({ title: notification.title, body: notification.body })
      native.on('click', () => {
        const [window] = BrowserWindow.getAllWindows()
        if (window !== undefined) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        params.broadcast({ kind: 'open-session', sessionKey: snapshot.sessionKey })
      })
      native.show()
    },
  })
}
