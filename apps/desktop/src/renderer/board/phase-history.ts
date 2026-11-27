// Pure "who and when" model for the detail pane's PhaseList, from a ticket's history.
import type { PhaseDetail, PhaseKey } from '@/types/board'
import { phaseOf, phaseOfEvent } from '@/utils/pipeline/stages'
import type { TicketView } from '@/utils/pipeline/stages'
import type { Event } from '@/utils/pipeline/ticket'
import { actorName, phaseEventVerb } from '@/renderer/board/copy'
import { formatAgo, formatDuration } from '@/renderer/lib/time'
import { formatCost } from '@/utils/hosting/usage'

interface PhaseDetailsParams {
  readonly history: readonly Event[]
  readonly view: TicketView | null
  readonly viewer: string | null
  readonly now: Date
  readonly currentCostUsd: number | null
}

/** The latest valid-timestamp event mapping to `phase` — a re-entry (a second revision cycle) shows the newest, never the first. An unparsable `at` is skipped rather than thrown on. */
function latestEventFor(history: readonly Event[], phase: PhaseKey): Event | null {
  let latest: Event | null = null
  for (const event of history) {
    if (phaseOfEvent(event) !== phase) continue
    const at = Date.parse(event.at)
    if (Number.isNaN(at)) continue
    if (latest === null || at >= Date.parse(latest.at)) latest = event
  }
  return latest
}

function actorClause(actor: string | null, viewer: string | null): string {
  return actor !== null ? ` by ${actorName(actor, viewer)}` : ''
}

function finishedLine(event: Event, viewer: string | null, now: Date): string {
  return `${phaseEventVerb(event)}${actorClause(event.actor, viewer)} · ${formatAgo(now.getTime() - Date.parse(event.at))}`
}

function currentLine(event: Event | null, viewer: string | null, now: Date, currentCostUsd: number | null): string | null {
  if (event === null) return currentCostUsd !== null ? formatCost(currentCostUsd) : null
  const duration = formatDuration(now.getTime() - Date.parse(event.at))
  const cost = currentCostUsd !== null ? ` · ${formatCost(currentCostUsd)}` : ''
  return `${phaseEventVerb(event)}${actorClause(event.actor, viewer)} · ${duration} so far${cost}`
}

/** One `PhaseDetail` per phase that has something to show: a finished phase with at least one history event, and the current phase (time and cost, or cost alone, or nothing). A pending phase, or one with no event, is absent from the result — `PhaseList` renders its name only. Merged drops the notion of "current" entirely, so every phase with an event keeps its finished line. */
export function phaseDetailsFor(params: PhaseDetailsParams): Partial<Record<PhaseKey, PhaseDetail>> {
  const { history, view, viewer, now, currentCostUsd } = params
  const current = view?.status.kind === 'done' ? null : phaseOf(view)

  const phases = new Set<PhaseKey>()
  for (const event of history) {
    const phase = phaseOfEvent(event)
    if (phase !== null) phases.add(phase)
  }
  if (current !== null) phases.add(current)

  const result: Partial<Record<PhaseKey, PhaseDetail>> = {}
  for (const phase of phases) {
    const event = latestEventFor(history, phase)
    if (phase === current) {
      const line = currentLine(event, viewer, now, currentCostUsd)
      if (line !== null) result[phase] = { line, at: event?.at ?? null }
      continue
    }
    if (event === null) continue
    result[phase] = { line: finishedLine(event, viewer, now), at: event.at }
  }
  return result
}
