// A set of string ids persisted as a JSON array in localStorage; repository ids unless a caller names another key type.
import type { RepoId } from '@/utils/repos'
import type { KeyValueStorage } from '@/types/storage'

// A malformed value reads as the empty set — expanded and all shown, so nothing silently disappears.
export function readIdSet<T extends string = RepoId>(storage: KeyValueStorage, key: string): ReadonlySet<T> {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    const valid = Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
    return valid ? new Set(parsed as T[]) : new Set()
  } catch {
    return new Set()
  }
}

export function writeIdSet<T extends string = RepoId>(storage: KeyValueStorage, key: string, ids: ReadonlySet<T>): void {
  try {
    storage.setItem(key, JSON.stringify([...ids]))
  } catch {
    // Best-effort only — a full or blocked localStorage loses the preference, never the app.
  }
}
