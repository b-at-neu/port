// Every string the Board renders. A union's copy is an exhaustive record or switch, so a new variant is a compile error rather than a blank row.
import type { ItemStatus, RepositoryFreshness, RepositoryState } from '@/types/state'
import type { BlockedOnTag, BoardColumnKey, BoardSnapshot, SourceHealth, SourceKind, TicketSessionLink } from '@/types/board'
import type { BoardView } from '@/types/router'
import { SOURCE_KINDS, isDeferred } from '@/types/board'
import { labelNameOf } from '@/utils/labels/defaults'
import { RETRY_TRIGGER } from '@/utils/actions/plan'
import type { ActionPlan, ActionRefusal, ItemActionResult, OperatorAction, OperatorDecision } from '@/types/actions'
import type { Conflict } from '@/types/writes'
import type { HaltItemOutcome, HaltReport } from '@/types/dispatch'
import type { RepoProblem } from '@/utils/repos'
import type { StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { worstHealth } from '@/renderer/board/project'
import { stageNameOfKey } from '@/renderer/lib/ticket-view'
import { mirrorReason } from '@/renderer/lib/mirror-reason'
import { formatAgoSeconds, formatAgoSince, formatShortTime } from '@/renderer/lib/time'
import { formatCost } from '@/utils/hosting/usage'
import { BACKLOG_BLOCKED_TOOLTIP_HEADING, backlogBlockerLine } from '@/renderer/backlog/copy'

export { BACKLOG_BLOCKED_TOOLTIP_HEADING as BLOCKED_DEPENDENCY_HEADING, backlogBlockerLine as blockedDependencyLine, backlogBlockerTruncatedCopy as blockedTruncatedCopy } from '@/renderer/backlog/copy'

export const BOARD_TITLE = 'Board'
export const ALL_REPOSITORIES = 'All repositories'
export const REFRESH_LABEL = 'Refresh'
export const BOARD_LAYOUT_LABEL = 'Board layout'
export const BOARD_UNREACHABLE = "Couldn't reach the main process to read the board. Restart port to try again."
export const NO_REPOSITORIES_EMPTY = 'Add a repository to see its pipeline.'
export const OPEN_REPOSITORIES_LABEL = 'Open Repositories'
export const SHOW_ALL_REPOSITORIES_LABEL = 'Show all repositories'
export const EMPTY_COLUMN_LABEL = 'No tickets'
export const CLOSE_DETAILS_LABEL = 'Close details'
export const PAST_SESSIONS_UNREADABLE = "Couldn't load past sessions. Live sessions still show."

export function nothingAssignedEmpty(scoped: boolean): string {
  return scoped ? "Nothing assigned to you in this repository's pipeline." : 'Nothing assigned to you in the pipeline.'
}

const MARKER_NAME = labelNameOf('marker')

export const UNGATED_TAG_LABEL = 'Ungated'
export const UNGATED_TAG_TITLE = `Carries a pipeline label but not "${MARKER_NAME}", so CI can't tell it from a human PR and the merge gate is inactive.`
export const UNGATED_BANNER_NOTE = `These carry a pipeline label but not "${MARKER_NAME}", so CI can't tell them from a human pull request and the merge gate is inactive.`

export function ungatedBannerHeading(count: number): string {
  return `Ungated pull requests · ${String(count)}`
}

export const OPERATOR_JOINED_TAG_LABEL = 'Operator joined'
export const OPERATOR_JOINED_TAG_TITLE = "A person typed into this ticket's stage session"
export const DISPATCHED_TAG_LABEL = 'Dispatched'
export const DISPATCHED_TAG_TITLE = 'port started this stage. The label updates when the agent claims it.'
export const AUTO_PLAN_TAG_LABEL = 'Auto-plan'
export const AUTO_PLAN_TAG_TITLE = 'Opted in with auto-approve: its plan is approved without a review.'
export const AUTO_APPROVING_PHASE_LABEL = 'Plan auto-approving'
export const NO_TICKET_TAG_LABEL = 'No ticket'
export const NO_TICKET_TAG_TITLE = "This PR doesn't close a ticket. Add `Closes #N` to its description to link it."

const COLUMN_NAMES: Readonly<Record<BoardColumnKey, string>> = { queued: 'Queued', plan: 'Plan', implement: 'Implement', review: 'Review', revise: 'Revise', 'needs-you': 'Needs you' }

export function columnName(key: BoardColumnKey): string {
  return COLUMN_NAMES[key]
}

/** The accessible name of a swimlane's collapse toggle. */
export function laneToggleAria(name: string, collapsed: boolean): string {
  return `${collapsed ? 'Expand' : 'Collapse'} ${name}`
}

export function boardViewLabel(view: BoardView): string {
  return view === 'board' ? 'Board' : 'List'
}

export const STATUS_WORDS: Readonly<Record<ItemStatus, string>> = { waiting: 'Waiting', 'in-flight': 'In flight', stalled: 'Stalled', gated: 'Awaiting human', terminal: 'Terminal', unstaged: 'Unstaged', interrupted: 'Interrupted' }

const SOURCE_NAMES: Readonly<Record<SourceKind, string>> = { github: 'GitHub', sessions: 'Sessions', worktrees: 'Worktrees', denials: 'Denials' }

function ageCopy(at: string | null, now: Date): string {
  return at === null ? 'never read' : formatAgoSeconds(now.getTime() - Date.parse(at))
}

export function sourceHealthCopy(kind: SourceKind, health: SourceHealth, now: Date): string {
  const name = SOURCE_NAMES[kind]
  if (health.lastSuccessAt === null && health.consecutiveFailures === 0) return `${name} — reading…`
  if (health.consecutiveFailures === 0) return `${name} ${ageCopy(health.lastSuccessAt, now)}`
  if (health.lastSuccessAt === null) return `${name} — never read. ${health.lastError ?? ''}`.trim()
  return `${name} — retrying. Showing what was read ${ageCopy(health.lastSuccessAt, now)}.`
}

export function rateLimitCopy(freshness: RepositoryFreshness | null, remaining: number | null, resetAt: string | null): string | null {
  void freshness
  if (remaining === null || resetAt === null) return null
  return `${remaining.toLocaleString()} API points left, resets ${formatShortTime(resetAt)}`
}

/** The earliest rate-limit deferral still in the future across every repository, `null` when none. */
function earliestDeferral(snapshot: BoardSnapshot, now: Date): string | null {
  const pending = snapshot.health.flatMap((h) => (isDeferred(h.github, now) && h.github.deferredUntil !== null ? [h.github.deferredUntil] : []))
  if (pending.length === 0) return null
  return pending.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
}

type IndicatorTone = 'muted' | 'attention'

/** The head of the Board header's label: GitHub's own state, first matching rule wins. A rate-limited read also counts as a failure, so the deferral is checked first. */
function githubClause(snapshot: BoardSnapshot, github: SourceHealth, now: Date): { readonly text: string; readonly tone: IndicatorTone } {
  const lastSuccessAt = github.lastSuccessAt
  if (lastSuccessAt === null && github.consecutiveFailures === 0) return { text: 'Checking GitHub…', tone: 'muted' }

  const deferredUntil = earliestDeferral(snapshot, now)
  if (deferredUntil !== null) {
    const wait = `waiting for GitHub's rate limit until ${formatShortTime(deferredUntil)}`
    return { text: lastSuccessAt !== null ? `Checked GitHub ${ageCopy(lastSuccessAt, now)} · ${wait}` : `Checking GitHub — ${wait}`, tone: 'muted' }
  }

  if (github.consecutiveFailures > 0) {
    const lastGood = lastSuccessAt !== null ? `last good ${ageCopy(lastSuccessAt, now)}` : 'never read'
    return { text: `GitHub check failing — ${lastGood}`, tone: 'attention' }
  }

  if (lastSuccessAt === null) return { text: 'Checking GitHub…', tone: 'muted' }
  const stale = now.getTime() - Date.parse(lastSuccessAt) > github.intervalMs * 2
  return { text: `Checked GitHub ${ageCopy(lastSuccessAt, now)}`, tone: stale ? 'attention' : 'muted' }
}

/** The Board header's always-on timing label; `null` only when there is no repository health to read. */
export function freshnessIndicator(snapshot: BoardSnapshot, now: Date): { readonly label: string; readonly tone: IndicatorTone; readonly lines: readonly string[] } | null {
  const github = worstHealth(snapshot.health, 'github')
  if (github === null) return null

  const head = githubClause(snapshot, github, now)
  const failing = SOURCE_KINDS.filter((kind) => kind !== 'github' && (worstHealth(snapshot.health, kind)?.consecutiveFailures ?? 0) > 0)
  const label = failing.length > 0 ? `${head.text} · ${failing.map((kind) => SOURCE_NAMES[kind]).join(', ')} failing` : head.text
  const tone = failing.length > 0 ? 'attention' : head.tone

  const sourceLines = SOURCE_KINDS.map((kind) => {
    const worst = worstHealth(snapshot.health, kind)
    return worst !== null ? sourceHealthCopy(kind, worst, now) : null
  }).filter((line): line is string => line !== null)
  const rateLimit = snapshot.state.repositories.find((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)?.rateLimit ?? null
  const rateLimitText = rateLimit !== null ? rateLimitCopy(null, rateLimit.remaining, rateLimit.resetAt) : null

  return { label, tone, lines: rateLimitText !== null ? [...sourceLines, rateLimitText] : sourceLines }
}

// --- Phase history ----------------------------------------------------------

const PHASE_EVENT_VERB: Readonly<Partial<Record<LabelKey, string>>> = {
  ready: 'Queued for planning',
  planning: 'Planning started',
  planChangesRequested: 'Plan changes requested',
  planReview: 'Plan ready for review',
  planApproved: 'Plan approved',
  inProgress: 'Implementation started',
  readyForReview: 'Ready for review',
  reviewing: 'Review started',
  needsRevision: 'Changes requested',
  revising: 'Revision started',
  approved: 'Approved',
  refreshBranch: 'Branch refresh requested',
  refreshing: 'Branch refresh started',
  needsHuman: 'Escalated to you',
  blocked: 'Blocked',
}

/** One phase history line's leading verb; a key with no dedicated phrasing falls back to the stage table's name. */
export function phaseEventVerb(key: LabelKey): string {
  return PHASE_EVENT_VERB[key] ?? stageNameOfKey(key) ?? key
}

/** `you` when `actor` is the signed-in viewer (case-insensitive), else `@login`. */
export function actorName(actor: string, viewer: string | null): string {
  return viewer !== null && actor.toLowerCase() === viewer.toLowerCase() ? 'you' : `@${actor}`
}

// --- The plan gate ------------------------------------------------------------

export const REVIEW_PLAN_LABEL = 'Review plan'
export const OPEN_PR_LABEL = 'Open PR'
export const OPEN_TICKET_LABEL = 'Open ticket'
export const WRITE_HISTORY_LABEL = 'History of writes'

/** `Open PR #<n>` beside a ticket link, bare `Open PR` for a pull request that is the whole item. */
export function openPrLinkLabel(number: number | null): string {
  return number === null ? OPEN_PR_LABEL : `${OPEN_PR_LABEL} #${String(number)}`
}

export const DECISION_BUTTON_LABELS: Readonly<Record<OperatorDecision, string>> = { unblock: 'Unblock', revise: 'Request changes', grant: 'Grant one more cycle' }

/** The row's note for a `cycle-cap`, `rebase-decisions` or `agent-live` refusal; every other refusal is silent. */
export function decisionRefusalNote(reason: string, number: number): string | null {
  const n = String(number)
  if (reason === 'agent-live') return `#${n}'s agent is still waiting in its session. Answer it there and it clears the block itself.`
  if (reason === 'cycle-cap') return `PR #${n} has used all its review cycles. Sending it back would escalate straight to "${labelNameOf('needsHuman')}". Merge it and open a follow-up, or raise reviewCycleCap.`
  if (reason === 'rebase-decisions') return `PR #${n} is waiting on rebase decisions port couldn't read — answer them with unblock #${n} in the cockpit.`
  return null
}

export const ACTION_BUTTON_LABELS: Readonly<Record<OperatorAction, string>> = { pause: 'Pause', resume: 'Resume', retry: 'Retry', stop: 'Stop', gate: 'Add gate label', refresh: REFRESH_LABEL }
export const ACTION_PENDING_LABELS: Readonly<Record<OperatorAction, string>> = { pause: 'Pausing…', resume: 'Resuming…', retry: 'Retrying…', stop: 'Stopping…', gate: 'Adding…', refresh: 'Refreshing…' }

export function actionInProgressTooltip(number: number): string {
  return `Another action on #${String(number)} is already in progress.`
}

/** The row's ownership note before anything has been clicked; `null` for `not-applicable`, which has nothing to say. */
export function actionRefusalNote(reason: ActionRefusal, item: { readonly number: number; readonly assignees: readonly string[] }): string | null {
  if (reason === 'viewer-unknown') return "Can't tell which account you're signed in as, so ownership can't be checked."
  if (reason === 'not-owned') {
    const owner = item.assignees[0] ?? 'someone else'
    return `@${owner} owns #${String(item.number)}. Take it over in the cockpit (work on #${String(item.number)}) before acting on it here.`
  }
  return null
}

/** `applied` carries no resulting label set, so the names come from the row's own `plan`; resume's plan holds a placeholder, so it reads the row's current stage name instead. */
function appliedCopy(action: OperatorAction, number: number, plan: ActionPlan | null, currentStageName: string | null): string {
  const n = String(number)
  const removed = plan?.remove[0]
  const removedName = removed !== undefined ? labelNameOf(removed) : ''
  switch (action) {
    case 'pause':
      return `Paused #${n} — removed "${removedName}". No agent will pick it up now.`
    case 'retry': {
      const added = plan?.add[0]
      return `Retrying #${n} — "${removedName}" → "${added !== undefined ? labelNameOf(added) : ''}". The next tick picks it up.`
    }
    case 'resume':
      return `Resumed #${n} — restored "${currentStageName ?? ''}".`
    case 'stop': {
      const restoreKey = removed !== undefined ? RETRY_TRIGGER[removed] : undefined
      const restoreName = restoreKey !== undefined ? labelNameOf(restoreKey) : null
      return restoreName !== null
        ? `Stopped #${n} — removed "${removedName}". Nothing will dispatch it now; Resume restores "${restoreName}".`
        : `Stopped #${n} — removed "${removedName}". Nothing will dispatch it now.`
    }
    case 'gate':
      return `Gate label added to #${n}. The "labeled" event re-runs the approval check, so the gate is live on that run.`
    case 'refresh':
      return `Refreshing #${n} — added "${labelNameOf('refreshBranch')}". The next tick rebases it onto its base and force-pushes.`
  }
}

/** `pause`'s absent-key guard reads back as `not <name>` in the conflict's `expected` list. */
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

/** One line per refusal reason and per `WriteOutcome` kind. `currentStageName` is only read by `resume`'s `applied` copy. */
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
    case 'ownership-unreadable':
      return `${outcome.path} can't be read — ${outcome.message}. Until it is valid or removed, this app stands down here — nothing will act on #${n}. Fix or delete the file.`
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
    case 'state-unsaved':
      return `port couldn't save its pipeline state for #${n}, so nothing changed — ${outcome.message}. Try again.`
    case 'mirror-failed': {
      const added = plan?.add[0]
      const phase = added === undefined ? 'its new state' : (stageNameOfKey(added) ?? labelNameOf(added))
      return `#${n} moved to ${phase}, but its GitHub label couldn't be updated — ${mirrorReason(outcome.mirror)}. The next write will correct it.`
    }
  }
}

