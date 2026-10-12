// A session's repo/folder display label, shared by main's notifier and every renderer screen
// that shows a session's repo, so neither ever falls back to a raw id.
import type { RepositoryEntry } from '@/utils/repos'

/** Splits on both `/` and `\` so a path displayed from either platform resolves the same way; a drive root (`C:\`) returns itself. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed === '') return path
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1)
}

/** A repo's display label from its registry entry (if any), never a raw id — `config.repo` when
 *  `ready`, else `displayName`, else (no entry) the folder's basename. */
export function repoDisplayLabel(entry: RepositoryEntry | undefined, folder: string): string {
  if (entry === undefined) return folderLabel(folder)
  return 'config' in entry ? entry.config.repo : entry.displayName
}
