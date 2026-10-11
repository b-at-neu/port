// DESIGN §4 PhaseBar — six segments, one Tooltip/aria-label for the bar.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { PipelineItemKind } from '../../../shared/github/types'
import { PHASE_NAMES } from '../lib/phase'
import { phaseSegmentsFor } from '../board/phase-model'
import type { PhaseSegmentState } from '../board/phase-model'

// -dot marks the current segment, -pill a decided one (finished/complete).
const SEGMENT_CLASS: Readonly<Record<PhaseSegmentState, string>> = {
  finished: 'bg-working-pill',
  'current-working': 'bg-working-dot',
  'current-attention': 'bg-attention-dot',
  complete: 'bg-success-pill',
  pending: 'bg-accent',
}

export interface PhaseBarProps {
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
            <span key={segment.phase} aria-hidden="true" className={cn('h-1 w-2.5 rounded-[1px]', SEGMENT_CLASS[segment.state])} />
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  )
}
