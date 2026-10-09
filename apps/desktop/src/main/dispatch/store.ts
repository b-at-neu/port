// The per-repository run-state store: read, version gate, atomic write. Takes its directory as a
// parameter so nothing in this module imports Electron.
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '../platform/files'
import { pathOps } from '../platform/paths'
import type { RepoId } from '../../shared/repos'
import { RUN_STATES, RUN_TARGET } from '../../shared/dispatch/types'
import type { RepoRunState, RunState, RunStatesSnapshot, RunStateStoreStatus } from '../../shared/dispatch/types'

const DISPATCH_FILE = 'dispatch.json'
const CURRENT_VERSION = 2

interface V1FileShape {
  readonly version: 1
  readonly draining: boolean
  readonly since: string | null
}

interface V2EntryShape {
  readonly id: unknown
  readonly state: unknown
  readonly since: unknown
}

interface V2FileShape {
  readonly version: 2
  readonly repositories: readonly V2EntryShape[]
}

export type SetRunStateResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'unwritable' | 'unreadable'; readonly message: string }

export interface RunStateStore {
  /** Synchronous, always answerable — a repository with no entry reads paused with `since: null`. */
  readonly current: (repoId: RepoId) => RepoRunState
  readonly status: () => RunStateStoreStatus
  readonly snapshot: (repoIds: readonly RepoId[]) => RunStatesSnapshot
  /** Resolves the on-disk state once, at startup. `registered` is called only for a v1 file, to
   *  migrate every currently-registered repository onto its own entry. */
  readonly load: (registered: () => Promise<readonly RepoId[] | null>) => Promise<void>
  /** A failed `set(..., 'paused' | 'draining', ...)` still applies in memory; a failed
   *  `set(..., RUN_TARGET.run, ...)` changes nothing at all. */
  readonly set: (repoIds: readonly RepoId[], state: RunState, at: string) => Promise<SetRunStateResult>
  readonly forget: (repoId: RepoId) => Promise<SetRunStateResult>
  readonly path: string
}

function dispatchPath(dir: string): string {
  return pathOps.join(dir, DISPATCH_FILE)
}

function pausedDefault(repoId: RepoId): RepoRunState {
  return { repoId, state: 'paused', since: null }
}

function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value)
}

export function createRunStateStore(dir: string): RunStateStore {
  const path = dispatchPath(dir)
  let storeStatus: RunStateStoreStatus = { kind: 'unread' }
  const entries = new Map<RepoId, RepoRunState>()

  // Reads `entries` directly, never gated on `storeStatus`: one `set()` has written reads back
  // immediately even before `load()` has run.
  function currentOf(repoId: RepoId): RepoRunState {
    return entries.get(repoId) ?? pausedDefault(repoId)
  }

  async function writeV2(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const ensured = await ensureDirectory(dir)
    if (!ensured.ok) return { ok: false, message: ensured.message }
    const value: V2FileShape = { version: CURRENT_VERSION, repositories: [...entries.values()].map((e) => ({ id: e.repoId, state: e.state, since: e.since })) }
    const written = await writeJsonFileAtomic(path, value)
    if (!written.ok) return { ok: false, message: written.message }
    return { ok: true }
  }

  return {
    current: currentOf,
    status: () => storeStatus,
    snapshot: (repoIds) => ({ store: storeStatus, repositories: repoIds.map(currentOf) }),
    path,

    async load(registered): Promise<void> {
      const result = await readJsonFile<unknown>(path)
      if (!result.ok) {
        // A missing file reads as no entries — every repository paused — never a v1-open default.
        storeStatus = result.kind === 'not-found' ? { kind: 'loaded' } : { kind: 'unreadable', message: result.message, path }
        return
      }

      const value = result.value
      if (typeof value !== 'object' || value === null) {
        storeStatus = { kind: 'unreadable', message: `${path} is not a dispatch file`, path }
        return
      }
      const version = (value as { readonly version?: unknown }).version
      if (typeof version !== 'number' || version > CURRENT_VERSION) {
        storeStatus = { kind: 'unreadable', message: `${path} was written by a newer version of Port (version ${String(version)})`, path }
        return
      }

      if (version === 1) {
        const v1 = value as Partial<V1FileShape>
        if (typeof v1.draining !== 'boolean') {
          storeStatus = { kind: 'unreadable', message: `${path} is not a dispatch file`, path }
          return
        }
        const ids = await registered()
        if (ids === null) {
          // The registry itself couldn't be read — every repository paused, retried next launch.
          storeStatus = { kind: 'loaded' }
          return
        }
        const since = v1.since ?? new Date(0).toISOString()
        const now = new Date().toISOString()
        for (const id of ids) {
          entries.set(id, v1.draining ? { repoId: id, state: 'paused', since } : { repoId: id, state: 'dispatching', since: now })
        }
        storeStatus = { kind: 'loaded' }
        // If this fails, the migrated state stays in memory and the v1 file is left alone.
        await writeV2()
        return
      }

      // The cast below keeps raw.id/raw.state/raw.since typed as `unknown` rather than `any`.
      const rawRepositories = (value as Partial<V2FileShape>).repositories
      if (!Array.isArray(rawRepositories)) {
        storeStatus = { kind: 'unreadable', message: `${path} is not a dispatch file`, path }
        return
      }
      const repositories = rawRepositories as readonly V2EntryShape[]
      for (const raw of repositories) {
        if (typeof raw?.id !== 'string' || !isRunState(raw.state)) continue // an unknown state or non-string id is dropped individually
        if (raw.since !== null && typeof raw.since !== 'string') continue
        const id = raw.id as RepoId
        entries.set(id, { repoId: id, state: raw.state, since: raw.since ?? null })
      }
      storeStatus = { kind: 'loaded' }
    },

    async set(repoIds, state, at): Promise<SetRunStateResult> {
      if (storeStatus.kind === 'unreadable') {
        // Every repository already reads paused and still will after a restart — nothing to write.
        if (state === 'paused') return { ok: true }
        return { ok: false, reason: 'unreadable', message: storeStatus.message }
      }

      const previous = new Map(repoIds.map((id) => [id, entries.get(id)] as const))
      for (const id of repoIds) entries.set(id, { repoId: id, state, since: at })
      const written = await writeV2()
      if (written.ok) return { ok: true }

      if (state === RUN_TARGET.run) {
        // Fail closed toward dispatching nothing.
        for (const id of repoIds) {
          const prior = previous.get(id)
          if (prior === undefined) entries.delete(id)
          else entries.set(id, prior)
        }
      }
      return { ok: false, reason: 'unwritable', message: written.message }
    },

    async forget(repoId): Promise<SetRunStateResult> {
      if (storeStatus.kind === 'unreadable') return { ok: false, reason: 'unreadable', message: storeStatus.message }
      if (!entries.has(repoId)) return { ok: true }
      const removed = entries.get(repoId)
      entries.delete(repoId)
      const written = await writeV2()
      if (written.ok) return { ok: true }
      if (removed !== undefined) entries.set(repoId, removed)
      return { ok: false, reason: 'unwritable', message: written.message }
    },
  }
}
