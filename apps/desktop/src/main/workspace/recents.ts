// `folders.json`'s only writer — a recoverable recents store, cap 10, deduped by `samePath`.
import { ensureDirectory, readJsonFile, writeJsonFileAtomic } from '../platform/files'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { PathOps } from '../platform/paths'

const FOLDERS_FILE = 'folders.json'
const CURRENT_VERSION = 1
export const RECENTS_CAP = 10

export interface RecentFolder {
  readonly path: string
  readonly lastUsedAt: string
}

interface FoldersFileShape {
  readonly version: number
  readonly recents: readonly unknown[]
}

function isValidRecent(value: unknown): value is RecentFolder {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.path === 'string' && entry.path !== '' && typeof entry.lastUsedAt === 'string' && entry.lastUsedAt !== ''
}

export interface RecentsStore {
  /** Missing, unparseable, wrong-shaped, or newer-versioned all resolve to an empty list. */
  load(): Promise<readonly RecentFolder[]>
  /** Upserts by `samePath` (moving the match to most-recent), then caps at `RECENTS_CAP`. */
  record(path: string, now: Date): Promise<void>
}

export interface CreateRecentsStoreParams {
  readonly dir: string
  readonly pathOps?: PathOps
}

export function createRecentsStore(params: CreateRecentsStoreParams): RecentsStore {
  const ops = params.pathOps ?? defaultPathOps
  const filePath = ops.join(params.dir, FOLDERS_FILE)

  async function load(): Promise<readonly RecentFolder[]> {
    await ensureDirectory(params.dir)
    const result = await readJsonFile<FoldersFileShape>(filePath)
    if (!result.ok) {
      if (result.kind !== 'not-found') console.error(`[workspace] could not read ${filePath}: ${result.message}`)
      return []
    }
    const value = result.value
    if (typeof value !== 'object' || value === null || typeof value.version !== 'number' || value.version > CURRENT_VERSION || !Array.isArray(value.recents)) {
      console.error(`[workspace] ${filePath} is malformed or was written by a newer version of Port — starting empty`)
      return []
    }
    return value.recents.filter(isValidRecent)
  }

  async function record(path: string, now: Date): Promise<void> {
    const existing = await load()
    const withoutMatch = existing.filter((entry) => !ops.samePath(entry.path, path))
    const next = [{ path, lastUsedAt: now.toISOString() }, ...withoutMatch].slice(0, RECENTS_CAP)
    const written = await writeJsonFileAtomic(filePath, { version: CURRENT_VERSION, recents: next })
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
