// #103: one repository-label cache, shared by the permission dialog
// (`permission/controller.ts`) and the session rail's new-session picker
// (`session/controller.ts`) — moved out of `permission/controller.ts`'s own
// `loadRepoLabels`/`repoLabelFor` so there is no second copy. A subscriber
// (`onChange`) is redrawn whenever a reload actually lands, the same
// module-level-closure idiom `permission/controller.ts` already establishes
// for its own state.
import type { RepoId, RepositoryEntry } from '../../shared/repos'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

let labels = new Map<RepoId, string>()
let readyEntries: readonly Extract<RepositoryEntry, { status: 'ready' }>[] = []
const reloadTried = new Set<RepoId>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function onRepoLabelsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function reloadRepoLabels(): Promise<void> {
  try {
    const result = await window.port.reposList()
    if (!result.ok) return
    const next = new Map<RepoId, string>()
    for (const entry of result.repositories) next.set(entry.id, isReady(entry) ? entry.config.repo : entry.displayName)
    labels = next
    readyEntries = result.repositories.filter(isReady)
    notify()
  } catch (error) {
    console.error('Failed to load repository labels', error)
  }
}

/** Falls back to the raw id — reloaded at most once per unresolved id, so a
 *  genuinely unknown repository never triggers a reload loop. */
export function repoLabelFor(repoId: RepoId): string {
  const label = labels.get(repoId)
  if (label !== undefined) return label
  if (!reloadTried.has(repoId)) {
    reloadTried.add(repoId)
    void reloadRepoLabels()
  }
  return repoId
}

/** The rail's new-session picker: every currently `ready` repository, with
 *  its own display label. */
export function readyRepos(): readonly { readonly id: RepoId; readonly label: string }[] {
  return readyEntries.map((entry) => ({ id: entry.id, label: entry.config.repo }))
}
