// DESIGN §4 PhasePill — StatusPill's anatomy, painted from a phase palette.
import { cn } from '@/renderer/lib/utils'
import { PhaseDot } from '@/renderer/components/phase-dot'
import { PHASE_PILL_CLASS } from '@/renderer/components/phase-classes'
import type { PhaseTone } from '@/types/components'

interface PhasePillProps {
  readonly tone: PhaseTone
  readonly label: string
  readonly className?: string
}

export function PhasePill({ tone, label, className }: PhasePillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-meta font-medium', PHASE_PILL_CLASS[tone.palette], className)}>
      <PhaseDot tone={tone} onPill />
      {label}
    </span>
  )
}
