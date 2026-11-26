// Pure: sorts a half-recorded ticket into a repair or a report, never a guess. Only `plan-missing` is repaired; a refused hand-back write and a failed label mirror are reported with their reason.
import type { ReconciledItem } from '@/types/state'
import type { EndedStage, TickLabelRepair, TickObservation } from '@/types/tick'
import { agentStage, ticketViewOf } from '@/utils/pipeline/stages'
import type { Ticket } from '@/utils/pipeline/ticket'

interface RepairsOfParams {
  readonly items: readonly ReconciledItem[]
  readonly endedStages: readonly EndedStage[]
  /** Numbers this app currently has a live stage session for — a repair shape never fires against one. */
  readonly liveNumbers: ReadonlySet<number>
  readonly viewer: string
  /** The GitHub read's own freshness instant, `null` when unknown — a session-shape never fires against a read taken before its own hand-off swap. */
  readonly readAt: string | null
}

interface RepairsOfResult {
  readonly observations: readonly TickObservation[]
  readonly reports: readonly TickLabelRepair[]
}

function eligible(item: ReconciledItem, viewer: string, liveNumbers: ReadonlySet<number>): boolean {
  return item.marked && item.assignees.includes(viewer) && !liveNumbers.has(item.number) && item.state === 'OPEN'
}

/** A failed label write is reported even while a session is live: it says what GitHub shows, not what the stage is doing. */
function mirrorShapeOf(item: ReconciledItem, viewer: string): TickLabelRepair | null {
  if (item.mirrorFailure === undefined || item.mirrorFailure === null || item.state !== 'OPEN' || !item.assignees.includes(viewer)) return null
  return { number: item.number, kind: item.kind, shape: 'mirror-failed', view: item.ticket === null ? null : ticketViewOf(item.ticket), agent: null, reason: null, mirror: item.mirrorFailure }
}

function newestEndedStageFor(endedStages: readonly EndedStage[], number: number): EndedStage | null {
  let newest: EndedStage | null = null
  for (const stage of endedStages) {
    if (stage.number !== number) continue
    if (newest === null || Date.parse(stage.at) > Date.parse(newest.at)) newest = stage
  }
  return newest
}

/** Reports a ticket whose own hand-back write was refused or never possible — the running stage (or an impl's `blocked`) still stands alone on it. */
function sessionShapeOf(item: ReconciledItem, ticket: Ticket, ended: EndedStage, readAt: string | null): TickLabelRepair | null {
  if (readAt === null || Date.parse(readAt) <= Date.parse(ended.at)) return null
  if (ended.outcome !== 'completed' && ended.outcome !== 'error') return null
  if (ended.labels?.kind !== 'refused') return null

  const stage = agentStage(ended.agent)
  const stillRunning = ticket.stage === stage && ticket.status.kind === 'running'
  const stillBlocked = ended.agent === 'impl' && ticket.stage === 'implement' && ticket.status.kind === 'blocked'
  if (!stillRunning && !stillBlocked) return null
  return { number: item.number, kind: item.kind, shape: 'handback-unlabelled', view: ticketViewOf(ticket), agent: ended.agent, reason: ended.labels.reason, mirror: null }
}

/** True only when the GitHub read postdates the moment the ticket entered its current stage and status — an older read may predate the hand-back's body edit. No matching event leaves today's behaviour standing. */
function bodyFresh(ticket: Ticket, readAt: string | null): boolean {
  if (readAt === null) return false
  const entered = ticket.history.filter((event) => event.to?.stage === ticket.stage && event.to.status === ticket.status.kind).map((event) => Date.parse(event.at))
  if (entered.length === 0) return true
  return Date.parse(readAt) > Math.max(...entered)
}

function artifactShapeOf(item: ReconciledItem, ticket: Ticket, readAt: string | null): TickLabelRepair | { readonly observationOnly: true } | null {
  if (item.kind !== 'issue') return null
  const { stage, status } = ticket
  const view = ticketViewOf(ticket)

  if (stage === 'plan' && status.kind === 'waiting-on-you' && status.gate === 'plan-approval' && item.planPresent === false && bodyFresh(ticket, readAt)) return { observationOnly: true }
  if (stage === 'implement' && status.kind === 'queued' && status.reason === 'new' && item.planPresent === false && bodyFresh(ticket, readAt)) {
    return { number: item.number, kind: item.kind, shape: 'plan-missing-approved', view, agent: null, reason: null, mirror: null }
  }
  if (ticket.pr === null && item.linkReason === 'counterpart-not-open') {
    return { number: item.number, kind: item.kind, shape: 'pr-missing', view, agent: null, reason: null, mirror: null }
  }
  return null
}

export function repairsOf(params: RepairsOfParams): RepairsOfResult {
  const { items, endedStages, liveNumbers, viewer, readAt } = params
  const observations: TickObservation[] = []
  const reports: TickLabelRepair[] = []

  for (const item of items) {
    const mirror = mirrorShapeOf(item, viewer)
    if (mirror !== null) reports.push(mirror)
    const { ticket } = item
    if (ticket === null || !eligible(item, viewer, liveNumbers)) continue

    const ended = newestEndedStageFor(endedStages, item.number)
    if (ended !== null) {
      const shape = sessionShapeOf(item, ticket, ended, readAt)
      if (shape !== null) {
        reports.push(shape)
        continue
      }
    }

    const artifact = artifactShapeOf(item, ticket, readAt)
    if (artifact !== null) {
      if ('observationOnly' in artifact) {
        observations.push({ kind: 'plan-missing', number: item.number, itemKind: item.kind })
      } else {
        reports.push(artifact)
      }
    }
  }

  return { observations, reports }
}
