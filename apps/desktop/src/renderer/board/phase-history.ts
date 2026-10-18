// Pure "who and when" model for the detail pane's PhaseList, from a ReconciledItem's stageHistory.
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { PipelineItemKind } from '@/types/github'
import type { StageEntry } from '@/types/state'
import type { PhaseDetail, PhaseKey } from '@/types/board'
import { currentPhaseFor, phaseOfStage } from '@/renderer/board/phase-model'
import { actorName, phaseEventVerb } from '@/renderer/board/copy'
import { formatAgo, formatDuration } from '@/renderer/lib/relative-time'
import { formatCost } from '@/utils/hosting/usage'

interface PhaseDetailsParams {
  readonly history: readonly StageEntry[]
  readonly kind: PipelineItemKind
  readonly stageKey: LabelKey | null
  readonly merged: boolean
  readonly viewer: string | null
  readonly now: Date
  readonly currentCostUsd: number | null
}

/** The latest valid-timestamp entry mapping to `phase` — a re-entry (a second revision cycle) shows the newest, never the first. An unparsable `at` is skipped rather than thrown on. */
function latestEntryFor(history: readonly StageEntry[], phase: PhaseKey, kind: PipelineItemKind): StageEntry | null {
  let latest: StageEntry | null = null
  for (const entry of history) {
    if (phaseOfStage(entry.key, kind) !== phase) continue
    const at = Date.parse(entry.at)
    if (Number.isNaN(at)) continue
    if (latest === null || at >= Date.parse(latest.at)) latest = entry
  }
  return latest
}

function actorClause(actor: string | null, viewer: string | null): string {
  return actor !== null ? ` by ${actorName(actor, viewer)}` : ''
}

function finishedLine(entry: StageEntry, viewer: string | null, now: Date): string {
  return `${phaseEventVerb(entry.key)}${actorClause(entry.actor, viewer)} · ${formatAgo(now.getTime() - Date.parse(entry.at))}`
}

function currentLine(entry: StageEntry | null, viewer: string | null, now: Date, currentCostUsd: number | null): string | null {
  if (entry === null) return currentCostUsd !== null ? formatCost(currentCostUsd) : null
  const duration = formatDuration(now.getTime() - Date.parse(entry.at))
  const cost = currentCostUsd !== null ? ` · ${formatCost(currentCostUsd)}` : ''
  return `${phaseEventVerb(entry.key)}${actorClause(entry.actor, viewer)} · ${duration} so far${cost}`
}

/** One `PhaseDetail` per phase that has something to show: a finished phase with at least one history entry, and the current phase (time and cost, or cost alone, or nothing). A pending phase, or one with no entry, is absent from the result — `PhaseList` renders its name only. Merged drops the notion of "current" entirely, so every phase with an entry keeps its finished line. */
export function phaseDetailsFor(params: PhaseDetailsParams): Partial<Record<PhaseKey, PhaseDetail>> {
  const { history, kind, stageKey, merged, viewer, now, currentCostUsd } = params
  const current = merged ? null : currentPhaseFor({ stageKey, kind })

  const phases = new Set<PhaseKey>()
  for (const entry of history) {
    const phase = phaseOfStage(entry.key, kind)
    if (phase !== null) phases.add(phase)
  }
  if (current !== null) phases.add(current)

  const result: Partial<Record<PhaseKey, PhaseDetail>> = {}
  for (const phase of phases) {
    const entry = latestEntryFor(history, phase, kind)
    if (phase === current) {
      const line = currentLine(entry, viewer, now, currentCostUsd)
      if (line !== null) result[phase] = { line, at: entry?.at ?? null }
      continue
    }
    if (entry === null) continue
    result[phase] = { line: finishedLine(entry, viewer, now), at: entry.at }
  }
  return result
}
