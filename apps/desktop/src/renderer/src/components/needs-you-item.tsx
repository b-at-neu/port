// DESIGN §4 NeedsYouItem — the Needs you row: an amber status dot, lead
// copy, a repo tag, relative age when known, and one inline action. A row
// with more detail (an escalation reason, held paths, relay questions) gets
// a caret that expands it in place.
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { exactTime, relativeAge } from '../backlog/group'

export interface NeedsYouItemProps {
  readonly leadCopy: string
  readonly repo: string | null
  readonly at: string | null
  readonly now: Date
  readonly actionLabel: string
  readonly actionDisabledReason: string | null
  readonly actionPending: boolean
  readonly onAction: () => void
  readonly expandable: boolean
  readonly expanded: boolean
  readonly onToggleExpand: () => void
  readonly children?: ReactNode
}

export function NeedsYouItem({
  leadCopy,
  repo,
  at,
  now,
  actionLabel,
  actionDisabledReason,
  actionPending,
  onAction,
  expandable,
  expanded,
  onToggleExpand,
  children,
}: NeedsYouItemProps) {
  return (
    <div data-slot="needs-you-item" className="flex flex-col border-b border-border">
      <div className="flex h-9 items-center gap-2 px-4 text-small">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention-dot animate-pulse" />
        {expandable ? (
          <button type="button" onClick={onToggleExpand} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label={expanded ? 'Collapse details' : 'Expand details'}>
            <ChevronRight aria-hidden="true" className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-foreground">{leadCopy}</span>
        {repo !== null ? <span className="shrink-0 text-meta text-muted-foreground">{repo}</span> : null}
        {at !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{relativeAge(at, now)}</span>
            </TooltipTrigger>
            <TooltipContent>{exactTime(at)}</TooltipContent>
          </Tooltip>
        ) : null}
        {actionDisabledReason !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button variant="ghost" size="small" disabled className="shrink-0">
                  {actionLabel}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{actionDisabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          <Button variant="ghost" size="small" onClick={onAction} disabled={actionPending} className="shrink-0">
            {actionPending ? 'Working…' : actionLabel}
          </Button>
        )}
      </div>
      {expanded ? children : null}
    </div>
  )
}
