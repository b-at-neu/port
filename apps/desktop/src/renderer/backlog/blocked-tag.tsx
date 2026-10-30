// The Backlog row's `Blocked` pill — a tooltip that names each open blocker.
import { StatusPill } from '@/renderer/components/status-pill'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { BACKLOG_BLOCKED_LABEL, BACKLOG_BLOCKED_TOOLTIP_HEADING, backlogBlockerLine, backlogBlockerTruncatedCopy } from '@/renderer/backlog/copy'
import type { BacklogRowView } from '@/types/backlog'
import { openBlockersOf, truncationOf } from '@/renderer/backlog/confirm'

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

export function BlockedTag({ row }: { readonly row: BacklogRowView }) {
  const blockers = openBlockersOf(row)
  if (blockers.length === 0) return null
  const truncation = truncationOf(row)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-slot="backlog-blocked" className={`shrink-0 rounded-full ${FOCUS_RING}`}>
          <StatusPill status="attention" label={BACKLOG_BLOCKED_LABEL} />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{BACKLOG_BLOCKED_TOOLTIP_HEADING}</p>
        <ul>
          {blockers.map((blocker) => (
            <li key={blocker.number}>{backlogBlockerLine(blocker)}</li>
          ))}
        </ul>
        {truncation !== null ? <p>{backlogBlockerTruncatedCopy(truncation.shown, truncation.total)}</p> : null}
      </TooltipContent>
    </Tooltip>
  )
}
