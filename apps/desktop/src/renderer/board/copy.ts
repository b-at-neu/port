// Every union the board renders gets its copy here, one `switch` each — a
// new variant is a compile error rather than a silently blank row (#80),
// the same rule `worktrees.ts`'s own header states. Pure string functions;
// no DOM here.
import type { ItemStatus, RepositoryFreshness, RepositoryState } from '@/types/state'
import type { BoardSnapshot, SourceHealth, SourceKind } from '@/types/board'
import { SOURCE_KINDS, isDeferred } from '@/types/board'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { RETRY_TRIGGER } from '@/utils/actions/plan'
import type { ActionPlan, ActionRefusal, ItemActionResult, OperatorAction, OperatorDecision } from '@/types/actions'
import type { Conflict } from '@/types/writes'
import type { StageAgent } from '@/types/tick'
import { worstHealth } from '@/renderer/board/project'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { PHASE_NAMES } from '@/renderer/lib/phase'

const STAGE_NAME: Readonly<Record<StageAgent, string>> = { plan: 'Planning', impl: 'Implementing', review: 'Reviewing', revise: 'Revising' }

/** The phase name a dispatched stage shows before its agent has swapped a label. */
export function stageAgentPhaseName(agent: StageAgent): string {
  return STAGE_NAME[agent]
}

function timeOf(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}


/** The board row's "Operator joined" pill label and its accessible tooltip. */
export function operatorJoinedTagLabel(): string {
  return 'Operator joined'
}

export function operatorJoinedTagTitle(): string {
  return "A person typed into this ticket's stage session"
}

/** The board row's "Dispatched" tag label and its accessible tooltip. */
export function dispatchedTagLabel(): string {
  return 'Dispatched'
}

export function dispatchedTagTitle(): string {
  return 'port started this stage. The label updates when the agent claims it.'
}

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
    case 'interrupted':
      return 'Interrupted'
  }
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
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
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

/** The earliest rate-limit deferral still in the future across every repository, `null` when none. */
function earliestDeferral(snapshot: BoardSnapshot, now: Date): string | null {
  const pending = snapshot.health.flatMap((h) => (isDeferred(h.github, now) && h.github.deferredUntil !== null ? [h.github.deferredUntil] : []))
  if (pending.length === 0) return null
  return pending.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
}

type IndicatorTone = 'muted' | 'attention'

