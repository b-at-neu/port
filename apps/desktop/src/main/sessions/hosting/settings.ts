import type { HostedSessionSnapshot, HostingCapacity, HostingPersistence, MintedRestorable, SessionDefaults, SessionMarkResult, SessionMarks, SessionMarksTracker, SessionRestoreDiscardResult } from '@/types/hosting'
import { DEFAULT_SESSION_DEFAULTS } from '@/types/hosting'
import { DEFAULT_NOTIFICATION_PREFS } from '@/types/settings'
import type { NotificationPrefs } from '@/types/settings'
import { createSessionMarks } from '@/main/sessions/hosting/marks'
import { DEFAULT_SESSION_LIMIT, SESSION_LIMIT_CEILING } from '@/main/sessions/hosting/persist'
import { dropAdopted, mintRestorable, nextPersisted, persistedOpen } from '@/main/sessions/hosting/restore'

export interface HostingSettings {
  /** Loads the persisted state once; every read and write below waits on it. */
  readonly ensureLoaded: () => Promise<void>
  /** Persists the limit, defaults, marks, notification prefs and restorable list beside the live sessions. */
  readonly save: () => void
  /** The loaded limit and defaults, valid once `ensureLoaded` has resolved. */
  readonly limit: () => number
  readonly sessionDefaults: () => SessionDefaults
  readonly capacity: () => Promise<HostingCapacity>
  readonly setLimit: (next: number) => Promise<HostingCapacity>
  readonly defaults: () => Promise<SessionDefaults>
  readonly setDefaults: (next: SessionDefaults) => Promise<SessionDefaults>
  readonly notificationPrefs: () => Promise<NotificationPrefs>
  readonly setNotificationPrefs: (next: NotificationPrefs) => Promise<NotificationPrefs>
  readonly marks: () => Promise<SessionMarks>
  readonly setMark: (kind: 'pinned' | 'archived', sessionId: string, on: boolean) => Promise<SessionMarkResult>
  readonly restorableList: () => Promise<readonly MintedRestorable[]>
  readonly findRestorable: (restoreId: string) => MintedRestorable | undefined
  /** A session that adopted this Claude session id is no longer restorable. */
  readonly dropAdopted: (claudeSessionId: string) => void
  readonly removeRestorable: (restoreId: string) => void
  readonly discardRestorable: (restoreId: string | null) => Promise<SessionRestoreDiscardResult>
}

export function createHostingSettings(persistence: HostingPersistence, live: () => readonly HostedSessionSnapshot[]): HostingSettings {
  let limit = DEFAULT_SESSION_LIMIT
  let defaults: SessionDefaults = DEFAULT_SESSION_DEFAULTS
  let notifications: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS
  let restorable: readonly MintedRestorable[] = []
  let marksTracker: SessionMarksTracker = createSessionMarks({ pinned: [], archived: [] })
  let loaded: Promise<void> | null = null

  function ensureLoaded(): Promise<void> {
    if (loaded === null) {
      loaded = persistence.load().then((state) => {
        limit = state.limit
        restorable = mintRestorable(state.open)
        defaults = state.defaults
        notifications = state.notifications
        marksTracker = createSessionMarks(state.marks)
      })
    }
    return loaded
  }

  function save(): void {
    persistence.save({ ...nextPersisted({ limit, live: persistedOpen(live()), restorable }), defaults, marks: marksTracker.current(), notifications })
  }

  async function capacity(): Promise<HostingCapacity> {
    await ensureLoaded()
    return { limit, ceiling: SESSION_LIMIT_CEILING }
  }

  async function setLimit(next: number): Promise<HostingCapacity> {
    await ensureLoaded()
    limit = next
    save()
    return { limit, ceiling: SESSION_LIMIT_CEILING }
  }

  async function setMark(kind: 'pinned' | 'archived', sessionId: string, on: boolean): Promise<SessionMarkResult> {
    await ensureLoaded()
    if (sessionId === '' || sessionId.length > 200) return { ok: false, kind: 'invalid-session-id' }
    const result = marksTracker.set(kind, sessionId, on)
    save()
    return { ok: true, marks: result }
  }

  return {
    ensureLoaded,
    save,
    limit: () => limit,
    sessionDefaults: () => defaults,
    capacity,
    setLimit,
    defaults: async () => {
      await ensureLoaded()
      return defaults
    },
    setDefaults: async (next) => {
      await ensureLoaded()
      defaults = next
      save()
      return defaults
    },
    notificationPrefs: async () => {
      await ensureLoaded()
      return notifications
    },
    setNotificationPrefs: async (next) => {
      await ensureLoaded()
      notifications = next
      save()
      return notifications
    },
    marks: async () => {
      await ensureLoaded()
      return marksTracker.current()
    },
    setMark,
    restorableList: async () => {
      await ensureLoaded()
      return restorable
    },
    findRestorable: (restoreId) => restorable.find((candidate) => candidate.restoreId === restoreId),
    dropAdopted: (claudeSessionId) => {
      restorable = dropAdopted(restorable, claudeSessionId)
    },
    removeRestorable: (restoreId) => {
      restorable = restorable.filter((candidate) => candidate.restoreId !== restoreId)
      save()
    },
    discardRestorable: async (restoreId) => {
      await ensureLoaded()
      restorable = restoreId === null ? [] : restorable.filter((candidate) => candidate.restoreId !== restoreId)
      save()
      return { ok: true }
    },
  }
}
