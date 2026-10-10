// A null-repoId session's own display label — the folder's basename, independent of host platform.
/** Splits on both `/` and `\` so a path displayed from either platform resolves the same way; a drive root (`C:\`) returns itself. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (trimmed === '') return path
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1)
}