// --- The stop report ----------------------------------------------------------

function skippedLine(outcome: Extract<HaltItemOutcome, { readonly kind: 'skipped' }>): string {
  const n = String(outcome.number)
  switch (outcome.reason) {
    case 'session-required':
      return `#${n} skipped — session required; your own /port:implement session owns it.`
    case 'not-owned':
      return `#${n} skipped — @${outcome.owner ?? 'someone else'} owns it.`
    case 'viewer-unknown':
      return `#${n} skipped — can't tell which account you're signed in as.`
  }
}

/** A stage name (`review-agent`) shortens to `review`; an operator's `/port:implement session` is left as is. */
function agentLabel(attachedAgent: string | null): string {
  if (attachedAgent === null) return ''
  return attachedAgent.endsWith('-agent') ? attachedAgent.slice(0, -'-agent'.length) : attachedAgent
}

/** One line per outcome. A refused item reuses the row action's own result copy. */
export function haltItemLine(outcome: HaltItemOutcome, now: Date): string {
  const n = String(outcome.number)
  switch (outcome.kind) {
    case 'stopped': {
      if (outcome.stoppedTask) {
        const agent = agentLabel(outcome.attachedAgent)
        return `#${n} ${outcome.removedLabel} → no stage. Stopped${agent ? ` ${agent}` : ''} #${n}.`
      }
      const attached = outcome.attachedAgent !== null ? ` ${outcome.attachedAgent} still attached — this app can't stop it.` : ''
      return `#${n} ${outcome.removedLabel} → no stage.${attached}`
    }
    case 'skipped':
      return skippedLine(outcome)
    case 'refused':
      return `#${n} not stopped — ${actionResultCopy({ action: 'stop', number: outcome.number, plan: null, currentStageName: null, result: outcome.result, now })}`
  }
}

