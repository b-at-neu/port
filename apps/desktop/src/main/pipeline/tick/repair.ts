// Pure: sorts a half-recorded ticket into a repair or a report, never a guess. Only `plan-missing` is repaired; a refused hand-back write and a failed label mirror are reported with their reason.
import type { ReconciledItem } from '@/types/state'
import type { EndedStage, TickLabelRepair, TickObservation } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { AGENT_FOR_IN_FLIGHT } from '@/main/pipeline/tick/routing'

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

function roleBearingKeys(item: Pick<ReconciledItem, 'stages'>): readonly LabelKey[] {
  return item.stages.filter((s) => s.role !== 'marker').map((s) => s.key)
}

function eligible(item: ReconciledItem, viewer: string, liveNumbers: ReadonlySet<number>): boolean {
  return item.marked && item.assignees.includes(viewer) && !liveNumbers.has(item.number) && item.state === 'OPEN'
}

/** A failed label write is reported even while a session is live: it says what GitHub shows, not what the stage is doing. */
function mirrorShapeOf(item: ReconciledItem, viewer: string): TickLabelRepair | null {
  if (item.mirrorFailure === undefined || item.mirrorFailure === null || item.state !== 'OPEN' || !item.assignees.includes(viewer)) return null
  return { number: item.number, kind: item.kind, shape: 'mirror-failed', labels: item.stages.map((s) => s.key), agent: null, reason: null, mirror: item.mirrorFailure }
}

function newestEndedStageFor(endedStages: readonly EndedStage[], number: number): EndedStage | null {
  let newest: EndedStage | null = null
  for (const stage of endedStages) {
    if (stage.number !== number) continue
    if (newest === null || Date.parse(stage.at) > Date.parse(newest.at)) newest = stage
  }
  return newest
}

/** Reports a ticket whose own hand-back write was refused or never possible — the in-flight label (or an impl's `blocked`) still stands alone on it. */
function sessionShapeOf(item: ReconciledItem, ended: EndedStage, readAt: string | null): TickLabelRepair | null {
  if (readAt === null || Date.parse(readAt) <= Date.parse(ended.at)) return null
  if (ended.outcome !== 'completed' && ended.outcome !== 'error') return null
  if (ended.labels?.kind !== 'refused') return null

  const roleBearing = roleBearingKeys(item)
  const owned = Object.entries(AGENT_FOR_IN_FLIGHT)
    .filter(([, agent]) => agent === ended.agent)
    .map(([key]) => key as LabelKey)
  if (ended.agent === 'impl') owned.push('blocked')
  const only = roleBearing[0]
  if (roleBearing.length !== 1 || only === undefined || !owned.includes(only)) return null
  return { number: item.number, kind: item.kind, shape: 'handback-unlabelled', labels: roleBearing, agent: ended.agent, reason: ended.labels.reason, mirror: null }
}

/** True only when the GitHub read postdates the moment the item entered its current label — an older read may predate the hand-back's body edit. No matching entry leaves today's behaviour standing. */
function bodyFresh(item: ReconciledItem, key: LabelKey, readAt: string | null): boolean {
  if (readAt === null) return false
  const entered = item.stageHistory.filter((entry) => entry.key === key).map((entry) => Date.parse(entry.at))
  if (entered.length === 0) return true
  return Date.parse(readAt) > Math.max(...entered)
}

function artifactShapeOf(item: ReconciledItem, readAt: string | null): TickLabelRepair | { readonly observationOnly: true } | null {
  if (item.kind !== 'issue') return null
  const roleBearing = roleBearingKeys(item)
  if (roleBearing.length !== 1) return null
  const only = roleBearing[0]

  if (only === 'planReview' && item.planPresent === false && bodyFresh(item, only, readAt)) return { observationOnly: true }
  if (only === 'planApproved' && item.planPresent === false && bodyFresh(item, only, readAt)) {
    return { number: item.number, kind: item.kind, shape: 'plan-missing-approved', labels: roleBearing, agent: null, reason: null, mirror: null }
  }
  if (only === 'prOpened' && item.linkReason === 'counterpart-not-open') {
    return { number: item.number, kind: item.kind, shape: 'pr-missing', labels: roleBearing, agent: null, reason: null, mirror: null }
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
    if (!eligible(item, viewer, liveNumbers)) continue

    const ended = newestEndedStageFor(endedStages, item.number)
    if (ended !== null) {
      const shape = sessionShapeOf(item, ended, readAt)
      if (shape !== null) {
        reports.push(shape)
        continue
      }
    }

    const artifact = artifactShapeOf(item, readAt)
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
