// The tick strip (#105) — one switch per union so a new variant is a
// compile error rather than a silently blank line, the same rule
// `board/copy.ts`'s own header states. Pure copy functions plus the strip's
// DOM; `view.ts` renders this directly under the freshness strip, inside
// `buildHeader`, so both re-render on every draw and the countdown stays
// live.
import type { BoardSnapshot, RepositoryHealth } from '../../../shared/board/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { TickBlind, TickClaim, TickHeld, TickReport } from '../../../shared/tick/types'

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

export function repositoryLineCopy(report: TickReport): string {
  if (report.blind !== null) return `${report.displayName} — ${blindCopy(report.blind)}`

  const dispatchPart =
    report.actionable.length === 0 ? 'nothing to dispatch' : `would dispatch ${report.actionable.map((a) => `${a.agent} #${String(a.number)}`).join(', ')}`
  const heldPart = report.held.length > 0 ? ` · ${String(report.held.length)} held` : ''
  return `${report.displayName} — ${dispatchPart}${heldPart} · ${livenessSummary(report.claims)}`
}

export function heldDetailCopy(held: TickHeld): string {
  const n = String(held.number)
  switch (held.reason) {
    case 'unowned':
      return `#${n} unassigned — no cockpit will pick this up.`
    case 'other-operator':
      return `#${n} assigned to someone else.`
    case 'session-required':
      return `#${n} session required — run /port:implement.`
  }
}

/** `null` for the two non-stall classes — never called for them in
 *  `buildTickStrip` below, but the switch stays exhaustive so a new
 *  `TickClaimClass` member is a compile error here too. */
export function stalledDetailCopy(claim: TickClaim): string | null {
  const n = String(claim.number)
  const name = labelNameOf(claim.inFlight)
  switch (claim.class) {
    case 'stalled-confirmed': {
      const retryName = claim.retryKey !== null ? labelNameOf(claim.retryKey) : null
      return retryName !== null
        ? `#${n} ${name} — no claim, and this app dispatched it. Retry re-applies "${retryName}".`
        : `#${n} ${name} — no claim, and this app dispatched it.`
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

/** The strip's whole DOM — a clock line plus one line per repository, each
 *  carrying its held/stalled detail as a `title` (hover), so the summary
 *  line stays one line while the detail is still reachable. */
export function buildTickStrip(snapshot: BoardSnapshot, now: Date): HTMLElement {
  const strip = document.createElement('div')
  strip.className = 'board-header__tick'

  const clock = document.createElement('div')
  clock.className = 'board-header__tick-clock'
  clock.textContent = clockLineCopy(snapshot.nextWakeupAt, snapshot.health, now)
  strip.appendChild(clock)

  for (const report of snapshot.tick) {
    const line = document.createElement('div')
    line.className = 'board-header__tick-line'
    line.textContent = repositoryLineCopy(report)

    if (report.blind === null) {
      const details = [...report.held.map(heldDetailCopy), ...report.claims.map(stalledDetailCopy)].filter((d): d is string => d !== null)
      if (details.length > 0) line.title = details.join('\n')
    }

    strip.appendChild(line)
  }

  return strip
}
