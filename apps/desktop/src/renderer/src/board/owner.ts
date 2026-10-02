// The dispatch-ownership line (#265) — one per ready repository, rendered
// under its own tick line (`view.ts`). Pure copy plus the line's own DOM;
// `main.ts` routes the Take/Release button's click to `window.port.
// dispatchClaimSet` through `board/dispatch.ts`'s `handleDispatchClick`, the
// same split every other board control already follows. #293: the budget
// clause and its per-candidate notes.
import type { BudgetNote, BudgetStatus, DispatcherState, RepoDispatchStatus } from '../../../shared/dispatch/types'
import { writeOutcomeCopy } from '../claim/copy'

function timeOf(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function activeLine(state: Extract<DispatcherState, { readonly kind: 'active' }>, claimedAt: string | null): string {
  const live = state.recent.filter((r) => r.state === 'sent' || r.state === 'started')
  if (live.length === 0) {
    const claimedPart = claimedAt !== null ? ` · claimed ${timeOf(claimedAt)}` : ''
    return `▶ Dispatch: this app${claimedPart} · nothing to dispatch.`
  }
  const newest = live.reduce((a, b) => (Date.parse(a.at) > Date.parse(b.at) ? a : b))
  const named = live.map((r) => `${r.agent} #${String(r.number)}`).join(', ')
  return `▶ Dispatch: this app · started ${named} at ${timeOf(newest.at)}.`
}

/** #293: appended to every owner-line state, including `cockpit`/`nobody` —
 *  the sweep that produces `budget.line` keeps going while this app's own
 *  agents are still active, regardless of who currently owns dispatch. `''`
 *  whenever there is nothing to append, so every caller can concatenate
 *  unconditionally. */
function budgetClause(budget: BudgetStatus | null): string {
  return budget !== null && budget.line !== null ? ` Budget: ${budget.line}` : ''
}

/** Exhaustive over `DispatchOwner` × `DispatcherState` (plan's own **UX
 *  states**) — a new member of either is a compile error here, never a
 *  silently blank line. `owner !== 'app'` never reads `status.state` at
 *  all, since only this app's own dispatcher ever has anything there. */
export function ownerLineCopy(status: RepoDispatchStatus): string {
  const clause = budgetClause(status.budget)

  if (status.owner === 'nobody') {
    return `⛔ Dispatch: nobody — .agents/gate-claim.json can't be read. This app and the cockpit both stand down. Fix or delete the file.${clause}`
  }
  if (status.owner === 'cockpit') {
    return `Dispatch: your terminal cockpit dispatches here. This app only reports what it would dispatch.${clause}`
  }

  // owner === 'app'
  const state = status.state
  switch (state.kind) {
    case 'idle':
      return activeLine({ kind: 'active', recent: [] }, status.claimedAt) + clause
    case 'active':
      return activeLine(state, status.claimedAt) + clause
    case 'budget-unavailable':
      return `⏸ Dispatch: this app, but not dispatching — ${state.message}`
    case 'dispatcher-failed':
      if (state.reason === 'at-capacity') {
        return `⚠ Dispatch: this app couldn't start its dispatcher — ${String(state.limit)} hosted sessions are already open, the limit. Close one and dispatch resumes on the next poll.`
      }
      if (state.reason === 'plugin') {
        return "⚠ Dispatch: the dispatcher's port plugin didn't load (missing). Nothing dispatches until it does."
      }
      return "⚠ Dispatch: the dispatcher's session failed to start. Nothing dispatches until it recovers."
    case 'agents-missing':
      return `⚠ Dispatch: the dispatcher has no port:${state.agent}-agent — Claude Code dropped it. Dispatch waits.`
  }
}

/** #293: one line per `BudgetNote` (plan's own **UX states** notes table) —
 *  exhaustive over `BudgetNote['kind']`, a new member is a compile error
 *  here rather than a silently blank line. `escalation-failed`'s "other"
 *  branch reuses `claim/copy.ts`'s own `writeOutcomeCopy` rather than a
 *  second `WriteOutcome` rendering. */
export function noteCopy(note: BudgetNote): string {
  switch (note.kind) {
    case 'held':
      return note.line
    case 'held-dispatched':
      return `⚠️ Still can't read #${String(note.number)}'s cost ledger after two polls — dispatched anyway; the ceiling isn't enforceable on this one until a read succeeds.`
    case 'escalated':
      return note.commentFailedMessage === null
        ? `⛔ #${String(note.number)} is over its budget ceiling — moved it to ${note.needsHumanLabel} and commented why.`
        : `⛔ #${String(note.number)} is over its budget ceiling — moved it to ${note.needsHumanLabel}, but the comment explaining why didn't post (${note.commentFailedMessage}).`
    case 'escalation-failed':
      if (note.outcome.kind === 'unclaimed-scope') {
        return `⛔ #${String(note.number)} is over its budget ceiling and won't dispatch, but removing ${note.triggerLabel} needs the plan gate claim. Take the plan gate here, or move it to ${note.needsHumanLabel} by hand.`
      }
      return `⛔ #${String(note.number)} is over its budget ceiling and won't dispatch — moving it to ${note.needsHumanLabel} failed: ${writeOutcomeCopy(note.number, note.outcome).line}`
    case 'gate-failed':
      return `⚠ #${String(note.number)} not dispatched — the budget script failed (${note.message}).`
  }
}

/** #293: every line this app's own budget gate adds under the owner line —
 *  the per-candidate notes, then the sweep's own problem line, if any. `[]`
 *  whenever `owner !== 'app'`: the clause still shows (`budgetClause`), but
 *  these are this app's own gate decisions, which only apply while it
 *  actually owns dispatch. */
function budgetNoteLines(status: RepoDispatchStatus): readonly string[] {
  if (status.owner !== 'app' || status.budget === null) return []
  const lines = status.budget.notes.map(noteCopy)
  return status.budget.problem !== null
    ? [...lines, `⚠ Budget sweep failed (${status.budget.problem}) — finished dispatches stay open and keep counting until a sweep succeeds.`]
    : lines
}

/** The button's own label and action — `null` for `nobody` (no control at
 *  all, per the plan's own UX table). */
function controlFor(status: RepoDispatchStatus): { readonly label: string; readonly action: 'dispatch-claim-take' | 'dispatch-claim-release'; readonly title: string } | null {
  if (status.owner === 'nobody') return null
  if (status.owner === 'cockpit') {
    return { label: 'Take dispatch', action: 'dispatch-claim-take', title: 'Stops a /port:pipeline cockpit in this checkout from dispatching.' }
  }
  return { label: 'Release dispatch', action: 'dispatch-claim-release', title: 'Hands dispatch back to a /port:pipeline cockpit in this checkout.' }
}

/** One repository's own owner line plus its Take/Release control, plus any
 *  budget-gate notes underneath (#293) — `view.ts` renders this directly
 *  under that repository's tick line. The control carries `data-repo-id` so
 *  `board/dispatch.ts`'s `handleDispatchClick` can resolve which repository
 *  a click names without a second lookup. */
export function buildOwnerLine(status: RepoDispatchStatus): HTMLElement {
  const group = document.createElement('div')
  group.className = 'board-header__owner-group'

  const line = document.createElement('div')
  line.className = 'board-header__owner-line'

  const text = document.createElement('span')
  text.className = 'board-header__owner-text'
  text.textContent = ownerLineCopy(status) + (status.draining ? ' · draining' : '')
  line.appendChild(text)

  const control = controlFor(status)
  if (control !== null) {
    const button = document.createElement('button')
    button.className = 'board-header__owner-button'
    button.dataset.action = control.action
    button.dataset.repoId = String(status.repoId)
    button.title = control.title
    button.textContent = control.label
    line.appendChild(button)
  }

  group.appendChild(line)

  for (const noteText of budgetNoteLines(status)) {
    const note = document.createElement('div')
    note.className = 'board-header__owner-note'
    note.textContent = noteText
    group.appendChild(note)
  }

  return group
}
