// Every string the Incidents tab renders — pure, no DOM.
import type { IncidentBucket, IncidentPruned, IncidentReadFailureKind } from '@/types/incidents'

export const INCIDENTS_TITLE = 'Incidents'
export const ALL_REPOSITORIES = 'All repositories'
export const REFRESH_LABEL = 'Refresh'
export const EXPORT_LABEL = 'Export'
export const SHOW_ALL_ACTION = 'Show all incidents'
export const SHOW_INCIDENTS = 'Show incidents'
export const HIDE_INCIDENTS = 'Hide incidents'
export const EMPTY_UNFILTERED = "No incidents recorded. port logs a decision here when it escalates, resets or refuses something."
export const INVOKE_ERROR = "Couldn't load the incidents. Refresh to try again."
export const LIST_ERROR = "Couldn't load this group's incidents."

export const BUCKET_LABEL: Readonly<Record<IncidentBucket, string>> = {
  'stale-snapshot': 'Stale snapshot',
  'liveness-reset': 'Liveness reset',
  'duplicate-head': 'Duplicate head',
  'existing-work': 'Existing work',
  'leftover-worktree': 'Leftover worktree',
  'network-interrupt': 'Network interrupt',
  'refused-write': 'Refused write',
  'launch-failed': 'Launch failed',
  escalation: 'Escalation',
  unknown: 'Unknown',
}

export function emptyFilteredCopy(repo: string): string {
  return `No incidents in ${repo}.`
}

export function failureCopy(kind: IncidentReadFailureKind, message: string): string {
  switch (kind) {
    case 'permission-denied':
      return "Couldn't read the incident log: permission denied. Check access to the app's data folder."
    case 'too-large':
      return 'The incident log is too large to read. Move `incidents.jsonl` aside to start a fresh one.'
    case 'io':
      return `Couldn't read the incident log: ${message}`
  }
}

export function footnotes(malformed: number, pruned: IncidentPruned | null): readonly string[] {
  const notes: string[] = []
  if (malformed > 0) notes.push(`${String(malformed)} line${malformed === 1 ? '' : 's'} couldn't be read and aren't shown.`)
  if (pruned !== null) notes.push(`${String(pruned.count)} older incident${pruned.count === 1 ? ' was' : 's were'} dropped to stay within 90 days and 32 MB.`)
  return notes
}

export function exportedToast(path: string): string {
  return `Exported incidents to ${path.split(/[\\/]/).pop() ?? path}.`
}

export function exportFailedToast(message: string): string {
  return `Couldn't export incidents: ${message}`
}
