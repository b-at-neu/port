// DESIGN §4 StatusPill — dot then label, the dot `aria-hidden` since status is never colour-only.
import { cn } from '@/renderer/lib/utils'
import type { PillStatus } from '@/types/components'

interface StatusPillProps {
  readonly status: PillStatus
  readonly label: string
  readonly className?: string
}

const DOT_CLASS: Readonly<Record<PillStatus, string>> = {
  working: 'bg-working-dot',
  attention: 'bg-attention-dot',
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

export function StatusPill({ status, label, className }: StatusPillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-meta font-medium', PILL_CLASS[status], className)}>
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[status])} />
      {label}
    </span>
  )
}
