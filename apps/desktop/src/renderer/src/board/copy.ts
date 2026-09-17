// Every union the board renders gets its copy here, one `switch` each — a
// new variant is a compile error rather than a silently blank row (#80),
// the same rule `worktrees.ts`'s own header states. Pure string functions;
// no DOM here.
import type { ItemStatus, LinkReason, RepositoryFreshness, RepositoryState, StatusEvidence, WaitingOn } from '../../../shared/state/types'
import type { DisplayStatus, SourceHealth, SourceKind } from '../../../shared/board/types'
import type { RepoProblem } from '../../../shared/repos'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import type { ActionPlan, ActionRefusal, ItemActionResult, OperatorAction } from '../../../shared/actions/types'
import type { Conflict } from '../../../shared/writes/types'

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

// --- The single-label operator actions (#94) -------------------------------

export function actionButtonLabel(action: OperatorAction): string {
  switch (action) {
    case 'pause':
      return 'Pause'
    case 'resume':
      return 'Resume'
    case 'retry':
      return 'Retry'
    case 'gate':
      return 'Add gate label'
  }
}

export function actionPendingLabel(action: OperatorAction): string {
  switch (action) {
    case 'pause':
      return 'Pausing…'
    case 'resume':
      return 'Resuming…'
    case 'retry':
      return 'Retrying…'
    case 'gate':
      return 'Adding…'
  }
}

/** The row's ownership note before anything has been clicked — `null` for
 *  `not-applicable`, since a button that does not apply here has nothing to
 *  say (COORDINATION.md's rule that a reason is on screen, never in a
 *  tooltip, only applies once there is a reason to give). */
export function actionRefusalNote(reason: ActionRefusal, item: { readonly number: number; readonly assignees: readonly string[] }): string | null {
  if (reason === 'viewer-unknown') return "Can't tell which account you're signed in as, so ownership can't be checked."
  if (reason === 'not-owned') {
    const owner = item.assignees[0] ?? 'someone else'
    return `@${owner} owns #${String(item.number)}. Take it over in the cockpit (work on #${String(item.number)}) before acting on it here.`
  }
  return null
}

function labelNameOf(key: string): string {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.name ?? key
}

/** One line per action verb. `WriteOutcome`'s own `applied` arm deliberately
 *  carries no resulting label set (`gh` exiting 0 is evidence the call
 *  landed, never a licence to synthesize state), so the names come from the
 *  row's own already-computed `plan` instead — pause/retry/gate know theirs
 *  before the click; resume's own `add` is a placeholder there (the
 *  recovered trigger is only known once the audit log is read, server-side),
 *  so its copy reads back the row's *current* stage name instead, valid the
 *  moment the post-write board refresh lands. */
function appliedCopy(action: OperatorAction, number: number, plan: ActionPlan | null, currentStageName: string | null): string {
  const n = String(number)
  switch (action) {
    case 'pause': {
      const removed = plan?.remove[0]
      return `Paused #${n} — removed "${removed !== undefined ? labelNameOf(removed) : ''}". No agent will pick it up now.`
    }
    case 'retry': {
      const removed = plan?.remove[0]
      const added = plan?.add[0]
      return `Retrying #${n} — "${removed !== undefined ? labelNameOf(removed) : ''}" → "${added !== undefined ? labelNameOf(added) : ''}". The next tick picks it up.`
    }
    case 'resume':
      return `Resumed #${n} — restored "${currentStageName ?? ''}".`
    case 'gate':
      return `Gate label added to #${n}. The "labeled" event re-runs the approval check, so the gate is live on that run.`
  }
}

/** `pause`'s own absent-key guard reads back as `not <name>` in the
 *  conflict's `expected` list (`shared/writes/scope.ts`'s `absentLabelName`)
 *  — detected here rather than duplicated, so the two can never drift. */
function preconditionFailedCopy(action: OperatorAction, number: number, conflict: Conflict, now: Date): string {
  const n = String(number)
  if (conflict.kind === 'precondition-failed') {
    const guard = action === 'pause' ? conflict.expected.find((entry) => entry.startsWith('not ')) : undefined
    if (guard !== undefined) {
      const claimed = guard.slice('not '.length)
      return `"${claimed}" is already on it — a stage claimed #${n}, so pausing would only remove a trigger that already did its job. Stop it from the cockpit: stop #${n}.`
    }
    const ageS = Math.max(0, Math.round((now.getTime() - Date.parse(conflict.readAt)) / 1000))
    return `#${n} moved while you were deciding. Expected ${conflict.expected.join(', ') || 'nothing'}; GitHub has ${conflict.observed.join(', ') || 'nothing'}, read ${String(ageS)}s ago. Nothing was written.`
  }
  return `#${n} moved while you were deciding. Nothing was written.`
}

