// The sidebar footer — a full-width Settings link, plus the connection status dot.
import { Link } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { StatusPopover } from '@/renderer/shell/status-popover'
import { ROUTE_IDS } from '@/renderer/router/routes'

export function SidebarFooter() {
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <Link to={ROUTE_IDS.settings} className="flex h-7 flex-1 items-center gap-2 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Settings className="size-4 shrink-0" />
        Settings
      </Link>
      <StatusPopover />
    </div>
  )
}
