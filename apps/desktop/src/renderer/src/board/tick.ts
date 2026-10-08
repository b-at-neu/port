// The tick strip's own pure copy (#105, #319) — one switch per union so a
// new variant is a compile error rather than a silently blank line, the
// same rule `board/copy.ts`'s own header states. `board/pipeline-status.tsx`
// renders this through `repositoryDetailLines`/`itemDetailLines` below,
// re-reading on every poll so the countdown and the hover detail stay live.
import type { RepositoryHealth } from '../../../shared/board/types'
import type { DispatchOwner, RunState, RunStatesSnapshot } from '../../../shared/dispatch/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { TickActionable, TickBlind, TickClaim, TickHeld, TickObservation, TickReport } from '../../../shared/tick/types'

function labelNameOf(key: LabelKey): string {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.name ?? key
}

/** `nextWakeupAt` first: `null` renders the honest "no wakeup scheduled"
 *  (#62). A due instant that came from a rate-limit deferral (any
 *  repository's `github.deferredUntil` matching it) reads as the wait it
 *  actually is, never an ordinary countdown. */
export function clockLineCopy(nextWakeupAt: string | null, health: readonly RepositoryHealth[], now: Date): string {
  if (nextWakeupAt === null) return 'No wakeup scheduled.'
  const dueAt = Date.parse(nextWakeupAt)
  if (Number.isNaN(dueAt)) return 'No wakeup scheduled.'

  const deferred = health.some((h) => h.github.deferredUntil !== null && Date.parse(h.github.deferredUntil) === dueAt)
  if (deferred) {
    const label = new Date(dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `Next wakeup ${label} — waiting out the GitHub rate-limit window.`
  }

  const remainingMs = dueAt - now.getTime()
  if (remainingMs <= 0) return 'Next wakeup — now'
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Next wakeup in ${String(minutes)}:${String(seconds).padStart(2, '0')}`
}

/** The store line, directly above the clock line (#110, #314's own **UX
 *  states**) — `null` once the run-state store has actually loaded, since
 *  the clock line already carries the countdown and nothing more needs
 *  saying; the two store-level problems both apply regardless of what any
 *  individual repository's own run state is. `title` is the full
 *  dispatch.json path, set only for the `unreadable` reason, so the line
 *  itself stays one sentence while the path is still reachable on hover. */
export function storeLineFor(store: RunStatesSnapshot['store']): { readonly text: string; readonly title: string | null } | null {
  switch (store.kind) {
    case 'loaded':
      return null
    case 'unread':
      return { text: 'Reading the saved pipeline state…', title: null }
    case 'unreadable':
      return { text: `Every pipeline is paused — dispatch.json can't be read (${store.message}). Fix or delete it, then run each repository again.`, title: store.path }
  }
}

function blindCopy(blind: TickBlind): string {
  switch (blind.reason) {
    case 'not-ready':
      return "can't decide: this repository isn't ready."
    case 'github-unavailable':
      return "can't decide: GitHub is unavailable. Showing the last good read."
    case 'viewer-unknown':
      return "can't decide: can't tell whose items these are."
    case 'stale-read': {
      const minutes = Math.max(1, Math.round(blind.ageMs / 60_000))
      return `can't decide: the label list is ${String(minutes)}m old.`
    }
  }
}

/** `matched` folds in `session-required` — both are claims this app has an
 *  actual answer for, never a stall; every other class is summarized as
 *  `stalled` here, with the precise class left to each claim's own hover
 *  detail (`stalledDetailCopy`). */
function livenessSummary(claims: readonly TickClaim[]): string {
  if (claims.length === 0) return 'Liveness: nothing in flight.'
  const matched = claims.filter((c) => c.class === 'matched' || c.class === 'session-required').length
  const stalled = claims.length - matched
  const parts: string[] = []
  if (matched > 0) parts.push(`${String(matched)} claim${matched === 1 ? '' : 's'} matched`)
  if (stalled > 0) parts.push(`${String(stalled)} stalled`)
  return `Liveness: ${parts.join(', ')}`
}

/** Draining or paused never renders as "nothing to dispatch" (#110, #314's
 *  own **UX states**) — a held set and an empty one are different facts, so
 *  a non-dispatching repository still names what it would have dispatched.
 *  #265: "would dispatch" becomes "dispatched" when this app itself owns
 *  dispatch for this repository — the cockpit is no longer the one
 *  deciding. */
