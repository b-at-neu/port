// DESIGN §4 PhaseDot — filled while a stage is in flight, a ring while it is queued. Decorative: the phase name always sits beside it.
import { cn } from '@/renderer/lib/utils'
import { PHASE_DOT_CLASS, PHASE_RING_CLASS } from '@/renderer/components/phase-classes'
import type { PhaseTone } from '@/types/components'

interface PhaseDotProps {
  readonly tone: PhaseTone
  readonly className?: string
}

export function PhaseDot({ tone, className }: PhaseDotProps) {
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', tone.fill === 'queued' ? PHASE_RING_CLASS[tone.palette] : PHASE_DOT_CLASS[tone.palette], tone.pulse && 'animate-pulse', className)} />
}