/** The head of the Board header's label — GitHub's own state, first matching rule wins. A rate-limited read also counts as a failure, so the deferral is checked before the failing rule. */
function githubClause(snapshot: BoardSnapshot, github: SourceHealth, now: Date): { readonly text: string; readonly tone: IndicatorTone } {
  const lastSuccessAt = github.lastSuccessAt
  if (lastSuccessAt === null && github.consecutiveFailures === 0) return { text: 'Checking GitHub…', tone: 'muted' }

  const deferredUntil = earliestDeferral(snapshot, now)
  if (deferredUntil !== null) {
    const wait = `waiting for GitHub's rate limit until ${timeOf(deferredUntil)}`
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

/** The Board header's always-on timing label — `null` only when there is no repository health to read. */
export function freshnessIndicator(snapshot: BoardSnapshot, now: Date): { readonly label: string; readonly tone: IndicatorTone; readonly lines: readonly string[] } | null {
  const github = worstHealth(snapshot.health, 'github')
  if (github === null) return null

  const head = githubClause(snapshot, github, now)
  const failing = SOURCE_KINDS.filter((kind) => kind !== 'github' && (worstHealth(snapshot.health, kind)?.consecutiveFailures ?? 0) > 0)
  const label = failing.length > 0 ? `${head.text} · ${failing.map(sourceName).join(', ')} failing` : head.text
  const tone = failing.length > 0 ? 'attention' : head.tone

  const sourceLines = SOURCE_KINDS.map((kind) => {
    const worst = worstHealth(snapshot.health, kind)
    return worst !== null ? sourceHealthCopy(kind, worst, now) : null
  }).filter((line): line is string => line !== null)
  const rateLimit = snapshot.state.repositories.find((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)?.rateLimit ?? null
  const rateLimitText = rateLimit !== null ? rateLimitCopy(null, rateLimit.remaining, rateLimit.resetAt) : null

  return { label, tone, lines: rateLimitText !== null ? [...sourceLines, rateLimitText] : sourceLines }
}

// --- The phase list's history lines (R6) -----------------------------------

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

/** One phase history line's leading verb — falls back to `PHASE_NAMES` for a key with no dedicated event phrasing. */
export function phaseEventVerb(key: LabelKey): string {
  return PHASE_EVENT_VERB[key] ?? PHASE_NAMES[key] ?? key
}

/** `you` when `actor` is the signed-in viewer (case-insensitive), else `@login`. */
export function actorName(actor: string, viewer: string | null): string {
  return viewer !== null && actor.toLowerCase() === viewer.toLowerCase() ? 'you' : `@${actor}`
}

// --- The plan gate (#92) ----------------------------------------------------

export function reviewPlanButtonLabel(): string {
  return 'Review plan'
}

export function openPrButtonLabel(): string {
  return 'Open PR'
}

export function openTicketLinkLabel(): string {
  return 'Open ticket'
}

export function writeHistoryLinkLabel(): string {
  return 'History of writes'
}

/** `Open PR #<n>` beside a ticket link, bare `Open PR` for a pull request that is the whole item. */
export function openPrLinkLabel(number: number | null): string {
  return number === null ? openPrButtonLabel() : `${openPrButtonLabel()} #${String(number)}`
}

/** #313: the row tag for an `autoPlan` issue, at any phase — `docs/DESIGN.md`
 *  §6's own "Auto-plan" tag sentence, pinned by `scripts/checks/desktop-board.ts`. */
export function autoPlanTagLabel(): string {
  return 'Auto-plan'
}

export function autoPlanTagTitle(): string {
  return 'Opted in with auto-approve: its plan is approved without a review.'
}

/** The phase name for an `autoPlan` ticket at plan review that the app is about to approve — `docs/DESIGN.md` §6's own "Plan auto-approving" sentence. */
export function autoApprovingPhaseLabel(): string {
  return 'Plan auto-approving'
}

/** The tag on a pull request that closes no ticket — `docs/DESIGN.md` §6's own "No ticket" tag sentence, pinned by `scripts/checks/desktop-board.ts`. */
export function noTicketTagLabel(): string {
  return 'No ticket'
}

export function noTicketTagTitle(): string {
  return "This PR doesn't close a ticket. Add `Closes #N` to its description to link it."
}

// --- The operator decisions --------------------------------------------

export function decisionButtonLabel(decision: OperatorDecision): string {
  return decision === 'unblock' ? 'Unblock' : 'Request changes'
}

/** The row's own note for a `cycle-cap`/`rebase-decisions`/`agent-live` refusal — every
 *  other refusal is silent, the same as `actionRefusalNote`'s own rule. */
export function decisionRefusalNote(decision: OperatorDecision, reason: string, number: number): string | null {
  const n = String(number)
  if (reason === 'agent-live') {
    return `#${n}'s agent is still waiting in its session. Answer it there and it clears the block itself.`
  }
  if (reason === 'cycle-cap') {
    return `PR #${n} has used all its review cycles. Sending it back would escalate straight to "${labelNameOf('needsHuman')}". Merge it and open a follow-up, or raise reviewCycleCap.`
  }
  if (reason === 'rebase-decisions') {
    return `PR #${n} is waiting on rebase decisions port couldn't read — answer them with unblock #${n} in the cockpit.`
  }
  void decision
  return null
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
    case 'stop':
      return 'Stop'
    case 'gate':
      return 'Add gate label'
    case 'refresh':
      return 'Refresh'
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
    case 'stop':
      return 'Stopping…'
    case 'gate':
      return 'Adding…'
    case 'refresh':
      return 'Refreshing…'
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
    case 'stop': {
      const removed = plan?.remove[0]
      const removedName = removed !== undefined ? labelNameOf(removed) : ''
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

/** `pause`'s own absent-key guard reads back as `not <name>` in the
 *  conflict's `expected` list (`main/writes/scope.ts`'s `absentLabelName`)
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

const ACTION_PAST_TENSE: Readonly<Record<OperatorAction, string>> = { pause: 'paused', resume: 'resumed', retry: 'retried', stop: 'stopped', gate: 'gated', refresh: 'refreshed' }

function terminalOwnedCopy(action: OperatorAction, number: number, since: string): string {
  const n = String(number)
  return `#${n} wasn't ${ACTION_PAST_TENSE[action]} — your terminal cockpit has owned this repository since ${since}. Use ${action} #${n} there.`
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
    case 'terminal-owned':
      return terminalOwnedCopy(action, number, outcome.since)
    case 'ownership-unreadable':
      return `${outcome.path} can't be read — ${outcome.message}. Until it is valid or removed, this app and a terminal cockpit both stand down here — nothing will act on #${n}. Fix or delete the file.`
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
