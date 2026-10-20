// The Board's tick detail copy (#105, #319) — one switch per union so a new
// variant is a compile error rather than a silently blank line, the same rule
// `board/copy.ts`'s own header states. `itemDetailLines` feeds the item pane's
// Held section, re-read on every poll; `storeBannerCopy` feeds the store-error
// banner in `board/banners.tsx`.
import type { DispatchOwner, RunStatesSnapshot } from '@/types/dispatch'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { TickActionable, TickClaim, TickHeld, TickObservation, TickReport } from '@/types/tick'

function labelNameOf(key: LabelKey): string {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.name ?? key
}

/** `null` unless the run-state store can't be read — the transient `unread` state needs no banner. The full path stays reachable in the sentence itself. */
export function storeBannerCopy(store: RunStatesSnapshot['store']): string | null {
  if (store.kind !== 'unreadable') return null
  return `Every pipeline is paused — dispatch.json can't be read (${store.message}). Fix or delete ${store.path}, then run each repository again.`
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
    case 'interrupted':
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
    case 'plan-missing':
      return null
  }
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
