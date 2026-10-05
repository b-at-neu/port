// A StatusPill with a menu — generic over its item set, so a second
// menu-bearing pill never re-derives this shape.
import type { ReactNode } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { PillStatus } from './status-pill'

const DOT_CLASS: Readonly<Record<PillStatus, string>> = {
  working: 'bg-working-dot',
  attention: 'bg-attention-dot animate-pulse',
  success: 'bg-success-dot',
  danger: 'bg-danger-dot',
  idle: 'bg-idle-dot',
}

const PILL_CLASS: Readonly<Record<PillStatus, string>> = {
  working: 'bg-working-pill text-working-pill-foreground',
  attention: 'bg-attention-pill text-attention-pill-foreground',
  success: 'bg-success-pill text-success-pill-foreground',
  danger: 'bg-danger-pill text-danger-pill-foreground',
  idle: 'bg-idle-pill text-idle-pill-foreground',
}

export interface StatusPillMenuItem {
  readonly key: string
  readonly label: string
  readonly hint: string
  readonly current: boolean
  readonly disabledReason: string | null
  readonly onSelect: () => void
}

export interface StatusPillMenuProps {
  readonly status: PillStatus
  readonly label: string
  readonly pending: boolean
  readonly items: readonly StatusPillMenuItem[]
  readonly tooltip?: string
}

function MenuRow({ item }: { readonly item: StatusPillMenuItem }) {
  const row = (
    <DropdownMenuItem disabled={item.disabledReason !== null} onSelect={item.onSelect}>
      <span className="flex-1">{item.label}</span>
      <span className="text-meta text-muted-foreground">{item.current ? '●' : item.hint}</span>
    </DropdownMenuItem>
  )
  if (item.disabledReason === null) return row
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{row}</span>
      </TooltipTrigger>
      <TooltipContent>{item.disabledReason}</TooltipContent>
    </Tooltip>
  )
}

export function StatusPillMenu({ status, label, pending, items, tooltip }: StatusPillMenuProps) {
  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', PILL_CLASS[status])}
      >
        {pending ? <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" /> : <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[status])} />}
        {label}
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </button>
    </DropdownMenuTrigger>
  )

  const content: ReactNode = (
    <DropdownMenuContent align="end">
      {items.map((item) => (
        <MenuRow key={item.key} item={item} />
      ))}
    </DropdownMenuContent>
  )

  return (
    <DropdownMenu>
      {tooltip !== undefined ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      {content}
    </DropdownMenu>
  )
}
