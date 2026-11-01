// hosting.json's only writer: recoverable app state, so a missing or malformed file resolves to
// an empty state rather than refusing to load. Pinned as the sole writer by desktop-hosting.ts.
import { DEFAULT_SESSION_DEFAULTS, SESSION_MODELS, SESSION_PERMISSION_MODES } from '@/types/hosting'
import type { SessionDefaults, SessionMarks, SessionModel, SessionPermissionMode } from '@/types/hosting'
import { DEFAULT_NOTIFICATION_PREFS } from '@/types/settings'
import type { NotificationPrefs } from '@/types/settings'
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '@/main/platform/files'
import { pathOps } from '@/main/platform/paths'
import type { HostingPersistedState, HostingPersistence, PersistedOpenEntry } from '@/types/hosting'

const HOSTING_FILE = 'hosting.json'
const CURRENT_VERSION = 1

/** Default `limit` for a fresh or unrecoverable state, and the operator's own ceiling when raising it. */
export const DEFAULT_SESSION_LIMIT = 4
export const SESSION_LIMIT_CEILING = 8

interface HostingFileShape {
  readonly version: number
  readonly limit: number
  readonly open: readonly unknown[]
  readonly defaults?: unknown
  readonly marks?: unknown
  readonly notifications?: unknown
}

const MARKS_ID_MAX = 200
const EMPTY_MARKS: SessionMarks = { pinned: [], archived: [] }

function resolveMarkList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '' && entry.length <= MARKS_ID_MAX) seen.add(entry)
  }
  return [...seen]
}

// Each field falls back to an empty list on its own, the same per-field fallback resolveDefaults uses —
// a malformed 'archived' never drops a valid 'pinned', or vice versa.
function resolveMarks(value: unknown): SessionMarks {
  if (typeof value !== 'object' || value === null) return EMPTY_MARKS
  const marks = value as Record<string, unknown>
  return { pinned: resolveMarkList(marks.pinned), archived: resolveMarkList(marks.archived) }
}

// `model: null` is itself valid (Claude Code's own default); anything else
// not in the allowlist falls back to DEFAULT_SESSION_DEFAULTS.model alone.
function resolveModel(value: unknown): SessionModel | null {
  if (value === null) return null
  if (typeof value === 'string' && (SESSION_MODELS as readonly string[]).includes(value)) return value as SessionModel
  return DEFAULT_SESSION_DEFAULTS.model
}

function resolvePermissionMode(value: unknown): SessionPermissionMode {
  if (typeof value === 'string' && (SESSION_PERMISSION_MODES as readonly string[]).includes(value)) return value as SessionPermissionMode
  return DEFAULT_SESSION_DEFAULTS.permissionMode
}

// Each field falls back to DEFAULT_SESSION_DEFAULTS on its own — a malformed
// 'model' never drops a valid 'permissionMode' alongside it, or vice versa.
function resolveDefaults(value: unknown): SessionDefaults {
  if (typeof value !== 'object' || value === null) return DEFAULT_SESSION_DEFAULTS
  const defaults = value as Record<string, unknown>
  return { model: resolveModel(defaults.model), permissionMode: resolvePermissionMode(defaults.permissionMode) }
}

// Each flag falls back to on by itself — a malformed 'sessions' never flips a valid 'needsYou'.
function resolveNotifications(value: unknown): NotificationPrefs {
  if (typeof value !== 'object' || value === null) return DEFAULT_NOTIFICATION_PREFS
  const prefs = value as Record<string, unknown>
  return {
    needsYou: typeof prefs.needsYou === 'boolean' ? prefs.needsYou : DEFAULT_NOTIFICATION_PREFS.needsYou,
    sessions: typeof prefs.sessions === 'boolean' ? prefs.sessions : DEFAULT_NOTIFICATION_PREFS.sessions,
  }
}

function isValidOpenEntry(value: unknown): value is PersistedOpenEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const repoIdValid = entry.repoId === null || (typeof entry.repoId === 'string' && entry.repoId !== '')
  const cwdValid = entry.cwd === undefined || (typeof entry.cwd === 'string' && entry.cwd !== '')
  // A null repoId with no cwd could never be restored — dropped as invalid rather than kept dead.
  if (entry.repoId === null && entry.cwd === undefined) return false
  return (
    repoIdValid &&
    cwdValid &&
    typeof entry.claudeSessionId === 'string' &&
    entry.claudeSessionId !== '' &&
    (entry.title === null || typeof entry.title === 'string') &&
    typeof entry.startedAt === 'string' &&
    entry.startedAt !== ''
  )
}

function isValidLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SESSION_LIMIT_CEILING
}

function emptyState(): HostingPersistedState {
  return { limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS, notifications: DEFAULT_NOTIFICATION_PREFS }
}

interface CreateHostingPersistenceParams {
  readonly dir: string
}

/** Missing, unparseable, wrong-shaped, or newer-versioned all resolve to `emptyState()`, logged once. */
export function createHostingPersistence(params: CreateHostingPersistenceParams): HostingPersistence {
  const filePath = pathOps.join(params.dir, HOSTING_FILE)
  let frozen = false
  let writing: Promise<void> | null = null
  let pending: HostingPersistedState | null = null
  let lastWrittenJson: string | null = null

  async function load(): Promise<HostingPersistedState> {
    await ensureDirectory(params.dir)
    const result = await readJsonFile<HostingFileShape>(filePath)
    if (!result.ok) {
      if (result.kind !== 'not-found') console.error(`[hosting] could not read ${filePath}: ${result.message}`)
      return emptyState()
    }
    const value = result.value
    if (typeof value !== 'object' || value === null || typeof value.version !== 'number' || value.version > CURRENT_VERSION) {
      console.error(`[hosting] ${filePath} is malformed or was written by a newer version of Port — starting empty`)
      return emptyState()
    }
    const limit = isValidLimit(value.limit) ? value.limit : DEFAULT_SESSION_LIMIT
    const open = Array.isArray(value.open) ? value.open.filter(isValidOpenEntry) : []
    const defaults = resolveDefaults(value.defaults)
    const marks = resolveMarks(value.marks)
    const notifications = resolveNotifications(value.notifications)
    return { limit, open, defaults, marks, notifications }
  }

  function startWrite(state: HostingPersistedState, json: string): void {
    writing = (async () => {
      const result = await writeJsonFileAtomic(filePath, { version: CURRENT_VERSION, ...state })
      if (!result.ok) {
        console.error(`[hosting] could not write ${filePath}: ${result.message}`)
      } else {
        lastWrittenJson = json
      }
      writing = null
      if (pending !== null && !frozen) {
        const next = pending
        pending = null
        enqueue(next)
      }
    })()
  }

  function enqueue(state: HostingPersistedState): void {
    const json = JSON.stringify({ version: CURRENT_VERSION, limit: state.limit, open: state.open, defaults: state.defaults, marks: state.marks, notifications: state.notifications })
    if (json === lastWrittenJson) return
    if (writing !== null) {
      pending = state
      return
    }
    startWrite(state, json)
  }

  return {
    load,
    save(state) {
      if (frozen) return
      enqueue(state)
    },
    freeze() {
      frozen = true
      pending = null
    },
  }
}

/** A disk-free fallback for tests; `main/ipc.ts` always supplies the real persistence for the running app. */
export function createInMemoryHostingPersistence(): HostingPersistence {
  let state: HostingPersistedState = emptyState()
  let frozen = false
  return {
    load: () => Promise.resolve(state),
    save(next) {
      if (frozen) return
      state = next
    },
    freeze() {
      frozen = true
    },
  }
}
