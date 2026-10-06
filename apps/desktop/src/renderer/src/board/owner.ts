// The dispatch-ownership line (#265) — one per ready repository, rendered
// under its own tick line (`view.ts`). Pure copy plus the line's own DOM;
// `main.ts` routes the Take/Release button's click to `window.port.
// dispatchClaimSet` through `board/dispatch.ts`'s `handleDispatchClick`, the
// same split every other board control already follows. #293: the budget
// clause and its per-candidate notes.
import type { BudgetNote, BudgetStatus, DispatcherState, ObservationRecord, RepoDispatchStatus } from '../../../shared/dispatch/types'
import type { TickObservationKind } from '../../../shared/tick/types'
import { writeOutcomeCopy } from '../claim/copy'

function timeOf(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function activeLine(state: Extract<DispatcherState, { readonly kind: 'active' }>, claimedAt: string | null): string {
  const live = state.recent.filter((r) => r.state === 'started')
  const claimedPart = claimedAt !== null ? ` · claimed ${timeOf(claimedAt)}` : ''
  const newestFailed = [...state.recent].reverse().find((r) => r.state === 'failed')
  const failedClause = newestFailed !== null && newestFailed !== undefined ? ` · couldn't start ${newestFailed.agent} #${String(newestFailed.number)} (${newestFailed.detail ?? 'unknown error'}).` : ''
  if (live.length === 0) {
    return `▶ Dispatch: this app${claimedPart} · nothing to dispatch.${failedClause}`
  }
  const newest = live.reduce((a, b) => (Date.parse(a.at) > Date.parse(b.at) ? a : b))
  const named = live.map((r) => `${r.agent} #${String(r.number)}`).join(', ')
  return `▶ Dispatch: this app · started ${named} at ${timeOf(newest.at)}.${failedClause}`
}

/** #292: per-kind phrasing for the owner line's "newest observation" clause
 *  (plan's own **UX states**, "Owner line clause") — every
 *  `TickObservationKind` is covered so a new member is a compile error here,
 *  even though `refresh-deferred` is report-only and never actually reaches
 *  `RepoDispatchStatus.observed` (`main/tick/dispatchable.ts`'s
 *  `observableFrom` never emits it as a write — covered here only to keep
 *  this table exhaustive). */
interface ObservationCopy {
  readonly written: (n: string, at: string) => string
  readonly already: (n: string) => string
  readonly moved: (n: string) => string
  readonly refusedPlanGate: ((n: string) => string) | null
  readonly refusedDispatch: (n: string) => string
  readonly failed: (n: string) => string
  readonly commentFailed: (n: string) => string
}

const OBSERVATION_COPY: Record<TickObservationKind, ObservationCopy> = {
  'liveness-reset': {
    written: (n, at) => `♻️ reset #${n} at ${at} — no agent was attached to it.`,
    already: (n) => `#${n} was already reset.`,
    moved: (n) => `#${n} moved before this app could reset it — nothing was written.`,
    refusedPlanGate: (n) => `couldn't reset #${n} — moving it back needs the plan gate too. Take the plan gate, or say retry #${n} in the cockpit.`,
    refusedDispatch: (n) => `didn't reset #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't reset #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `reset #${n}, but its explanation comment didn't post.`,
  },
  'cycle-cap': {
    written: (n, at) => `⛔ escalated #${n} to needs human at ${at} — the review cycle cap was reached.`,
    already: (n) => `#${n} was already escalated.`,
    moved: (n) => `#${n} moved before this app could escalate it — nothing was written.`,
    refusedPlanGate: null,
    refusedDispatch: (n) => `didn't escalate #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't escalate #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `escalated #${n}, but its explanation comment didn't post.`,
  },
  'zero-diff': {
    written: (n, at) => `⛔ escalated #${n} to needs human at ${at} — the latest review already covers the current head.`,
    already: (n) => `#${n} was already escalated.`,
    moved: (n) => `#${n} moved before this app could escalate it — nothing was written.`,
    refusedPlanGate: null,
    refusedDispatch: (n) => `didn't escalate #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't escalate #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `escalated #${n}, but its explanation comment didn't post.`,
  },
  refresh: {
    written: (n, at) => `🔄 refreshing #${n} at ${at} — it conflicts with the base branch; added refresh branch.`,
    already: (n) => `#${n} was already refreshing.`,
    moved: (n) => `#${n} moved before this app could refresh it — nothing was written.`,
    refusedPlanGate: null,
    refusedDispatch: (n) => `didn't refresh #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't refresh #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `refreshed #${n}, but its explanation comment didn't post.`,
  },
  'refresh-stuck': {
    written: (n, at) => `⛔ escalated #${n} to needs human at ${at} — still conflicting after a refresh.`,
    already: (n) => `#${n} was already escalated.`,
    moved: (n) => `#${n} moved before this app could escalate it — nothing was written.`,
    refusedPlanGate: null,
    refusedDispatch: (n) => `didn't escalate #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't escalate #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `escalated #${n}, but its explanation comment didn't post.`,
  },
  'withdraw-approval': {
    written: (n, at) => `↩️ withdrew approval on #${n} at ${at} — a required check went red.`,
    already: (n) => `#${n}'s approval was already withdrawn.`,
    moved: (n) => `#${n} moved before this app could withdraw approval — nothing was written.`,
    refusedPlanGate: null,
    refusedDispatch: (n) => `didn't withdraw approval on #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't withdraw approval on #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `withdrew approval on #${n}, but its explanation comment didn't post.`,
  },
  'refresh-deferred': {
    written: (n, at) => `updated #${n} at ${at}.`,
    already: (n) => `#${n} was already up to date.`,
    moved: (n) => `#${n} moved before this app could act on it — nothing was written.`,
    refusedPlanGate: null,
    refusedDispatch: (n) => `didn't act on #${n} — dispatch was released mid-pass.`,
    failed: (n) => `⚠ couldn't act on #${n} — GitHub refused the write. The next poll decides again.`,
    commentFailed: (n) => `acted on #${n}, but its explanation comment didn't post.`,
  },
}

function recordClause(record: ObservationRecord): string {
  const n = String(record.number)
  const copy = OBSERVATION_COPY[record.kind]
  switch (record.outcome) {
    case 'written':
      return record.comment === 'failed' ? copy.commentFailed(n) : copy.written(n, timeOf(record.at))
    case 'already':
      return copy.already(n)
    case 'moved':
      return copy.moved(n)
    case 'refused':
      return record.scope === 'plan-gate' && copy.refusedPlanGate !== null ? copy.refusedPlanGate(n) : copy.refusedDispatch(n)
    case 'failed':
      return copy.failed(n)
  }
}

/** #292: the newest `observed` record's clause, appended to the owner line
 *  while `owner === 'app'` (plan's own **UX states**, "Owner line clause").
 *  `''` when nothing has been observed yet, so every caller can concatenate
 *  unconditionally the same way `budgetClause` already does. */
export function observationClause(observed: readonly ObservationRecord[]): string {
  const newest = observed[observed.length - 1]
  if (newest === undefined) return ''
  return ` · ${recordClause(newest)}`
}

/** Every record, newest first, for the owner line's hover title — plan's own
 *  "Put every record (newest first) in the line's title." `null` when there
 *  is nothing to show, so the line keeps whatever `title` it already has. */
export function observationTitle(observed: readonly ObservationRecord[]): string | null {
  if (observed.length === 0) return null
  return observed
    .slice()
    .reverse()
    .map((r) => `#${String(r.number)} ${r.kind} — ${r.outcome} at ${timeOf(r.at)}`)
    .join('\n')
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
    case 'no-launcher':
      return "⏸ Dispatch: this app, but it can't start stage sessions yet — nothing dispatches here. Release dispatch to hand it back to your terminal cockpit."
    case 'at-capacity': {
      const waitingWord = state.waiting === 1 ? '1 waiting' : `${String(state.waiting)} waiting`
      return `⏸ Dispatch: this app · ${waitingWord} for a session slot — all ${String(state.limit)} are in use. Close a session or raise the limit; they start on the next poll.`
    }
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
export function budgetNoteLines(status: RepoDispatchStatus): readonly string[] {
  if (status.owner !== 'app' || status.budget === null) return []
  const lines = status.budget.notes.map(noteCopy)
  return status.budget.problem !== null
    ? [...lines, `⚠ Budget sweep failed (${status.budget.problem}) — finished dispatches stay open and keep counting until a sweep succeeds.`]
    : lines
}

/** The button's own label and action — `null` for `nobody` (no control at
 *  all, per the plan's own UX table). `pipeline-status.tsx` calls
 *  `setDispatchClaim(repoId, action === 'dispatch-claim-take')` directly on
 *  click, rather than dispatching through a `data-action` string. */
export function controlFor(status: RepoDispatchStatus): { readonly label: string; readonly action: 'dispatch-claim-take' | 'dispatch-claim-release'; readonly title: string } | null {
  if (status.owner === 'nobody') return null
  if (status.owner === 'cockpit') {
    return { label: 'Take dispatch', action: 'dispatch-claim-take', title: 'Stops a /port:pipeline cockpit in this checkout from dispatching.' }
  }
  return { label: 'Release dispatch', action: 'dispatch-claim-release', title: 'Hands dispatch back to a /port:pipeline cockpit in this checkout.' }
}

/** The owner line's own run-state suffix (plain concatenation, no state
 *  machine) — `pipeline-status.tsx` appends this to `ownerLineCopy`'s own
 *  text itself, the same way `buildOwnerLine` used to before it was deleted
 *  in favour of that component. */
export function runStateSuffix(runState: RepoDispatchStatus['runState']): string {
  return runState === 'draining' ? ' · draining' : runState === 'paused' ? ' · paused' : ''
}