const ACTION_PAST_TENSE: Readonly<Record<OperatorAction, string>> = { pause: 'paused', resume: 'resumed', retry: 'retried', gate: 'gated' }

function unclaimedScopeCopy(action: OperatorAction, number: number, claimPath: string, plan: ActionPlan | null): string {
  const key = plan?.remove[0] ?? plan?.add[0]
  const name = key !== undefined ? labelNameOf(key) : 'a plan-gate label'
  const n = String(number)
  return `#${n} wasn't ${ACTION_PAST_TENSE[action]}. That would touch "${name}", one of the plan gate's own labels, and the plan gate isn't claimed here (${claimPath}). Use ${action} #${n} in the cockpit.`
}

/** One switch over `WriteOutcome['kind']` (the plan's own **UX states**),
 *  plus the `ok: false` refusal reasons `applyItemAction` can return before
 *  ever calling `applyLabels` — a new variant on either union is a compile
 *  error here, never a silently blank note. `plan` is the row's own
 *  already-computed `ActionAvailability.plan` at click time — `null` only
 *  when the caller cannot supply one (never reachable from the board
 *  controller itself, which only ever calls this for an action it just
 *  ran). `currentStageName` is the row's own `stageLabel?.name` at render
 *  time — only `resume`'s `applied` copy reads it. */
export function actionResultCopy(params: {
  readonly action: OperatorAction
  readonly number: number
  readonly plan: ActionPlan | null
  readonly currentStageName: string | null
  readonly result: ItemActionResult
  readonly now: Date
}): string {
  const { action, number, plan, currentStageName, result, now } = params
  const n = String(number)

  if (!result.ok) {
    switch (result.reason) {
      case 'moved':
        return `#${n} is at "${result.observed}" now, not "${result.expected}". Nothing was written — the board will catch up.`
      case 'not-owned':
        return `@${result.owners[0] ?? 'someone else'} owns #${n}. Take it over in the cockpit (work on #${n}) before acting on it here.`
      case 'viewer-unknown':
        return "Can't tell which account you're signed in as, so ownership can't be checked."
      case 'repo-unavailable':
        return "Can't read this repository right now. Nothing was written."
      case 'no-pause-record':
        return `This app has no record of pausing #${n}, so it can't know which trigger to restore. Use resume #${n} in the cockpit.`
      case 'pause-record-unresolvable':
        return `The pause recorded for #${n} no longer matches a known label. Use resume #${n} in the cockpit.`
    }
  }

  const { outcome } = result
  switch (outcome.kind) {
    case 'applied':
      return appliedCopy(action, number, plan, currentStageName)
    case 'no-op':
      return `#${n} already reads that way. Nothing was written.`
    case 'precondition-failed':
      return preconditionFailedCopy(action, number, outcome.conflict, now)
    case 'unclaimed-scope':
      return unclaimedScopeCopy(action, number, outcome.claimPath, plan)
    case 'claim-unreadable':
      return `${outcome.claimPath} can't be read — ${outcome.message}. Until it is valid or removed, this app and the cockpit both stand down from the plan gate — nothing will answer #${n}. Fix or delete the file.`
    case 'unresolvable-label':
      return `This repository's label vocabulary doesn't resolve: ${outcome.keys.join(', ')}. Nothing was written.`
    case 'item-unavailable':
      return `#${n} is no longer available. Nothing was written.`
    case 'verify-failed':
      return `Couldn't re-read #${n} before writing — ${outcome.message}. Nothing was written.`
    case 'write-failed': {
      const base = `GitHub refused the write: ${outcome.stderr}.`
      const suffix = outcome.reread !== null ? ` #${n} now reads ${outcome.reread.labels.join(', ') || 'no labels'}.` : ` This app couldn't re-read #${n} afterwards, so what landed is unknown.`
      return base + suffix
    }
  }
}
