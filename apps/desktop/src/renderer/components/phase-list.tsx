// The Board detail pane's PhaseList — five phases, each an 8px dot in the
// same states PhaseBar uses; only the current phase carries an extra line.
import { cn } from '@/renderer/lib/utils'
import { PHASE_TABLE, phaseSegmentsOf, stageNameOf } from '@/utils/pipeline/stages'
import type { TicketView } from '@/utils/pipeline/stages'
import type { PhaseDetail, PhaseKey, TicketSessionLink, TicketSessions } from '@/types/board'
import { segmentClass } from '@/renderer/components/phase-classes'
import { SessionLinkRow } from '@/renderer/components/session-link-row'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

function labelFor(phase: PhaseKey, isCurrent: boolean, view: TicketView | null): string {
  return isCurrent ? stageNameOf(view) : PHASE_TABLE[phase].name
}

interface PhaseListProps {
  readonly view: TicketView | null
  /** One "who and when" line per phase that has history — `phaseDetailsFor`'s own result, rendered verbatim. */
  readonly details: Partial<Record<PhaseKey, PhaseDetail>>
  /** The current phase's own extra line (the agent summary), kept as a second meta line under its detail. */
  readonly extraCurrentLine: string | null
  /** The session links that ran each phase, rendered under its lines — a caller with no sessions to show omits all three. */
  readonly sessions?: TicketSessions['byPhase']
  readonly now?: Date
  readonly onOpenSession?: (link: TicketSessionLink) => void
  readonly className?: string
}

export function PhaseList({ view, details, extraCurrentLine, sessions = {}, now = new Date(), onOpenSession, className }: PhaseListProps) {
  const segments = phaseSegmentsOf(view)

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {segments.map((segment) => {
        const isCurrent = segment.state === 'current-working' || segment.state === 'current-attention'
        const detail = details[segment.phase] ?? null
        const links = sessions[segment.phase] ?? []
        return (
          <div key={segment.phase} className="flex items-start gap-2">
            <span aria-hidden="true" className={cn('mt-1 size-2 shrink-0 rounded-full', segmentClass(segment))} />
            <div className="flex flex-col">
              <span className={cn('text-small', isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>{labelFor(segment.phase, isCurrent, view)}</span>
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
              {links.length > 0 && onOpenSession !== undefined ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {links.map((link) => (
                    <SessionLinkRow key={link.key} link={link} now={now} onOpen={onOpenSession} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
