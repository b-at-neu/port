// One session link on the Board item pane — shared by each phase row and the "Your sessions" group.
import type { TicketSessionLink } from '@/types/board'
import { sessionLinkAccessibleName, sessionLinkMeta, sessionLinkName } from '@/renderer/board/session-copy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

interface SessionLinkRowProps {
  readonly link: TicketSessionLink
  readonly now: Date
  readonly onOpen: (link: TicketSessionLink) => void
}

export function SessionLinkRow({ link, now, onOpen }: SessionLinkRowProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={sessionLinkAccessibleName(link, now)}
          onClick={() => onOpen(link)}
          className="flex min-h-6 items-baseline gap-2 rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-small text-primary-text">{sessionLinkName(link.who)}</span>
          <span className="text-meta text-muted-foreground tabular-nums">{sessionLinkMeta(link, now)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>{new Date(link.at).toLocaleString()}</div>
        {link.title !== null ? <div>{link.title}</div> : null}
      </TooltipContent>
    </Tooltip>
  )
}
