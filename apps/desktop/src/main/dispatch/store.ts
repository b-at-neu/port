// The per-repository run-state store. `read-only`: an unreadable file is never overwritten, every repository reads paused, and starting a run is refused.
// A missing file reads as no entries, never a v1-open default.
import { z } from 'zod'
import { createJsonStore, nodeStoreFs, type StoreFs } from '@/main/platform/json-store'
import { pathOps } from '@/main/platform/paths'
import type { RepoId } from '@/utils/repos'
import { RUN_STATES, RUN_TARGET } from '@/types/dispatch'
import type { RepoRunState, RunStateStoreStatus } from '@/types/dispatch'
import type { RunStateStore, SetRunStateResult } from '@/types/dispatch'

const DISPATCH_FILE = 'dispatch.json'
const CURRENT_VERSION = 2

const fileSchema = z.object({ version: z.literal(CURRENT_VERSION), repositories: z.array(z.unknown()) })
const entrySchema = z.object({ id: z.string(), state: z.enum(RUN_STATES), since: z.string().nullable() })
const v1Schema = z.object({ version: z.literal(1), draining: z.boolean(), since: z.string().nullable().optional() })

type RegisteredIds = readonly RepoId[] | null

/** Lifts a v1 file (one global draining flag) to per-repository entries; `null` ids defer to the next launch. */
export function migrateRunState(from: number, raw: unknown, ids: RegisteredIds, now: string): unknown {
  if (from !== 1) throw new Error(`no run-state migration from version ${String(from)}`)
  const v1 = v1Schema.parse(raw)
  if (ids === null) return null
  const since = v1.since ?? new Date(0).toISOString()
  return { version: CURRENT_VERSION, repositories: ids.map((id) => (v1.draining ? { id, state: 'paused', since } : { id, state: 'dispatching', since: now })) }
}

function pausedDefault(repoId: RepoId): RepoRunState {
  return { repoId, state: 'paused', since: null }
}

export function createRunStateStore(dir: string, fs?: StoreFs): RunStateStore {
  const path = pathOps.join(dir, DISPATCH_FILE)
  const store = createJsonStore<z.infer<typeof fileSchema>, RegisteredIds>({
    file: path,
    version: CURRENT_VERSION,
    schema: fileSchema,
    initial: { version: CURRENT_VERSION, repositories: [] },
    unreadable: 'read-only',
    migrate: (from, raw, ids) => migrateRunState(from, raw, ids, new Date().toISOString()),
    fs,
  })
  let loaded = false
  const entries = new Map<RepoId, RepoRunState>()

  function status(): RunStateStoreStatus {
    if (!loaded) return { kind: 'unread' }
    const current = store.status()
    return current.kind === 'loaded' ? { kind: 'loaded' } : { kind: 'unreadable', message: current.message, path }
  }

  // Reads `entries` directly, never gated on the status: one `set()` has written reads back immediately even before `load()` has run.
  function currentOf(repoId: RepoId): RepoRunState {
    return entries.get(repoId) ?? pausedDefault(repoId)
  }

  function persist(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const repositories = [...entries.values()].map((e) => ({ id: e.repoId, state: e.state, since: e.since }))
    return store.write({ version: CURRENT_VERSION, repositories }).then((written) => (written.ok ? { ok: true } : { ok: false, message: written.message }))
  }

  return {
    current: currentOf,
    status,
    snapshot: (repoIds) => ({ store: status(), repositories: repoIds.map(currentOf) }),
    path,

    async load(registered): Promise<void> {
      const peek = await (fs ?? nodeStoreFs).readJson(path)
      const needsIds = peek.ok && typeof peek.value === 'object' && peek.value !== null && (peek.value as { version?: unknown }).version === 1
      await store.load(needsIds ? await registered() : null)
      loaded = true
      for (const raw of store.value().repositories) {
        // An unknown state or non-string id is dropped individually.
        const parsed = entrySchema.safeParse(raw)
        if (parsed.success) entries.set(parsed.data.id as RepoId, { repoId: parsed.data.id as RepoId, state: parsed.data.state, since: parsed.data.since })
      }
    },

    async set(repoIds, state, at): Promise<SetRunStateResult> {
      const current = status()
      if (current.kind === 'unreadable') {
        // Every repository already reads paused and still will after a restart — nothing to write.
        if (state === 'paused') return { ok: true }
        return { ok: false, reason: 'unreadable', message: current.message }
      }

      const previous = new Map(repoIds.map((id) => [id, entries.get(id)] as const))
      for (const id of repoIds) entries.set(id, { repoId: id, state, since: at })
      const written = await persist()
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
      const current = status()
      if (current.kind === 'unreadable') return { ok: false, reason: 'unreadable', message: current.message }
      if (!entries.has(repoId)) return { ok: true }
      const removed = entries.get(repoId)
      entries.delete(repoId)
      const written = await persist()
      if (written.ok) return { ok: true }
      if (removed !== undefined) entries.set(repoId, removed)
      return { ok: false, reason: 'unwritable', message: written.message }
    },
  }
}
