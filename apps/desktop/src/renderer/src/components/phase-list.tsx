// The Board detail pane's PhaseList — six phases, each an 8px dot in the
// same states PhaseBar uses; only the current phase carries an extra line.
import { cn } from '@/lib/utils'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { PipelineItemKind } from '../../../shared/github/types'
import { PHASE_NAMES } from '../lib/phase'
import { phaseSegmentsFor } from '../board/phase-model'
import type { PhaseKey, PhaseSegmentState } from '../board/phase-model'

const DOT_CLASS: Readonly<Record<PhaseSegmentState, string>> = {
  finished: 'bg-working-pill',
  'current-working': 'bg-working-dot',
  'current-attention': 'bg-attention-dot',
  complete: 'bg-success-pill',
  pending: 'bg-accent',
}

// One representative LabelKey per phase group, for every row but the
// current one — read through PHASE_NAMES, never a second copy table.
const GROUP_LABEL_KEY: Readonly<Record<PhaseKey, LabelKey>> = {
  plan: 'planning',
  planReview: 'planReview',
  implement: 'inProgress',
  review: 'reviewing',
  revision: 'revising',
  merge: 'approved',
}

function labelFor(phase: PhaseKey, isCurrent: boolean, stageKey: LabelKey | null): string {
  if (isCurrent && stageKey !== null) return PHASE_NAMES[stageKey] ?? stageKey
  const key = GROUP_LABEL_KEY[phase]
  return PHASE_NAMES[key] ?? key
}

export interface PhaseListProps {
  readonly stageKey: LabelKey | null
  readonly kind: PipelineItemKind
  readonly merged: boolean
  // The current phase's own extra line, already computed by the caller.
  readonly currentDetail: string | null
  readonly className?: string
}

export function PhaseList({ stageKey, kind, merged, currentDetail, className }: PhaseListProps) {
  const segments = phaseSegmentsFor({ stageKey, kind, merged })

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {segments.map((segment) => {
        const isCurrent = segment.state === 'current-working' || segment.state === 'current-attention'
        return (
          <div key={segment.phase} className="flex items-start gap-2">
            <span aria-hidden="true" className={cn('mt-1 size-2 shrink-0 rounded-full', DOT_CLASS[segment.state])} />
            <div className="flex flex-col">
              <span className={cn('text-small', isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>{labelFor(segment.phase, isCurrent, stageKey)}</span>
              {isCurrent && currentDetail !== null ? <span className="text-meta text-muted-foreground">{currentDetail}</span> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