/** `N stopped, M skipped`, plus a `, K not stopped` clause only when a refusal happened. */
export function haltHeadingCopy(report: Extract<HaltReport, { readonly kind: 'completed' }>, leadingWord = 'Halted'): string {
  const stopped = report.items.filter((item) => item.kind === 'stopped').length
  const skipped = report.items.filter((item) => item.kind === 'skipped').length
  const refused = report.items.filter((item) => item.kind === 'refused').length
  const refusedPart = refused > 0 ? `, ${String(refused)} not stopped` : ''
  return `${leadingWord} · ${String(stopped)} stopped, ${String(skipped)} skipped${refusedPart}`
}

// --- Repository problems ------------------------------------------------------

export function repoProblemCopy(problem: RepoProblem): string {
  switch (problem.kind) {
    case 'directory-missing':
      return "That folder is gone. It may have moved, or be on a drive that isn't mounted."
    case 'not-a-git-repository':
      return "Not a git repository. Pick the repository's root folder."
    case 'not-port-managed':
      return problem.carriedBy.length > 0
        ? `Not port-managed on ${problem.ref}. ${problem.carriedBy.join(', ')} carry the harness — merge one into the default branch, then rescan.`
        : "Not port-managed. There's no .claude/port.config.json on any branch here."
    case 'config-ref-unreadable':
      return `Can't read the default branch at origin/HEAD — ${problem.message}.`
    case 'config-malformed':
      return `.claude/port.config.json isn't valid JSON — ${problem.message}.`
    case 'config-invalid':
      return `.claude/port.config.json has no usable repo: ${problem.violations[0]?.message ?? 'invalid'}.`
    case 'config-unreadable':
      return `Can't read .claude/port.config.json — ${problem.message}.`
    case 'effective-config-unreadable':
      return `Can't read ${problem.file} — ${problem.message}.`
  }
}

