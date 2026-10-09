// Pure restore-set bookkeeping. No I/O here; persist.ts owns the file, store.ts composes both.
import type { RepoId } from '../../shared/repos'
import type { HostedSessionSnapshot } from '../../shared/hosting/types'
import type { PersistedOpenEntry } from './persist'

/** Not `closing`/`ended`, and carrying a real `claudeSessionId` — a session without one cannot be resumed. */
export function persistedOpen(handles: readonly HostedSessionSnapshot[]): readonly PersistedOpenEntry[] {
  const result: PersistedOpenEntry[] = []
  for (const handle of handles) {
    if (handle.phase === 'closing' || handle.phase === 'ended') continue
    if (handle.claudeSessionId === null) continue
    result.push({ repoId: handle.repoId, claudeSessionId: handle.claudeSessionId, title: handle.title, startedAt: handle.startedAt })
  }
  return result
}

/** An app-local `restoreId`, never persisted itself; the renderer-facing shape omits `claudeSessionId`. */
export interface MintedRestorable {
  readonly restoreId: string
  readonly repoId: RepoId
  readonly claudeSessionId: string
  readonly title: string | null
  readonly startedAt: string
}

/** Assigns `restore-<n>` ids by position — called once, after `persistence.load()`. */
export function mintRestorable(entries: readonly PersistedOpenEntry[]): readonly MintedRestorable[] {
  return entries.map((entry, index) => ({ restoreId: `restore-${String(index + 1)}`, ...entry }))
}

/** Removes the restorable entry a live handle has just adopted, so the banner never offers it again. */
export function dropAdopted(restorable: readonly MintedRestorable[], claudeSessionId: string): readonly MintedRestorable[] {
  return restorable.filter((entry) => entry.claudeSessionId !== claudeSessionId)
}

export interface NextPersistedParams {
  readonly limit: number
  readonly live: readonly PersistedOpenEntry[]
  readonly restorable: readonly MintedRestorable[]
}

/** The next write: the live set plus unadopted restorable entries, deduped by `claudeSessionId` with live winning. */
export function nextPersisted(params: NextPersistedParams): { readonly limit: number; readonly open: readonly PersistedOpenEntry[] } {
  const seen = new Set(params.live.map((entry) => entry.claudeSessionId))
  const open: PersistedOpenEntry[] = [...params.live]
  for (const entry of params.restorable) {
    if (seen.has(entry.claudeSessionId)) continue
    seen.add(entry.claudeSessionId)
    open.push({ repoId: entry.repoId, claudeSessionId: entry.claudeSessionId, title: entry.title, startedAt: entry.startedAt })
  }
  return { limit: params.limit, open }
}
