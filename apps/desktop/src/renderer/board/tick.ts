// The Board's tick detail copy — one switch per union, so a new variant is a compile error.
import type { DispatchOwner, RunStatesSnapshot } from '@/types/dispatch'
import { STAGE_TABLE, stageNameOf } from '@/utils/pipeline/stages'
import type { TicketView } from '@/utils/pipeline/stages'
import type { PipelineItemKind } from '@/types/github'
import type { TickActionable, TickClaim, TickHeld, TickObservation, TickReport } from '@/types/tick'

/** `null` unless the run-state store can't be read — the transient `unread` state needs no banner. The full path stays reachable in the sentence itself. */
export function storeBannerCopy(store: RunStatesSnapshot['store']): string | null {
  if (store.kind !== 'unreadable') return null
  return `Every pipeline is stopped — pipeline-state.json can't be read (${store.message}). Fix or delete ${store.path}, then run each repository again.`
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
 *  it actually writes (cycle-cap, zero-diff, integration-red, conflicting) read in the
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
      return byApp ? `#${n} is marked session-required — port runs it and asks you in Needs you before each protected edit.` : `#${n} session required — run /port:implement.`
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
    case 'zero-diff': {
      const verb = byApp ? 'escalating' : 'would escalate'
      return `#${n} ${verb} to needs human — this head has had its two reviews, so only a new head gets another.`
    }
    case 'check-hold': {
      const e = held.escalation
      // Defensive: `planTick` never emits `reason: 'check-hold'` without a populated `escalation` of the same kind.
      if (e === null || e.kind !== 'check-hold') return `#${n} held — waiting on a check.`
      const names = e.checks.map((name) => `\`${name}\``).join(', ')
      if (e.state === 'pending') return `#${n} held — waiting for ${names} to finish. It's reviewed again once it does.`
      const at = e.escalateAt === null ? null : new Date(e.escalateAt)
      const many = e.checks.length > 1
      const time = at === null || Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      if (byApp) {
        const later = time === null ? '' : `, or at ${time} if ${many ? 'they stay' : 'it stays'} red`
        return `#${n} held — ${names} ${many ? 'are' : 'is'} still red on the reviewed head. It's reviewed again once ${many ? 'they pass' : 'it passes'}${later}.`
      }
      const rerun = `Re-run ${many ? 'them' : 'it'} on GitHub, or post a \`## Gate cleared\` comment on the PR to authorise one review.`
      const escalation = time === null ? '' : ` It escalates to needs human at ${time} if ${many ? 'they stay' : 'it stays'} red.`
      return `#${n} held — ${names} ${many ? 'are' : 'is'} still red on the reviewed head. ${rerun}${escalation}`
    }
    case 'integration-red': {
      const e = held.escalation
      // Defensive: `planTick` never emits `reason: 'integration-red'` without a populated `escalation` of the same kind.
      if (e === null || e.kind !== 'integration-red') return `#${n} held — the integration branch is red.`
      const names = e.checks.map((name) => `\`${name}\``).join(', ')
      if (e.expired) return `#${n} ${byApp ? 'escalating' : 'would escalate'} to needs human — the integration branch stayed red on ${names} past the hold window.`
      const at = e.escalateAt === null ? null : new Date(e.escalateAt)
      const escalation = at === null || Number.isNaN(at.getTime()) ? '' : `; it escalates to needs human at ${at.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} if it stays red`
      const reason = e.state === 'unreadable' ? "the integration branch's checks couldn't be read" : `the integration branch is red on ${names}`
      return `#${n} held — ${reason}, so review would only repeat it. It's refreshed once the integration branch is green${escalation}.`
    }
    case 'integration-green':
      return byApp
        ? `#${n} held — the integration branch is green again, so this app is refreshing it (rebase + force-push) to resume review.`
        : `#${n} held — the integration branch is green again. The cockpit's refresh sweep rebases it; this app doesn't.`
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

/** The short inline label a held card carries; the full line stays `heldDetailCopy`'s. */
export function heldTagLabel(held: TickHeld): string {
  switch (held.reason) {
    case 'check-hold':
      return held.escalation?.kind === 'check-hold' && held.escalation.state === 'red' ? 'Held · check red' : 'Held · check pending'
    case 'unowned':
      return 'Held · unassigned'
    case 'other-operator':
      return "Held · someone else's"
    case 'session-required':
      return 'Held · session required'
    case 'contended':
      return held.contention === null ? 'Held · contended' : `Held · behind #${String(held.contention.blocker)}`
    case 'cycle-cap':
      return 'Held · cycle cap'
    case 'zero-diff':
      return 'Held · reviewed twice'
    case 'integration-red':
      return 'Held · integration red'
    case 'integration-green':
      return 'Held · refreshing'
    case 'refresh-wins':
      return 'Held · refresh first'
    case 'conflicting':
      return 'Held · conflicts'
    case 'mergeability-unknown':
      return 'Held · checking mergeable'
  }
}

/** This item's own holds — `[]` for an absent or blind report, matched on number and kind. */
export function heldEntriesFor(report: TickReport | undefined, number: number, kind: PipelineItemKind): readonly TickHeld[] {
  if (report === undefined || report.blind !== null) return []
  return report.held.filter((h) => h.number === number && h.kind === kind)
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
  const name = STAGE_TABLE[claim.stage].running.name
  switch (claim.class) {
    case 'stalled-confirmed': {
      if (!claim.retryable) return `#${n} ${name} — no claim, and this app dispatched it.`
      return owner === 'app'
        ? `#${n} ${name} — no agent, and this app dispatched it. Queueing it again.`
        : `#${n} ${name} — no claim, and this app dispatched it. Retry queues it again.`
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

/** Where an adopted hand-back lands the ticket, keyed `<agent>:<token>`. */
const ADOPTED_LANDING: Readonly<Record<string, TicketView>> = {
  'plan:plan-written': { stage: 'plan', status: { kind: 'waiting-on-you', gate: 'plan-approval' } },
  'impl:pr-opened': { stage: 'review', status: { kind: 'queued', reason: 'new' } },
  'review:approved': { stage: 'merge', status: { kind: 'queued', reason: 'new' } },
  'review:needs-revision': { stage: 'revise', status: { kind: 'queued', reason: 'changes-requested' } },
  'revise:revised': { stage: 'review', status: { kind: 'queued', reason: 'new' } },
}

function adoptedPhaseName(observation: Extract<TickObservation, { readonly kind: 'adopt' }>): string {
  const landing = ADOPTED_LANDING[`${observation.agent}:${observation.handback.token}`]
  return landing === undefined ? 'its next stage' : stageNameOf(landing)
}

/** #292: hover detail for the one report-only observation kind —
 *  `refresh-deferred` — which never becomes an `ObservationRecord` write
 *  (`main/pipeline/tick/dispatchable.ts`'s `observableFrom` excludes it), so this is
 *  the only place it is ever rendered. `null` for every write-bearing kind,
 *  which already has its own held/stalled detail line above; the switch
 *  stays exhaustive so a new `TickObservationKind` member is a compile error
 *  here too (plan's own **UX states**, "Tick strip hover"). */
export function observationDetailCopy(observation: TickObservation): string | null {
  const n = String(observation.number)
  switch (observation.kind) {
    case 'refresh-deferred':
      return `#${n} conflicts too — refreshes are capped this poll; it goes next.`
    case 'adopt':
      return `#${n} already finished on GitHub — moving it to ${adoptedPhaseName(observation)}.`
    case 'rerun-checks':
      return `#${n} retrying ${observation.runs.map((run) => run.check).join(', ')} on the reviewed head before reviewing again.`
    case 'liveness-reset':
    case 'cycle-cap':
    case 'zero-diff':
    case 'integration-red':
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
