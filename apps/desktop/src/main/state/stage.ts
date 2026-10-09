// Reads `role` off each matched label's own resolved vocabulary entry, never a second key→stage table.
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import type { LabelRole } from '../../shared/labels/defaults'
import type { StageResult } from '../../shared/state/types'

/** First hit wins: in-flight (something is running) beats gate (stopped, not queued) beats trigger beats terminal (the fallback). */
export const STAGE_PRECEDENCE: readonly LabelRole[] = ['in-flight', 'gate', 'trigger', 'terminal']

/** A key the vocabulary does not resolve (module-disabled) is silently skipped. Marker labels never enter `stages` or the precedence — they surface as the dedicated booleans instead. */
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
