// Pure: sorts a half-labelled ticket into a repair or a `half-labelled` report, never a guess.
import type { ReconciledItem } from '@/types/state'
import type { EndedStage, TickLabelRepair, TickObservation } from '@/types/tick'
import { RETRY_TRIGGER } from '../../../../../scripts/port-tick/liveness'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { isContradictory } from '@/main/tick/observe'
import { AGENT_FOR_IN_FLIGHT } from '@/main/tick/routing'

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

function newestEndedStageFor(endedStages: readonly EndedStage[], number: number): EndedStage | null {
  let newest: EndedStage | null = null
  for (const stage of endedStages) {
    if (stage.number !== number) continue
    if (newest === null || Date.parse(stage.at) > Date.parse(newest.at)) newest = stage
  }
  return newest
}

function sessionShapeOf(item: ReconciledItem, ended: EndedStage, readAt: string | null): { readonly observation: TickObservation | null; readonly report: TickLabelRepair | null } | null {
  if (readAt === null || Date.parse(readAt) <= Date.parse(ended.at)) return null

  const roleBearing = roleBearingKeys(item)
  const expectedInFlight = Object.entries(AGENT_FOR_IN_FLIGHT).find(([, agent]) => agent === ended.agent)?.[0] as LabelKey | undefined
  if (expectedInFlight === undefined || roleBearing.length !== 1 || roleBearing[0] !== expectedInFlight) return null

  if (ended.outcome === 'error') {
    const retryKey = (RETRY_TRIGGER[expectedInFlight] as LabelKey | undefined) ?? null
    if (retryKey === null) {
      return { observation: null, report: { number: item.number, kind: item.kind, shape: 'handback-unlabelled', labels: roleBearing, agent: ended.agent } }
    }
    return { observation: { kind: 'liveness-reset', number: item.number, itemKind: item.kind, inFlight: expectedInFlight, retryKey, evidence: 'stage-error' }, report: null }
  }
  if (ended.outcome === 'completed') {
    return { observation: null, report: { number: item.number, kind: item.kind, shape: 'handback-unlabelled', labels: roleBearing, agent: ended.agent } }
  }
  // 'questions' | 'blocked' | 'interrupted' | 'usage-limit' — deliberately not repaired or reported here.
  return null
}

function artifactShapeOf(item: ReconciledItem): TickLabelRepair | { readonly observationOnly: true } | null {
  if (item.kind !== 'issue') return null
  const roleBearing = roleBearingKeys(item)
  if (roleBearing.length !== 1) return null
  const only = roleBearing[0]

  if (only === 'planReview' && item.planPresent === false) return { observationOnly: true }
  if (only === 'planApproved' && item.planPresent === false) {
    return { number: item.number, kind: item.kind, shape: 'plan-missing-approved', labels: roleBearing, agent: null }
  }
  if (only === 'prOpened' && item.linkReason === 'counterpart-not-open') {
    return { number: item.number, kind: item.kind, shape: 'pr-missing', labels: roleBearing, agent: null }
  }
  return null
}

export function repairsOf(params: RepairsOfParams): RepairsOfResult {
  const { items, endedStages, liveNumbers, viewer, readAt } = params
  const observations: TickObservation[] = []
  const reports: TickLabelRepair[] = []

  for (const item of items) {
    if (!eligible(item, viewer, liveNumbers)) continue

    if (isContradictory(item)) {
      reports.push({ number: item.number, kind: item.kind, shape: 'contradictory', labels: roleBearingKeys(item), agent: null })
      continue
    }

    const ended = newestEndedStageFor(endedStages, item.number)
    if (ended !== null) {
      const shape = sessionShapeOf(item, ended, readAt)
      if (shape !== null) {
        if (shape.observation !== null) observations.push(shape.observation)
        if (shape.report !== null) reports.push(shape.report)
        continue
      }
    }

    const artifact = artifactShapeOf(item)
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
