import { useRef } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { LabelChip } from '@/renderer/components/label-chip'
import { BACKLOG_WORK_ON, PLAN_GATE_OPTIONS } from '@/renderer/backlog/copy'
import type { useListSelection } from '@/renderer/shell/list-selection'
import { exactTime, formatAgoSince } from '@/renderer/lib/time'
import { BlockedTag } from '@/renderer/backlog/blocked-tag'
import { isEpic } from '@/renderer/backlog/epics'
import type { BacklogRowExtras, BacklogRowView } from '@/types/backlog'
import type { PlanGateChoice } from '@/types/claim'

const MAX_CHIPS = 3
const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

type RowProps = ReturnType<ReturnType<typeof useListSelection>['rowProps']>

interface WorkOnMenuProps {
  readonly open: boolean
  readonly pending: boolean
  readonly onOpenChange: (open: boolean) => void
  // Returns true when it opened the confirm dialog, which then owns focus.
  readonly onPick: (planGate: PlanGateChoice) => boolean
}

function WorkOnMenu({ open, pending, onOpenChange, onPick }: WorkOnMenuProps) {
  const picked = useRef<PlanGateChoice | null>(null)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" data-slot="backlog-work-on" disabled={pending}>
          {BACKLOG_WORK_ON}
          {pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : <ChevronDown aria-hidden="true" className="size-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const planGate = picked.current
          picked.current = null
          if (planGate !== null && onPick(planGate)) event.preventDefault()
        }}
      >
        {PLAN_GATE_OPTIONS.map((option) => (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <DropdownMenuItem onSelect={() => (picked.current = option.value)}>{option.label}</DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent>{option.hint}</TooltipContent>
          </Tooltip>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface BacklogRowProps extends BacklogRowExtras {
  readonly row: BacklogRowView
  readonly rowProps: RowProps
  readonly menuOpen: boolean
  readonly pending: boolean
  readonly onMenuOpenChange: (open: boolean) => void
  readonly onPick: (planGate: PlanGateChoice) => boolean
  readonly onOpenDetail: () => void
  readonly now: Date
}

export function BacklogRow({ row, rowProps, menuOpen, pending, onMenuOpenChange, onPick, onOpenDetail, now, slot = 'backlog-row', leading, afterTitle }: BacklogRowProps) {
  return (
    <div
      data-slot={slot}
      {...rowProps}
      onKeyDown={(event) => {
        if (event.key !== ' ' || event.target !== event.currentTarget) return
        event.preventDefault()
        onOpenDetail()
      }}
      className={`flex h-9 items-center gap-2 px-4 text-body ${rowProps.className}`}
    >
      {leading}
      <span className="w-12 shrink-0 font-mono tabular-nums text-muted-foreground">#{row.number}</span>
      <span className="min-w-24 flex-1 truncate text-foreground">{row.title}</span>
      {afterTitle}
      <BlockedTag row={row} />
      {row.labels.length > 0 ? (
        <div className="flex min-w-0 max-w-48 gap-1">
          {row.labels.slice(0, MAX_CHIPS).map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
          {row.labels.length > MAX_CHIPS ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className={`shrink-0 rounded-full bg-muted px-1.5 text-meta font-medium text-foreground-secondary ${FOCUS_RING}`}>+{row.labels.length - MAX_CHIPS}</span>
              </TooltipTrigger>
              <TooltipContent>
                {row.labels
                  .slice(MAX_CHIPS)
                  .map((label) => label.name)
                  .join(', ')}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {row.assignee !== null ? <span className="shrink-0 text-meta text-muted-foreground">{row.assignee}</span> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-slot="backlog-age" className="shrink-0 text-meta text-muted-foreground">{formatAgoSince(row.createdAt, now)}</span>
        </TooltipTrigger>
        <TooltipContent>{exactTime(row.createdAt)}</TooltipContent>
      </Tooltip>
      {isEpic(row) ? null : <WorkOnMenu open={menuOpen} pending={pending} onOpenChange={onMenuOpenChange} onPick={onPick} />}
    </div>
  )
}
