// The Board detail pane's PhaseList — six phases, each an 8px dot in the
// same states PhaseBar uses; only the current phase carries an extra line.
import { cn } from '@/renderer/lib/utils'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { PipelineItemKind } from '@/types/github'
import { PHASE_NAMES } from '@/renderer/lib/phase'
import { phaseSegmentsFor } from '@/renderer/board/phase-model'
import type { PhaseDetail, PhaseKey } from '@/types/board'
import { segmentClass } from '@/renderer/components/phase-classes'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

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

interface PhaseListProps {
  readonly stageKey: LabelKey | null
  readonly kind: PipelineItemKind
  readonly merged: boolean
  /** One "who and when" line per phase that has history — `phaseDetailsFor`'s own result, rendered verbatim. */
  readonly details: Partial<Record<PhaseKey, PhaseDetail>>
  /** The current phase's own extra line (the agent summary), kept as a second meta line under its detail. */
  readonly extraCurrentLine: string | null
  readonly className?: string
}

export function PhaseList({ stageKey, kind, merged, details, extraCurrentLine, className }: PhaseListProps) {
  const segments = phaseSegmentsFor({ stageKey, kind, merged })

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {segments.map((segment) => {
        const isCurrent = segment.state === 'current-working' || segment.state === 'current-attention'
        const detail = details[segment.phase] ?? null
        return (
          <div key={segment.phase} className="flex items-start gap-2">
            <span aria-hidden="true" className={cn('mt-1 size-2 shrink-0 rounded-full', segmentClass(segment))} />
            <div className="flex flex-col">
              <span className={cn('text-small', isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>{labelFor(segment.phase, isCurrent, stageKey)}</span>
              {detail !== null ? (
                detail.at !== null ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-meta text-muted-foreground tabular-nums">{detail.line}</span>
                    </TooltipTrigger>
                    <TooltipContent>{new Date(detail.at).toLocaleString()}</TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="text-meta text-muted-foreground tabular-nums">{detail.line}</span>
                )
              ) : null}
              {isCurrent && extraCurrentLine !== null ? <span className="text-meta text-muted-foreground">{extraCurrentLine}</span> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