export function notReadyCopy(state: Extract<RepositoryState, { readonly ok: false }>): string {
  if (state.reason === 'not-ready') return repoProblemCopy(state.problem)
  return `Couldn't reach GitHub: ${state.message}. Retrying automatically.`
}

// --- Blocked tickets ----------------------------------------------------------

export const BLOCKED_SECTION_HEADING = 'Blocked on'
export const BLOCKED_AGENT_SAYS = 'The agent says:'
export const BLOCKED_FROM_TICKET = 'From the ticket:'
export const BLOCKED_OPEN_COMMENT = 'Open comment'
export const BLOCKED_FALLBACK_COPY = 'An agent marked this blocked. Its reason is on the ticket.'
export const BLOCKER_ANSWER_LABEL = 'Your answer'
export const BLOCKER_SEND_LABEL = 'Send to agent'

export function blockedUnreadableCopy(reason: string): string {
  return `Couldn't read this ticket's blocked-by links: ${reason}.`
}

/** The row tag's visible text. */
export function blockedTagLabel(tag: BlockedOnTag): string {
  switch (tag.kind) {
    case 'dependency': {
      const first = tag.open[0]
      const more = tag.open.length - 1
      return `Waiting on #${String(first?.number ?? 0)}${more > 0 ? ` +${String(more)}` : ''}`
    }
    case 'session':
    case 'comment':
      return tag.text
    case 'unreadable':
      return 'Blockers unknown'
    case 'fallback':
      return 'Reason on ticket'
  }
}

