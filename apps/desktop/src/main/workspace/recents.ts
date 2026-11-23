// `folders.json`'s only writer — a recoverable recents store, cap 10, deduped by `samePath`.
// `reset`: a malformed or newer-version file loads empty and the next record replaces it.
import { z } from 'zod'
import { createJsonStore, nodeStoreFs } from '@/main/platform/json-store'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import type { PathOps } from '@/types/platform'
import type { RecentFolder, RecentsStore } from '@/types/workspace'

const FOLDERS_FILE = 'folders.json'
const CURRENT_VERSION = 1
export const RECENTS_CAP = 10

const foldersSchema = z.object({ version: z.literal(CURRENT_VERSION), recents: z.array(z.unknown()) })
const recentSchema = z.object({ path: z.string().min(1), lastUsedAt: z.string().min(1) })

interface CreateRecentsStoreParams {
  readonly dir: string
  readonly pathOps?: PathOps
}

export function createRecentsStore(params: CreateRecentsStoreParams): RecentsStore {
  const ops = params.pathOps ?? defaultPathOps
  const filePath = ops.join(params.dir, FOLDERS_FILE)
  const store = createJsonStore({
    file: filePath,
    version: CURRENT_VERSION,
    schema: foldersSchema,
    initial: { version: CURRENT_VERSION, recents: [] },
    unreadable: 'reset',
    fs: nodeStoreFs,
  })

  async function load(): Promise<readonly RecentFolder[]> {
    await store.load()
    const status = store.status()
    if (status.kind === 'unreadable') {
      console.error(`[workspace] could not read ${filePath}: ${status.message} — starting empty`)
      return []
    }
    return store.value().recents.flatMap((value) => {
      const parsed = recentSchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    })
  }

  async function record(path: string, now: Date): Promise<void> {
    const existing = await load()
    const withoutMatch = existing.filter((entry) => !ops.samePath(entry.path, path))
    const next = [{ path, lastUsedAt: now.toISOString() }, ...withoutMatch].slice(0, RECENTS_CAP)
    const written = await store.write({ version: CURRENT_VERSION, recents: next })
    if (!written.ok) console.error(`[workspace] could not write ${filePath}: ${written.message}`)
  }

  return { load, record }
}

/** Drops any entry `exists` reports as gone — `folders:list`'s own filter before a recent is shown,
 *  using an injectable predicate so no real filesystem access is needed to test it. */
export async function pruneMissing(entries: readonly RecentFolder[], exists: (path: string) => Promise<boolean>): Promise<readonly RecentFolder[]> {
  const checks = await Promise.all(entries.map((entry) => exists(entry.path)))
  return entries.filter((_entry, index) => checks[index] === true)
}
