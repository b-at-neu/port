// The one notification decider. Fires only when no port window is focused — a missing nudge
// costs one glance, a spurious one trains the operator to ignore them.
import type { Platform } from '@/main/platform'
import type { Repos } from '@/main/repos'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { NeedsYouNotification } from '@/types/settings'
import type { AppCommand } from '@/utils/shell/commands'
import { DEFAULT_NOTIFICATION_PREFS } from '@/types/settings'
import type { NotificationPrefs } from '@/types/settings'
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

async function readPrefs(prefs: () => Promise<NotificationPrefs>): Promise<NotificationPrefs> {
  try {
    return await prefs()
  } catch {
    return DEFAULT_NOTIFICATION_PREFS
  }
}

interface NotifierContext extends Pick<Platform, 'notify'> {
  readonly repos: Pick<Repos, 'list'>
  readonly emit: (event: 'app.command', payload: AppCommand) => void
}

interface Notifier {
  /** Shows only when unfocused; a focused transition still updates the baseline, so focusing then blurring never replays it. */
  observe(snapshot: HostedSessionSnapshot): void
  /** Shows nothing while a port window is focused. A click opens Needs you with `focus` selected. */
  showNeedsYou(notification: NeedsYouNotification): void
}

/** A click focuses (and restores) the first window and asks it to open the session. `prefs` is read only when a notification is about to fire; a rejection reads as everything on. */
export function createNotifier(ctx: NotifierContext, prefs: () => Promise<NotificationPrefs>): Notifier {
  const lastSeen = new Map<string, HostedSessionSnapshot>()

  // Resolved only when a notification is actually about to fire — a registry lookup is too slow to run on every snapshot.
  async function repoLabel(snapshot: HostedSessionSnapshot): Promise<string> {
    if (snapshot.repoId === null) return folderLabel(snapshot.workspace.folder)
    const list = await ctx.repos.list()
    const entry = list.ok ? list.repositories.find((r) => r.id === snapshot.repoId) : undefined
    return repoDisplayLabel(entry, snapshot.workspace.folder)
  }

  function show(notification: SessionNotification, snapshot: HostedSessionSnapshot): void {
    ctx.notify.show({ title: notification.title, body: notification.body }, () => ctx.emit('app.command', { kind: 'open-session', sessionKey: snapshot.sessionKey }))
  }

  return {
    observe(snapshot) {
      const previous = lastSeen.get(snapshot.sessionKey) ?? null
      if (snapshot.phase === 'ended') lastSeen.delete(snapshot.sessionKey)
      else lastSeen.set(snapshot.sessionKey, snapshot)

      // A placeholder label decides only whether something would fire; the real label is
      // resolved below, only on that path, and used for the title that's actually shown.
      const wouldNotify = notificationFor(previous, snapshot, '') !== null
      if (!wouldNotify || ctx.notify.focused()) return

      void readPrefs(prefs).then((resolved) => {
        if (!resolved.sessions) return
        return repoLabel(snapshot).then(
          (label) => {
            const notification = notificationFor(previous, snapshot, label)
            if (notification !== null) show(notification, snapshot)
          },
          () => {
            const notification = notificationFor(previous, snapshot, folderLabel(snapshot.workspace.folder))
            if (notification !== null) show(notification, snapshot)
          }
        )
      })
    },
    showNeedsYou: ({ title, body, focus }) => {
      if (ctx.notify.focused()) return
      void readPrefs(prefs).then((resolved) => {
        if (!resolved.needsYou) return
        ctx.notify.show({ title, body }, () => ctx.emit('app.command', { kind: 'open-needs-you', focus }))
      })
    },
  }
}
