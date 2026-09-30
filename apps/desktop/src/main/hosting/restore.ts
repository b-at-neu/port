// #103: pure restore-set bookkeeping — the projection from live handles to
// what gets persisted, and from a loaded file to what the restore banner
// offers. No I/O here; `persist.ts` owns the file, `store.ts` composes both.
import type { RepoId } from '../../shared/repos'
import type { HostedSessionSnapshot } from '../../shared/hosting/types'
import type { PersistedOpenEntry } from './persist'

/** The live handles worth persisting: not `closing`/`ended`, and carrying a
 *  real `claudeSessionId` — a session `init` has not reported yet cannot be
 *  resumed, so it is not offered on the next launch either. */
export function persistedOpen(handles: readonly HostedSessionSnapshot[]): readonly PersistedOpenEntry[] {
  const result: PersistedOpenEntry[] = []
  for (const handle of handles) {
    if (handle.phase === 'closing' || handle.phase === 'ended') continue
    if (handle.claudeSessionId === null) continue
    result.push({ repoId: handle.repoId, claudeSessionId: handle.claudeSessionId, title: handle.title, startedAt: handle.startedAt })
  }
  return result
}

/** One persisted entry, minted with an app-local `restoreId` the moment the
 *  file is loaded — never persisted itself, and the renderer never sees the
 *  `claudeSessionId` it carries (`RestorableSession`, the renderer-facing
 *  shape, omits it entirely). */
export interface MintedRestorable {
  readonly restoreId: string
  readonly repoId: RepoId
  readonly claudeSessionId: string
  readonly title: string | null
  readonly startedAt: string
}

/** Assigns `restore-<n>` ids by position — called once, right after
 *  `persistence.load()`, so the same entries always mint the same ids for
 *  the life of the app even though this function itself holds no state. */
export function mintRestorable(entries: readonly PersistedOpenEntry[]): readonly MintedRestorable[] {
  return entries.map((entry, index) => ({ restoreId: `restore-${String(index + 1)}`, ...entry }))
}

/** Removes the restorable entry a live handle has just adopted — called the
 *  first time that handle reports its `claudeSessionId`, so the banner never
 *  offers a session already open in the rail. */
export function dropAdopted(restorable: readonly MintedRestorable[], claudeSessionId: string): readonly MintedRestorable[] {
  return restorable.filter((entry) => entry.claudeSessionId !== claudeSessionId)
}

export interface NextPersistedParams {
  readonly limit: number
  readonly live: readonly PersistedOpenEntry[]
  readonly restorable: readonly MintedRestorable[]
}

/** The next `hosting.json` write: the live set plus whichever restorable
 *  entries no live handle has adopted yet, deduped by `claudeSessionId` with
 *  live winning — so an entry the operator has not resumed yet, and has not
 *  discarded, survives another save untouched. */
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
