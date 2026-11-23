// Pure: turns a pipeline item's stage into the tone its pill and dot paint.
import type { PhaseTone } from '@/types/components'
import { stageRowOf } from '@/utils/pipeline/stages'
import type { TicketView } from '@/utils/pipeline/stages'

export const NEEDS_YOU_TONE: PhaseTone = { palette: 'needs-you', fill: 'active', pulse: true }

const UNSTAGED_TONE: PhaseTone = { palette: 'unstaged', fill: 'active', pulse: false }

interface PhaseToneInput {
  readonly view: TicketView | null
  /** Work is running on the item right now. */
  readonly active: boolean
  /** The stage itself is one the operator must act on (a gate), so the dot pulses in its own colour. */
  readonly waitingOnYou: boolean
  /** The operator is needed beyond what the label says: it overrides the phase colour with red. */
  readonly operatorNeeded: boolean
}

export function phaseTone({ view, active, waitingOnYou, operatorNeeded }: PhaseToneInput): PhaseTone {
  if (operatorNeeded) return NEEDS_YOU_TONE
  const { palette } = stageRowOf(view)
  if (palette === null) return UNSTAGED_TONE
  const queued = view?.status.kind === 'queued' && !active
  return { palette, fill: queued ? 'queued' : 'active', pulse: waitingOnYou }
}
