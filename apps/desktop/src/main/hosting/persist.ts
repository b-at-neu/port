// hosting.json's only writer: recoverable app state, so a missing or malformed file resolves to
// an empty state rather than refusing to load. Pinned as the sole writer by desktop-hosting.ts.
import type { RepoId } from '../../shared/repos'
import { DEFAULT_SESSION_DEFAULTS, SESSION_MODELS, SESSION_PERMISSION_MODES } from '../../shared/hosting/types'
import type { SessionDefaults, SessionMarks, SessionModel, SessionPermissionMode } from '../../shared/hosting/types'
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '../platform/files'
import { pathOps } from '../platform/paths'

const HOSTING_FILE = 'hosting.json'
const CURRENT_VERSION = 1

/** Default `limit` for a fresh or unrecoverable state, and the operator's own ceiling when raising it. */
export const DEFAULT_SESSION_LIMIT = 4
export const SESSION_LIMIT_CEILING = 8

export interface PersistedOpenEntry {
  readonly repoId: RepoId
  readonly claudeSessionId: string
  readonly title: string | null
  readonly startedAt: string
}

export interface HostingPersistedState {
  readonly limit: number
  readonly open: readonly PersistedOpenEntry[]
  readonly defaults: SessionDefaults
  readonly marks: SessionMarks
}

interface HostingFileShape {
  readonly version: number
  readonly limit: number
  readonly open: readonly unknown[]
  readonly defaults?: unknown
  readonly marks?: unknown
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

function isValidOpenEntry(value: unknown): value is PersistedOpenEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.repoId === 'string' &&
    entry.repoId !== '' &&
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
  return { limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS }
}

export interface CreateHostingPersistenceParams {
  readonly dir: string
}

export interface HostingPersistence {
  load(): Promise<HostingPersistedState>
  /** Fire-and-forget, deduplicated by last-written JSON; only the newest pending state survives. */
  save(state: HostingPersistedState): void
  /** Drops every later `save` — called before quitting overwrites the persisted set. */
  freeze(): void
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
    return { limit, open, defaults, marks }
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
    const json = JSON.stringify({ version: CURRENT_VERSION, limit: state.limit, open: state.open, defaults: state.defaults, marks: state.marks })
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
