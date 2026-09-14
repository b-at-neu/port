// Every union the board renders gets its copy here, one `switch` each — a
// new variant is a compile error rather than a silently blank row (#80),
// the same rule `worktrees.ts`'s own header states. Pure string functions;
// no DOM here.
import type { ItemStatus, LinkReason, RepositoryFreshness, RepositoryState, StatusEvidence, WaitingOn } from '../../../shared/state/types'
import type { DisplayStatus, SourceHealth, SourceKind } from '../../../shared/board/types'
import type { RepoProblem } from '../../../shared/repos'

export function statusWord(status: ItemStatus): string {
  switch (status) {
    case 'waiting':
      return 'Waiting'
    case 'in-flight':
      return 'In flight'
    case 'stalled':
      return 'Stalled'
    case 'gated':
      return 'Awaiting human'
    case 'terminal':
      return 'Terminal'
    case 'unstaged':
      return 'Unstaged'
  }
}

/** The item row's sub-line — first hit wins. A suppressed stall (Decision 5)
 *  is checked before the ordinary status-evidence copy, since it overrides
 *  what the raw status would otherwise say. */
export function subLineFor(params: {
  readonly displayStatus: DisplayStatus
  readonly statusEvidence: StatusEvidence | null
  readonly waitingOn: WaitingOn | null
  readonly linkReason: LinkReason | null
  readonly stageAmbiguous: boolean
  readonly agentSummary: string | null
  readonly worktreeCount: number
}): string | null {
  const { displayStatus, statusEvidence, waitingOn, linkReason, stageAmbiguous, agentSummary, worktreeCount } = params

  if (displayStatus.staleGithub && displayStatus.status === 'in-flight') {
    const ageS = displayStatus.githubAgeMs !== null ? Math.round(displayStatus.githubAgeMs / 1000) : null
    return ageS !== null ? `Checking — the label list is ${ageS}s old.` : 'Checking — the label list could not be read.'
  }
  if (agentSummary !== null) return agentSummary
  if (statusEvidence === 'no-claimant') return 'Nothing claims this. No agent and no session are working on it.'
  if (statusEvidence === 'all-dormant') return "Nothing has been active recently — it may have stalled."
  if (statusEvidence === 'sessions-unavailable') return "Can't see local sessions, so a stall can't be told from live work."
  if (waitingOn === 'nobody') return 'Unassigned — no cockpit will pick this up.'
  if (waitingOn === 'operator-session') return 'Session required — run /port:implement.'
  if (linkReason === 'counterpart-not-open') return 'Its pull request is no longer open.'
  if (stageAmbiguous) return 'Also carries another stage label.'
  if (worktreeCount === 1) return '1 worktree'
  if (worktreeCount > 1) return `${worktreeCount} worktrees`
  return null
}

export function repoProblemCopy(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return "That folder is gone. It may have moved, or be on a drive that isn't mounted."
    case 'not-a-git-repository':
      return "Not a git repository. Pick the repository's root folder."
    case 'not-port-managed':
      return problem.carriedBy.length > 0
        ? `Not port-managed on ${problem.currentBranch}. The harness is on ${problem.carriedBy.join(', ')} — check one of those out and rescan.`
        : "Not port-managed. There's no .claude/port.config.json on any branch here."
    case 'config-malformed':
      return `.claude/port.config.json isn't valid JSON — ${problem.message}.`
    case 'config-invalid':
      return `.claude/port.config.json has no usable repo: ${problem.violations[0]?.message ?? 'invalid'}.`
    case 'config-unreadable':
      return `Can't read .claude/port.config.json — ${problem.message}.`
  }
}

export function notReadyCopy(state: Extract<RepositoryState, { readonly ok: false }>): string {
  if (state.reason === 'not-ready') return repoProblemCopy(state.problem)
  return `Couldn't reach GitHub: ${state.message}. Retrying automatically.`
}

const SOURCE_NAMES: Readonly<Record<SourceKind, string>> = { github: 'GitHub', sessions: 'Sessions', worktrees: 'Worktrees', denials: 'Denials' }

export function sourceName(kind: SourceKind): string {
  return SOURCE_NAMES[kind]
}

function ageCopy(at: string | null, now: Date): string {
  if (at === null) return 'never read'
  const ms = now.getTime() - Date.parse(at)
  if (Number.isNaN(ms) || ms < 0) return 'just now'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return `${minutes}m ago`
}

/** One source's own freshness-strip clause — healthy, retrying, or never
 *  read, following the plan's own three example lines. */
export function sourceHealthCopy(kind: SourceKind, health: SourceHealth, now: Date): string {
  const name = sourceName(kind)
  if (health.lastSuccessAt === null && health.consecutiveFailures === 0) return `${name} — reading…`
  if (health.consecutiveFailures === 0) return `${name} ${ageCopy(health.lastSuccessAt, now)}`
  if (health.lastSuccessAt === null) return `${name} — never read. ${health.lastError ?? ''}`.trim()
  return `${name} — retrying. Showing what was read ${ageCopy(health.lastSuccessAt, now)}.`
}

export function rateLimitCopy(freshness: RepositoryFreshness | null, remaining: number | null, resetAt: string | null): string | null {
  void freshness
  if (remaining === null || resetAt === null) return null
  const resetTime = new Date(resetAt)
  const label = Number.isNaN(resetTime.getTime()) ? resetAt : resetTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${remaining.toLocaleString()} API points left, resets ${label}`
}
