// The sidebar frame — expanded (248px) or a 48px collapsed rail.
import { Link } from '@tanstack/react-router'
import { useSidebarCollapsed, toggleSidebarCollapsed } from '@/renderer/shell/stores'
import { Inbox, LayoutList, ListTodo, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/lib/utils'
import { useNeedsYouItems } from '@/renderer/needs-you/use-items'
import { IconButton } from '@/renderer/components/icon-button'
import { PhaseDot } from '@/renderer/components/phase-dot'
import { NEEDS_YOU_TONE } from '@/renderer/lib/phase-tone'
import { PortMark } from '@/renderer/components/port-mark'
import { SidebarScreens } from '@/renderer/shell/sidebar-screens'
import { SidebarPipelines } from '@/renderer/shell/sidebar-pipelines'
import { SidebarSessions } from '@/renderer/shell/sidebar-sessions'
import { SidebarFooter } from '@/renderer/shell/sidebar-footer'
import { setSidebarCollapsed } from '@/renderer/shell/prefs'
import { ROUTE_IDS } from '@/renderer/router/routes'

const RAIL_SCREENS = [
  { to: ROUTE_IDS.board, icon: Inbox, label: 'Needs you' },
  { to: ROUTE_IDS.board, icon: LayoutList, label: 'Board' },
  { to: ROUTE_IDS.backlog, icon: ListTodo, label: 'Backlog' },
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
                {label === 'Needs you' && needsYouCount > 0 ? <PhaseDot tone={NEEDS_YOU_TONE} className="absolute top-1 right-1" /> : null}
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
  const needsYouCount = useNeedsYouItems().length

  function toggle(): void {
    setSidebarCollapsed(toggleSidebarCollapsed())
  }

  if (collapsed) return <Rail onExpand={toggle} needsYouCount={needsYouCount} />

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <PortMark />
        <span className="flex-1 text-body font-semibold">port</span>
        <IconButton label="Hide sidebar" tooltip="Hide sidebar · Ctrl+B" onClick={toggle}>
          <PanelLeftClose />
        </IconButton>
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
