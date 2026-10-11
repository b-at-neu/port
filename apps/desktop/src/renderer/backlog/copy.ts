// Every string the Backlog screen renders for a failure or an edge case — pure, one function per concern.
import type { PipelineFailureKind } from '../../../shared/github/types'

// The plan's own UX-states table, verbatim.
export function backlogFailureCopy(repo: string, kind: PipelineFailureKind, message: string): string {
  switch (kind) {
    case 'unauthenticated':
      return 'gh is signed out. Run `gh auth login`.'
    case 'not-found':
      return "gh isn't installed. Install it, then retry."
    case 'rate-limited':
      return "GitHub's rate limit is used up. Retry in a few minutes."
    case 'network':
    case 'timeout':
      return "Couldn't reach GitHub. Check your connection, then retry."
    case 'repo-not-found':
    case 'http-not-found':
    case 'forbidden':
      return `GitHub can't find ${repo}, or your account can't read it.`
    default:
      return `Couldn't read open tickets: ${message}`
  }
}

export function backlogTruncatedCopy(scanned: number): string {
  return `Showing the ${String(scanned)} most recently updated open tickets. Older ones aren't listed.`
}

export function backlogEmptyGroupCopy(repo: string): string {
  return `Every open ticket in ${repo} is already in a pipeline.`
}

export function backlogInvokeErrorCopy(repo: string): string {
  return `Couldn't load open tickets for ${repo}. Retry, or check the repository on Repositories.`
}

export function backlogNotReadyCopy(repo: string): string {
  return `${repo} isn't ready, so its tickets aren't listed. Fix it on Repositories.`
}
