// The one notification decider. Fires only when no port window is focused — a missing nudge
// costs one glance, a spurious one trains the operator to ignore them.
import { BrowserWindow, Notification } from 'electron'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { IpcEventMap, IpcMap } from '@/types/ipc'
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

/** A stage session notifies only for a permission Needs you has no row for. */
export function notificationFor(previous: HostedSessionSnapshot | null, next: HostedSessionSnapshot, repoLabel: string): SessionNotification | null {
  if (previous === null) return null
  const title = sessionDisplayLabel(next, repoLabel)
  const isStage = next.stage !== null

  if (next.phase === 'ended' && previous.phase !== 'ended') {
    return isStage ? null : { kind: 'ended', title, body: endedBody(next) }
  }

  const previousIds = new Set(previous.pendingPermissions.map((p) => p.permissionId))
  const newPermission = next.pendingPermissions.find((p) => !previousIds.has(p.permissionId) && !(isStage && (p.interaction?.kind === 'question' || p.protectedPath !== null)))
  if (newPermission !== undefined) {
    return { kind: 'needs-you', title, body: `Allow or deny ${newPermission.toolName}: Claude is waiting for your permission.` }
  }

  if (!isStage && next.phase === 'ready' && (previous.phase === 'streaming' || previous.phase === 'interrupting') && next.pendingPermissions.length === 0) {
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

function focusFirstWindow(): void {
  const [window] = BrowserWindow.getAllWindows()
  if (window === undefined) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

interface AppNotifier extends SessionNotifier {
  /** Shows nothing while a port window is focused. A click opens Needs you with `focus` selected. */
  showNeedsYou(notification: IpcMap['notify:needs-you']['request']): void
}

/** The real notifier wired to Electron and the repo registry, kept out of `ipc.ts` for its size.
 *  A click focuses (and restores) the first window and asks it to open the session. */
export function createAppNotifier(params: { readonly registryDeps: RegistryDeps; readonly broadcast: (command: IpcEventMap['app:command']) => void }): AppNotifier {
  const isAppFocused = (): boolean => BrowserWindow.getFocusedWindow() !== null
  const sessionNotifier = createNotifier({
    isAppFocused,
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
        focusFirstWindow()
        params.broadcast({ kind: 'open-session', sessionKey: snapshot.sessionKey })
      })
      native.show()
    },
  })

  return {
    observe: (snapshot) => sessionNotifier.observe(snapshot),
    showNeedsYou: ({ title, body, focus }) => {
      if (isAppFocused() || !Notification.isSupported()) return
      const native = new Notification({ title, body })
      native.on('click', () => {
        focusFirstWindow()
        params.broadcast({ kind: 'open-needs-you', focus })
      })
      native.show()
    },
  }
}
