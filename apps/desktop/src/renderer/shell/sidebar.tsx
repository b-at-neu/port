// The sidebar frame — expanded (248px) or a 48px collapsed rail.
import { Link } from '@tanstack/react-router'
import { useSidebarCollapsed, toggleSidebarCollapsed } from './stores'
import { FolderGit2, Inbox, LayoutList, ListTodo, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { needsYouItems } from '../../../shared/board/needs-you'
import { useIpcQuery } from '../data/query'
import { PortMark } from '../components/port-mark'
import { SidebarScreens } from './sidebar-screens'
import { SidebarPipelines } from './sidebar-pipelines'
import { SidebarSessions } from './sidebar-sessions'
import { SidebarFooter } from './sidebar-footer'
import { setSidebarCollapsed } from './prefs'
import { ROUTE_IDS } from '../router/routes'

const RAIL_SCREENS = [
  { to: ROUTE_IDS.board, icon: Inbox, label: 'Needs you' },
  { to: ROUTE_IDS.board, icon: LayoutList, label: 'Board' },
  { to: ROUTE_IDS.backlog, icon: ListTodo, label: 'Backlog' },
  { to: ROUTE_IDS.repos, icon: FolderGit2, label: 'Repositories' },
] as const

function Rail({ onExpand, needsYouCount }: { readonly onExpand: () => void; readonly needsYouCount: number }) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 border-r border-border bg-sidebar py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={onExpand} className="flex size-8 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Show sidebar">
            <PanelLeftOpen className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Show sidebar · Ctrl+B</TooltipContent>
      </Tooltip>
      <div className="mt-2 flex flex-col gap-1">
        {RAIL_SCREENS.map(({ to, icon: Icon, label }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Link to={to} className="relative flex size-8 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={label}>
                <Icon className="size-4" />
                {label === 'Needs you' && needsYouCount > 0 ? <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-attention-dot animate-pulse" /> : null}
              </Link>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to={ROUTE_IDS.settings} className="flex size-8 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Settings">
            <Settings className="size-4" />
          </Link>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function Sidebar() {
  const collapsed = useSidebarCollapsed()
  const snapshot = useIpcQuery('board:snapshot')
  const needsYouCount = snapshot.data !== undefined ? needsYouItems(snapshot.data, new Date()).length : 0

  function toggle(): void {
    setSidebarCollapsed(toggleSidebarCollapsed())
  }

  if (collapsed) return <Rail onExpand={toggle} needsYouCount={needsYouCount} />

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <PortMark />
        <span className="flex-1 text-title font-semibold">port</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={toggle} className="flex size-6 items-center justify-center rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Hide sidebar">
              <PanelLeftClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide sidebar · Ctrl+B</TooltipContent>
        </Tooltip>
      </div>
      <div className={cn('flex flex-1 flex-col gap-3 overflow-y-auto py-2')}>
        <SidebarScreens />
        <SidebarPipelines />
        <SidebarSessions />
      </div>
      <SidebarFooter />
    </aside>
  )
}
