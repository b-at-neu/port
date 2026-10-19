// The group header's Labels dropdown — each label cycles any → only → hidden, and the menu stays open.
import { ListFilter } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { LabelChip } from '@/renderer/components/label-chip'
import type { BacklogLabelFilter, LabelOption } from '@/types/backlog'
import { BACKLOG_FILTER_CLEAR, BACKLOG_FILTER_HINT, backlogFilterButtonCopy, backlogFilterOptionAria, backlogFilterStateCopy } from '@/renderer/backlog/copy'
import { EMPTY_FILTER, activeCount, cycleLabel } from '@/renderer/backlog/filter'

interface LabelFilterMenuProps {
  readonly options: readonly LabelOption[]
  readonly filter: BacklogLabelFilter
  readonly onChange: (filter: BacklogLabelFilter) => void
}

export function LabelFilterMenu({ options, filter, onChange }: LabelFilterMenuProps) {
  const active = activeCount(filter)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" data-slot="backlog-label-filter">
          <ListFilter aria-hidden="true" className="size-3.5" />
          {backlogFilterButtonCopy(active)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-meta font-normal text-muted-foreground">{BACKLOG_FILTER_HINT}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.label.name}
            aria-label={backlogFilterOptionAria(option.label.name, option.state)}
            onSelect={(event) => {
              event.preventDefault()
              onChange(cycleLabel(filter, option.label.name))
            }}
          >
            <LabelChip label={option.label} />
            <span className="ml-auto tabular-nums text-meta text-muted-foreground">{option.count}</span>
            <span className="w-12 text-right text-meta text-foreground-secondary">{backlogFilterStateCopy(option.state)}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={active === 0} onSelect={() => onChange(EMPTY_FILTER)}>
          {BACKLOG_FILTER_CLEAR}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
