// DESIGN §4 PhaseBar — six 10×4px segments with a 2px gap, naming the
// current phase through one `Tooltip` and `aria-label` for the whole bar
// (never per-segment — only one phase is ever "the" phase a hover needs).
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { PipelineItemKind } from '../../../shared/github/types'
import { PHASE_NAMES } from '../lib/phase'
import { phaseSegmentsFor } from '../board/phase-model'
import type { PhaseSegmentState } from '../board/phase-model'

// DESIGN §4: "Finished segments use the working pill background, the
// current one the working dot, waiting-on-you attention, complete success,
// the rest accent" — the `-dot` token (more saturated than `-pill`) marks
// whichever segment is current, `-pill` marks a decided one (finished or
// complete).
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

/** The bar's own name, straight from `PHASE_NAMES` — never a second copy
 *  table. `merged` is the one fact `PHASE_NAMES` has no entry for (no
 *  `LabelKey` means "this pull request merged"), so it is the sole literal
 *  string here; `shell/pipelines-model.ts`'s own `'Unstaged'` fallback
 *  covers the other edge the same way. */
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
