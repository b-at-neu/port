// Pure: turns a pipeline item's stage into the tone its pill and dot paint.
import { LABEL_DEFAULTS, paletteOf } from '@/utils/labels/defaults'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { PhaseTone } from '@/types/components'

export const NEEDS_YOU_TONE: PhaseTone = { palette: 'needs-you', fill: 'active', pulse: true }

const UNSTAGED_TONE: PhaseTone = { palette: 'unstaged', fill: 'active', pulse: false }

interface PhaseToneInput {
  readonly stageKey: LabelKey | null
  /** Work is running on the item right now. */
  readonly active: boolean
  /** The stage itself is one the operator must act on (a gate), so the dot pulses in its own colour. */
  readonly waitingOnYou: boolean
  /** The operator is needed beyond what the label says: it overrides the phase colour with red. */
  readonly operatorNeeded: boolean
}

export function phaseTone({ stageKey, active, waitingOnYou, operatorNeeded }: PhaseToneInput): PhaseTone {
  if (operatorNeeded) return NEEDS_YOU_TONE
  if (stageKey === null) return UNSTAGED_TONE
  const palette = paletteOf(stageKey)
  if (palette === null) return UNSTAGED_TONE
  const queued = LABEL_DEFAULTS.find((label) => label.key === stageKey)?.role === 'trigger' && !active
  return { palette, fill: queued ? 'queued' : 'active', pulse: waitingOnYou }
}
