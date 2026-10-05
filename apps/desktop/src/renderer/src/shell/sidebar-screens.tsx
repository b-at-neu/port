// DESIGN §3's Screens section — Needs you (amber count), Board, Backlog,
// Repositories (#316).
import { Link } from '@tanstack/react-router'
import { FolderGit2, Inbox, LayoutList, ListTodo } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { needsYouItems } from '../../../shared/board/needs-you'
import { useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/legacy-view'

const ROW_CLASS =
  'flex h-7 items-center gap-2 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring [&.active]:bg-accent [&.active]:text-foreground'

export function SidebarScreens() {
  const snapshot = useIpcQuery('board:snapshot')
  const count = snapshot.data !== undefined ? needsYouItems(snapshot.data).length : 0

  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      <Link to={ROUTE_IDS.board} className={ROW_CLASS}>
        <Inbox className="size-4 shrink-0" />
        <span className="flex-1 truncate">Needs you</span>
        {count > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="rounded-full bg-attention-pill px-1.5 py-0.5 text-meta font-medium tabular-nums text-attention-pill-foreground">{count}</span>
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
      <Link to={ROUTE_IDS.repos} className={ROW_CLASS} activeProps={{ className: 'active' }}>
        <FolderGit2 className="size-4 shrink-0" />
        Repositories
      </Link>
    </div>
  )
}