function dispatchPartOf(report: TickReport, runState: RunState, dispatchedByApp: boolean): string {
  const verb = runState === 'draining' ? 'draining' : 'paused'
  if (report.actionable.length === 0) return runState !== 'dispatching' ? `${verb}: nothing would dispatch` : 'nothing to dispatch'
  const named = report.actionable.map((a) => `${a.agent} #${String(a.number)}`).join(', ')
  if (runState !== 'dispatching') return `${verb}: ${String(report.actionable.length)} would dispatch, held back (${named})`
  return dispatchedByApp ? `dispatched ${named}` : `would dispatch ${named}`
}

/** `owner` defaults to `'none'` — every pre-#265 caller (and test) reads
 *  exactly as before. */
export function repositoryLineCopy(report: TickReport, runState: RunState, owner: DispatchOwner = 'none'): string {
  if (report.blind !== null) return `${report.displayName} — ${blindCopy(report.blind)}`

  const dispatchPart = dispatchPartOf(report, runState, owner === 'app')
  const uncheckedCount = report.actionable.filter((a) => a.unchecked).length
  // Never omitted: an unchecked dispatch is exactly the case an operator may
  // want to look at (plan's own **UX states**).
  const uncheckedPart = uncheckedCount > 0 ? ` · ${String(uncheckedCount)} plan${uncheckedCount === 1 ? '' : 's'} unchecked` : ''
  const heldPart = report.held.length > 0 ? ` · ${String(report.held.length)} held` : ''
  return `${report.displayName} — ${dispatchPart}${uncheckedPart}${heldPart} · ${livenessSummary(report.claims)}`
}

/** Truncates a contended path list to the first three, naming the remainder
 *  as a count rather than overflowing the hover detail — plan's own **UX
 *  states**, "Held detail, contended and truncated". */
function contendedPathList(paths: readonly string[]): string {
  const shown = paths.slice(0, 3)
  const more = paths.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${String(more)} more` : shown.join(', ')
}

/** `owner` defaults to `'none'` — every pre-#292 caller (and test) reads
 *  exactly as before. While this app itself owns dispatch, the held reasons
 *  it actually writes (#292: cycle-cap, zero-diff, conflicting) read in the
 *  present tense rather than "would …" — plan's own **UX states**, "Tick
 *  strip hover". */
export function heldDetailCopy(held: TickHeld, owner: DispatchOwner = 'none'): string {
  const n = String(held.number)
  const byApp = owner === 'app'
  switch (held.reason) {
    case 'unowned':
      return `#${n} unassigned — no cockpit will pick this up.`
    case 'other-operator':
      return `#${n} assigned to someone else.`
    case 'session-required':
      return `#${n} session required — run /port:implement.`
    case 'contended': {
      const c = held.contention
      // Defensive: `planTick` never emits `reason: 'contended'` without a
      // populated `contention` — checked anyway, since this module never
      // assumes another module's invariant stays exactly as documented.
      if (c === null) return `#${n} held — contended, with no detail reported.`
      const count = c.paths.length
      return `#${n} held behind #${String(c.blocker)} — ${String(count)} contended file${count === 1 ? '' : 's'}: ${contendedPathList(c.paths)}.`
    }
    case 'cycle-cap': {
      const e = held.escalation
      const verb = byApp ? 'escalating' : 'would escalate'
      // Defensive: `planTick` never emits `reason: 'cycle-cap'` without a
      // populated `escalation` of the same kind.
      if (e === null || e.kind !== 'cycle-cap') return `#${n} ${verb} to needs human — the review cycle cap was reached.`
      return `#${n} ${verb} to needs human — cycle ${String(e.count)} reached the cap of ${String(e.cap)}.`
    }
    case 'zero-diff':
      return `#${n} ${byApp ? 'escalating' : 'would escalate'} to needs human — the latest review already covers the current head.`
    case 'refresh-wins':
      return `#${n} held — a branch refresh claims it (refresh branch).`
    case 'conflicting':
      return byApp
        ? `#${n} conflicts — this app is refreshing it (rebase + force-push).`
        : `#${n} held — GitHub reports merge conflicts. The cockpit's refresh sweep rebases it; this app doesn't.`
    case 'mergeability-unknown':
      return `#${n} held one poll — GitHub hasn't worked out mergeability yet.`
  }
}

/** "Actionable detail, approaching the cap" (plan's own **UX states**) —
 *  `null` when this candidate carries no cycle count (every agent but
 *  `revise`/`review`), so a pull request's own cycle position is visible on
 *  hover the moment it enters the loop, not only once it nears the cap. */
export function cycleDetailCopy(actionable: TickActionable): string | null {
  if (actionable.cycle === null) return null
  return `#${String(actionable.number)} ${actionable.agent} — cycle ${String(actionable.cycle.count)} of ${String(actionable.cycle.cap)}.`
}

