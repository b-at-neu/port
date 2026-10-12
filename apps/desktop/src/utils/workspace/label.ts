// A null-repoId session's own display label — the folder's basename, independent of host
// platform — plus the one place a registered repo's display label is picked. Shared by main
// (the notifier's repo lookup) and the renderer (every screen that shows a session's repo),
// so neither ever falls back to a raw id.
import type { RepositoryEntry } from '@/utils/repos'

/** Splits on both `/` and `\` so a path displayed from either platform resolves the same way; a drive root (`C:\`) returns itself. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed === '') return path
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1)
}

/** A repo's display label, given its registry entry (if any) — never a raw id. A `ready` entry
 *  shows its resolved `config.repo` (`owner/name`); a problem entry still has a `displayName`;
 *  an unregistered repo (`entry` undefined, e.g. a session outside any registered repo) falls
 *  back to the folder's basename. */
export function repoDisplayLabel(entry: RepositoryEntry | undefined, folder: string): string {
  if (entry === undefined) return folderLabel(folder)
  return 'config' in entry ? entry.config.repo : entry.displayName
}
