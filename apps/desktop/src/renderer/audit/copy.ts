// Every string the Audit screen renders — pure, no DOM.
import type { AuditReadFailureKind } from '@/types/writes'
import { AUDIT_LIST_LIMIT } from '@/types/writes'

export const AUDIT_TITLE = 'Audit log'
export const ALL_REPOSITORIES = 'All repositories'
export const REFRESH_LABEL = 'Refresh'
export const SHOW_ALL_ACTION = 'Show all writes'
export const NO_COMMAND = 'No command ran'
export const EMPTY_UNFILTERED = "port hasn't written to GitHub yet. Writes appear here as you act on tickets."
export const INVOKE_ERROR = "Couldn't load the audit log. Refresh to try again."
export const REMOVE_TICKET_FILTER = 'Clear ticket filter'

export const ACTOR_LABEL = { you: 'You', port: 'port' } as const

export function emptyFilteredCopy(repo: string, number: number | null): string {
  return number === null ? `No writes in ${repo}.` : `No writes for #${String(number)} in ${repo}.`
}

export function failureCopy(kind: AuditReadFailureKind, message: string): string {
  switch (kind) {
    case 'permission-denied':
      return "Couldn't read the audit log: permission denied. Check access to the app's data folder."
    case 'too-large':
      return 'The audit log is too large to read. Move `writes.jsonl` aside to start a fresh one.'
    case 'io':
      return `Couldn't read the audit log: ${message}`
  }
}

export function footnotes(malformed: number, previousPath: string | null, shown: number): readonly string[] {
  const notes: string[] = []
  if (malformed > 0) notes.push(`${String(malformed)} line${malformed === 1 ? '' : 's'} couldn't be read and aren't shown.`)
  if (previousPath !== null) notes.push("Older entries were rotated to writes.prev.jsonl and aren't shown.")
  if (shown === AUDIT_LIST_LIMIT) notes.push(`Showing the latest ${String(AUDIT_LIST_LIMIT)} writes.`)
  return notes
}
