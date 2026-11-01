// `notify:needs-you` — validates the renderer's notification request, then hands it to the one shower.
import type { IpcMap } from '@/types/ipc'
import type { NotifyChannelDeps, NotifyPrefsDeps } from '@/types/channels'
import type { NotificationPrefs } from '@/types/settings'

export const MAX_NOTIFICATION_TEXT = 200

function requireText(value: unknown, field: 'title' | 'body'): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_NOTIFICATION_TEXT) {
    throw new Error(`'notify:needs-you' requires '${field}' to be a non-empty string of at most ${String(MAX_NOTIFICATION_TEXT)} characters`)
  }
  return value
}

export function resolveNotifyNeedsYou(request: IpcMap['notify:needs-you']['request'], deps: NotifyChannelDeps): void {
  const title = requireText(request?.title, 'title')
  const body = requireText(request?.body, 'body')
  const focus: unknown = request.focus
  if (focus !== null && typeof focus !== 'string') throw new Error("'notify:needs-you' requires 'focus' to be a string or null")
  deps.show({ title, body, focus })
}

export function resolveNotifyPrefs(request: IpcMap['notify:prefs']['request'], deps: NotifyPrefsDeps): Promise<NotificationPrefs> {
  if (request !== undefined) throw new Error("'notify:prefs' takes no payload")
  return deps.prefs()
}

export function resolveNotifyPrefsSet(request: IpcMap['notify:prefs:set']['request'], deps: NotifyPrefsDeps): Promise<NotificationPrefs> {
  const needsYou: unknown = request?.needsYou
  const sessions: unknown = request?.sessions
  if (typeof needsYou !== 'boolean' || typeof sessions !== 'boolean') throw new Error("'notify:prefs:set' requires 'needsYou' and 'sessions' to be booleans")
  return deps.setPrefs({ needsYou, sessions })
}