/** "Unchecked detail" (plan's own **UX states**) — the one testing step
 *  this app must never let a warning fall silent for, since dispatching a
 *  plan with no claimed-file fence is exactly the case an operator may want
 *  to look at. */
export function uncheckedDetailCopy(actionable: TickActionable): string {
  return `#${String(actionable.number)} has no file list in its plan — dispatching unchecked.`
}

/** `owner` defaults to `'none'`, the same direction as `heldDetailCopy`.
 *  `null` for the two non-stall classes — never called for them in
 *  `buildTickStrip` below, but the switch stays exhaustive so a new
 *  `TickClaimClass` member is a compile error here too. While this app owns
 *  dispatch, a `stalled-confirmed` claim with a `retryKey` is one it is
 *  about to reset itself (#292's own liveness-reset write), not one an
 *  operator must retry by hand — plan's own **UX states**, "Tick strip
 *  hover". */
export function stalledDetailCopy(claim: TickClaim, owner: DispatchOwner = 'none'): string | null {
  const n = String(claim.number)
  const name = labelNameOf(claim.inFlight)
  switch (claim.class) {
    case 'stalled-confirmed': {
      const retryName = claim.retryKey !== null ? labelNameOf(claim.retryKey) : null
      if (retryName === null) return `#${n} ${name} — no claim, and this app dispatched it.`
      return owner === 'app'
        ? `#${n} ${name} — no agent, and this app dispatched it. Resetting to ${retryName}.`
        : `#${n} ${name} — no claim, and this app dispatched it. Retry re-applies "${retryName}".`
    }
    case 'no-record':
      return `#${n} ${name} — no claim, and this app didn't dispatch it, so it can't tell.`
    case 'suspect':
      return `#${n} ${name} — no claim yet. Confirming next tick.`
    case 'capped':
      return `#${n} ${name} — stalled again after this app already reset it once. Reporting only.`
    case 'matched':
    case 'session-required':
      return null
  }
}

/** #292: hover detail for the one report-only observation kind —
 *  `refresh-deferred` — which never becomes an `ObservationRecord` write
 *  (`main/tick/dispatchable.ts`'s `observableFrom` excludes it), so this is
 *  the only place it is ever rendered. `null` for every write-bearing kind,
 *  which already has its own held/stalled detail line above; the switch
 *  stays exhaustive so a new `TickObservationKind` member is a compile error
 *  here too (plan's own **UX states**, "Tick strip hover"). */
export function observationDetailCopy(observation: TickObservation): string | null {
  const n = String(observation.number)
  switch (observation.kind) {
    case 'refresh-deferred':
      return `#${n} conflicts too — refreshes are capped this poll; it goes next.`
    case 'liveness-reset':
    case 'cycle-cap':
    case 'zero-diff':
    case 'refresh':
    case 'refresh-stuck':
    case 'withdraw-approval':
      return null
  }
}

/** One repository's whole hover detail, the same five sources
 *  `buildTickStrip` used to concatenate into a single `title` — now a list,
 *  for `pipeline-status.tsx`'s own `Tooltip` to render as separate lines.
 *  `[]` for a blind repository: none of these five sources mean anything
 *  when the repository itself could not be read. */
export function repositoryDetailLines(report: TickReport, owner: DispatchOwner): readonly string[] {
  if (report.blind !== null) return []
  return [
    ...report.held.map((h) => heldDetailCopy(h, owner)),
    ...report.actionable.filter((a) => a.unchecked).map(uncheckedDetailCopy),
    ...report.actionable.map(cycleDetailCopy),
    ...report.claims.map((c) => stalledDetailCopy(c, owner)),
    ...report.observations.map(observationDetailCopy),
  ].filter((d): d is string => d !== null)
}

/** The same five sources, narrowed to one item — the Board's detail pane's
 *  own "Held" section (plan's own **UX states**: "this item's held, stalled,
 *  unchecked and cycle detail lines from its repo's tick report, omitted
 *  when there are none"). */
export function itemDetailLines(report: TickReport, number: number, owner: DispatchOwner): readonly string[] {
  if (report.blind !== null) return []
  return [
    ...report.held.filter((h) => h.number === number).map((h) => heldDetailCopy(h, owner)),
    ...report.actionable.filter((a) => a.number === number && a.unchecked).map(uncheckedDetailCopy),
    ...report.actionable.filter((a) => a.number === number).map(cycleDetailCopy),
    ...report.claims.filter((c) => c.number === number).map((c) => stalledDetailCopy(c, owner)),
    ...report.observations.filter((o) => o.number === number).map(observationDetailCopy),
  ].filter((d): d is string => d !== null)
}
