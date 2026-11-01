// DESIGN §4 PhaseBar — five segments, one Tooltip/aria-label for the bar.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/lib/utils'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { PipelineItemKind } from '@/types/github'
import { PHASE_NAMES } from '@/renderer/lib/phase'
import { phaseSegmentsFor } from '@/renderer/board/phase-model'
import { segmentClass } from '@/renderer/components/phase-classes'

interface PhaseBarProps {
  readonly stageKey: LabelKey | null
  readonly kind: PipelineItemKind
  readonly merged: boolean
  readonly className?: string
}

// The bar's name, read straight from PHASE_NAMES; merged has no label key.
function nameFor(stageKey: LabelKey | null, merged: boolean): string {
  if (merged) return 'Merged'
  return stageKey !== null ? (PHASE_NAMES[stageKey] ?? stageKey) : 'Unstaged'
}

export function PhaseBar({ stageKey, kind, merged, className }: PhaseBarProps) {
  const segments = phaseSegmentsFor({ stageKey, kind, merged })
  const name = nameFor(stageKey, merged)

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
