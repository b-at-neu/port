// DESIGN §4 PhaseBar — five segments, one Tooltip/aria-label for the bar.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/lib/utils'
import { phaseSegmentsOf, stageNameOf } from '@/utils/pipeline/stages'
import type { TicketView } from '@/utils/pipeline/stages'
import { segmentClass } from '@/renderer/components/phase-classes'

interface PhaseBarProps {
  readonly view: TicketView | null
  readonly className?: string
}

export function PhaseBar({ view, className }: PhaseBarProps) {
  const segments = phaseSegmentsOf(view)
  const name = stageNameOf(view)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('flex gap-0.5', className)} role="img" aria-label={`Phase: ${name}`}>
          {segments.map((segment) => (
            <span key={segment.phase} aria-hidden="true" className={cn('h-1 w-2.5 rounded-[1px]', segmentClass(segment))} />
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  )
}
