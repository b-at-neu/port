// DESIGN §4 StatusPill — dot then label, the dot `aria-hidden` since status
// is never colour-only (ENGINEERING §5). No menu: the repo run-state pill
// with Run/Pause/Drain belongs to #314/#318, not this ticket.
import { cn } from '@/lib/utils'

export type PillStatus = 'working' | 'attention' | 'success' | 'danger' | 'idle'

export interface StatusPillProps {
  readonly status: PillStatus
  readonly label: string
  readonly className?: string
}

const DOT_CLASS: Readonly<Record<PillStatus, string>> = {
  working: 'bg-working-dot',
  // DESIGN §5: the one continuous animation — a soft 2s pulse — and only on
  // what needs the operator. `prefers-reduced-motion` turns it off globally
  // (app.css).
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

export function StatusPill({ status, label, className }: StatusPillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-meta font-medium', PILL_CLASS[status], className)}>
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[status])} />
      {label}
    </span>
  )
}
