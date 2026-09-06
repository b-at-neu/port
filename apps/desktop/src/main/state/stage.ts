// The role precedence, the stage winner, and the marker split (#79 Decision
// 1) — pure, no I/O. Reads `role` off each matched label's own resolved
// vocabulary entry, never a second key→stage table.
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import type { LabelRole } from '../../shared/labels/defaults'
import type { StageResult } from '../../shared/state/types'

/**
 * First hit wins, one line each:
 * - `in-flight` — a refresh deliberately leaves other labels in place
 *   (PIPELINE.md → "Preview-database concurrency"), and "something is
 *   running" is the single most actionable fact an operator can read.
 * - `gate` — an item at `blocked` carrying a trigger is stopped, not queued.
 * - `trigger` — a live trigger outranks a finished stage on the same item.
 * - `terminal` — the fallback: nothing else is present.
 */
export const STAGE_PRECEDENCE: readonly LabelRole[] = ['in-flight', 'gate', 'trigger', 'terminal']

/**
 * `matchedKeys` names every label this item's own alias matched (#76's
 * `mapPipelineItems`); `vocabulary` resolves each key to its name and role.
 * A key the vocabulary does not resolve (module-disabled) is silently
 * skipped — it cannot have matched an alias in the first place. Marker
 * labels (`marker`/`autoPlan`) never enter `stages` or the precedence — they
 * surface as the dedicated `marked`/`autoPlan` booleans instead.
 */
export function stageOf(matchedKeys: readonly LabelKey[], vocabulary: LabelVocabulary): StageResult {
  const stages: StageResult['stages'][number][] = []
  let marked = false
  let autoPlan = false

  for (const key of matchedKeys) {
    const label = vocabulary.labels.find((l) => l.key === key)
    if (!label) continue
    if (label.role === 'marker') {
      if (key === 'marker') marked = true
      if (key === 'autoPlan') autoPlan = true
      continue
    }
    stages.push({ key: label.key, name: label.name, role: label.role })
  }

  const distinctRoles = new Set(stages.map((s) => s.role))
  const stage = STAGE_PRECEDENCE.find((role) => distinctRoles.has(role)) ?? null

  return { stages, stage, stageAmbiguous: distinctRoles.size > 1, marked, autoPlan }
}
