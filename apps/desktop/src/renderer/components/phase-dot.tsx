// DESIGN §4 PhaseDot — filled while a stage is in flight, a ring while it is queued, in the pill's text colour on a pill. Decorative: the phase name always sits beside it.
import { cn } from '@/renderer/lib/utils'
import { PHASE_DOT_CLASS, PHASE_DOT_ON_PILL_CLASS, PHASE_RING_CLASS, PHASE_RING_ON_PILL_CLASS } from '@/renderer/components/phase-classes'
import type { PhaseTone } from '@/types/components'

interface PhaseDotProps {
  readonly tone: PhaseTone
  readonly onPill?: boolean
  readonly className?: string
}

export function PhaseDot({ tone, onPill = false, className }: PhaseDotProps) {
  const queued = tone.fill === 'queued'
  const colour = onPill ? (queued ? PHASE_RING_ON_PILL_CLASS : PHASE_DOT_ON_PILL_CLASS) : queued ? PHASE_RING_CLASS[tone.palette] : PHASE_DOT_CLASS[tone.palette]
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', colour, tone.pulse && 'animate-pulse', className)} />
}
