// The Screens section — Needs you (red count), Board, Backlog, Releases, Audit log.
import { Link } from '@tanstack/react-router'
import { Inbox, LayoutList, ListTodo, ScrollText, Tag } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import { ROUTE_IDS } from '@/renderer/router/routes'

const ROW_CLASS =
  'flex h-7 items-center gap-2 rounded-md px-2 text-body text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring [&.active]:bg-accent [&.active]:text-primary-text'

export function SidebarScreens() {
  const count = useNeedsYouItems().length

  return (
    <div className="flex flex-col gap-0.5 py-1">
      <Link to={ROUTE_IDS.needsYou} className={ROW_CLASS} activeProps={{ className: 'active' }}>
        <Inbox className="size-4 shrink-0" />
        <span className="flex-1 truncate">Needs you</span>
        {count > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="rounded-full bg-phase-needs-you-pill px-1.5 py-0.5 text-meta font-medium tabular-nums text-phase-needs-you-pill-foreground">{count}</span>
            </TooltipTrigger>
            <TooltipContent>
              {count} waiting on you
            </TooltipContent>
          </Tooltip>
        ) : null}
      </Link>
      <Link to={ROUTE_IDS.board} className={ROW_CLASS} activeProps={{ className: 'active' }}>
        <LayoutList className="size-4 shrink-0" />
        Board
      </Link>
      <Link to={ROUTE_IDS.backlog} className={ROW_CLASS} activeProps={{ className: 'active' }}>
        <ListTodo className="size-4 shrink-0" />
        Backlog
      </Link>
      <Link to={ROUTE_IDS.releases} className={ROW_CLASS} activeProps={{ className: 'active' }}>
        <Tag className="size-4 shrink-0" />
        Releases
      </Link>
      <Link to={ROUTE_IDS.audit} className={ROW_CLASS} activeProps={{ className: 'active' }}>
        <ScrollText className="size-4 shrink-0" />
        Audit log
      </Link>
    </div>
  )
}