/** The tag's tooltip and accessible name as one string; a dependency tag's tooltip also lists each blocker. */
export function blockedTagSummary(tag: BlockedOnTag): string {
  switch (tag.kind) {
    case 'dependency':
      return `${BACKLOG_BLOCKED_TOOLTIP_HEADING} ${tag.open.map(backlogBlockerLine).join(', ')}`
    case 'session':
    case 'comment':
      return `Blocked: ${tag.text}`
    case 'unreadable':
      return blockedUnreadableCopy(tag.reason)
    case 'fallback':
      return BLOCKED_FALLBACK_COPY
  }
}

export function blockerSentToast(number: number | null): string {
  return `Sent your answer to ${number !== null ? `#${String(number)}'s` : 'the'} agent. It clears "Blocked" itself and carries on.`
}

export function blockerSendError(error: 'unknown-session' | 'blocked-command' | 'unreachable', number: number | null): string {
  if (error === 'unreachable') return "Couldn't reach the main process. Nothing was sent."
  if (error === 'blocked-command') return "That text is a command the session can't run here. Reword your answer."
  return `That session has ended. Unblock ${number !== null ? `#${String(number)}` : 'the item'} from its row once the board catches up.`
}

// --- Session links ------------------------------------------------------------

export const YOUR_SESSIONS_LABEL = 'Your sessions'

