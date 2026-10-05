// #103: `hosting.json`'s only writer — recoverable app state, not an
// operator-curated list like `registry.json`, so a missing or malformed file
// resolves to an empty state rather than refusing to load (the opposite
// direction `main/registry/store.ts` takes for a file the operator would
// have to notice and fix by hand). `guard(#103)` in
// `scripts/checks/desktop-hosting.ts` pins that no other file under
// `main/hosting/` names `writeJsonFileAtomic` or `hosting.json` — a second
// writer could persist a set that skipped `freeze()` on quit.
import type { RepoId } from '../../shared/repos'
import { DEFAULT_SESSION_DEFAULTS, SESSION_MODELS, SESSION_PERMISSION_MODES } from '../../shared/hosting/types'
import type { SessionDefaults, SessionModel, SessionPermissionMode } from '../../shared/hosting/types'
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '../platform/files'
import { pathOps } from '../platform/paths'

const HOSTING_FILE = 'hosting.json'
const CURRENT_VERSION = 1

/** Default `limit` for a fresh or unrecoverable state, and the operator's
 *  own ceiling when raising it from the rail. Declared here (not in
 *  `store.ts`) because this is the one file that has to fall back to
 *  `DEFAULT_SESSION_LIMIT` on a load failure — `store.ts` imports both
 *  rather than each module declaring its own copy. */
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
}

interface HostingFileShape {
  readonly version: number
  readonly limit: number
  readonly open: readonly unknown[]
  readonly defaults?: unknown
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
  return { limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS }
}

export interface CreateHostingPersistenceParams {
  readonly dir: string
}

export interface HostingPersistence {
  load(): Promise<HostingPersistedState>
  /** Fire-and-forget — never awaited by a caller, and never blocks a start.
   *  A state whose serialized JSON equals the last one actually written is
   *  skipped; while a write is in flight, only the newest pending state
   *  survives, written once that write settles. */
  save(state: HostingPersistedState): void
  /** Drops every later `save` — called before `closeAll()` touches a single
   *  handle, so the `closing` phase that quitting causes can never overwrite
   *  the very set this ticket persists. */
  freeze(): void
}

/** Loading is recoverable by design: missing, unparseable, the wrong shape,
 *  or a newer `version` all resolve to `emptyState()`, logged once — this is
 *  overwritten on the next save rather than left to block anything. Invalid
 *  `open` entries and an out-of-range `limit` are dropped individually
 *  rather than failing the whole read. */
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
    return { limit, open, defaults }
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
    const json = JSON.stringify({ version: CURRENT_VERSION, limit: state.limit, open: state.open, defaults: state.defaults })
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

/** A disk-free fallback for `defaultHostedStoreDeps` (tests, and any caller
 *  that never overrides `persistence`) — `main/ipc.ts` always supplies the
 *  real `createHostingPersistence` for the running app. */
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
