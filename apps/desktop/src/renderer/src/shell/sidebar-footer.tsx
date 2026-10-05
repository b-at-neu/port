// The sidebar footer — Settings, plus the claude/gh status dot.
import { Link } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIpcQuery } from '../data/query'
import { footerStatus } from './status-model'
import { ROUTE_IDS } from '../router/legacy-view'

const DOT_CLASS: Readonly<Record<'success' | 'danger' | 'idle', string>> = {
  success: 'bg-success-dot',
  danger: 'bg-danger-dot',
  idle: 'bg-idle-dot',
}

export function SidebarFooter() {
  const preflight = useIpcQuery('runtime:preflight')
  const gh = useIpcQuery('gh:status')
  const status = footerStatus(preflight, gh)

  return (
    <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
      <Link to={ROUTE_IDS.settings} className="flex h-7 items-center gap-2 rounded-md px-2 text-small text-foreground-secondary hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Settings className="size-4 shrink-0" />
        Settings
      </Link>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={ROUTE_IDS.settings}
            aria-label={`Status: ${status.tooltip}. Open Settings.`}
            className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true" className={cn('size-2 rounded-full', DOT_CLASS[status.status])} />
          </Link>
        </TooltipTrigger>
        <TooltipContent>{status.tooltip}</TooltipContent>
      </Tooltip>
    </div>
  )
}