const SESSION_LINK_NAME: Readonly<Record<StageAgent, string>> = { plan: 'Plan agent', impl: 'Implement agent', review: 'Review agent', revise: 'Revise agent' }

/** A session link's own name: its agent, or `Your session`. */
export function sessionLinkName(who: TicketSessionLink['who']): string {
  return who.kind === 'stage' ? SESSION_LINK_NAME[who.agent] : 'Your session'
}

function stateSegment(link: TicketSessionLink, now: Date): string {
  switch (link.state) {
    case 'live':
      return `Live · started ${formatAgoSince(link.at, now)}`
    case 'ended':
      return `Ended ${formatAgoSince(link.endedAt ?? link.at, now)}`
    case 'started':
      return `Started ${formatAgoSince(link.at, now)}`
    case 'seen':
      return `Last active ${formatAgoSince(link.at, now)}`
  }
}

/** `Live · started 12m ago · $0.42`, `Ended 2h ago · $1.18`; the cost segment is omitted when unknown, never `$0.00`. */
export function sessionLinkMeta(link: TicketSessionLink, now: Date): string {
  const segments = [stateSegment(link, now)]
  if (link.costUsd !== null) segments.push(formatCost(link.costUsd))
  if (link.operatorJoined) segments.push('you joined')
  return segments.join(' · ')
}

export function sessionLinkAccessibleName(link: TicketSessionLink, now: Date): string {
  return `Open ${sessionLinkName(link.who)}, ${sessionLinkMeta(link, now)}`
}
