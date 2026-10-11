// Every string the History screen renders — pure, no DOM.
import type { SessionFailureKind } from '../../../shared/sessions/types'

export function failureCopy(kind: SessionFailureKind, message: string): string {
  switch (kind) {
    case 'sdk-unavailable':
      return "Port couldn't load the Claude Agent SDK, so it can't list sessions. Reinstall the app's dependencies and try again."
    case 'sdk-failed':
      return `The Claude Agent SDK failed while listing sessions: ${message}`
    case 'claude-home-missing':
      return 'No projects directory under your Claude home, so there are no local transcripts to read.'
    case 'projects-unreadable':
      return `Couldn't read your Claude projects directory — ${message}`
  }
}

export function footnote(unresolvedCount: number, unreadableCount: number): string | null {
  if (unresolvedCount === 0 && unreadableCount === 0) return null
  const parts: string[] = []
  if (unresolvedCount > 0) parts.push(`${String(unresolvedCount)} session${unresolvedCount === 1 ? '' : 's'} couldn't be located on disk`)
  if (unreadableCount > 0) parts.push(`${String(unreadableCount)} agent record${unreadableCount === 1 ? '' : 's'} ${unreadableCount === 1 ? 'was' : 'were'} unreadable`)
  return `${parts.join(' · ')}.`
}
