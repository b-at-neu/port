// DESIGN §4 ErrorBanner — a lucide icon, a message that names the fix, and
// an optional action. Renders inside the affected region (never a dialog) —
// a read failure is a region-local fact, not an app-wide interruption.
import { CircleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

export interface ErrorBannerAction {
  readonly label: string
  readonly onClick: () => void
}

export interface ErrorBannerProps {
  readonly message: string
  readonly action?: ErrorBannerAction
  readonly className?: string
}

export function ErrorBanner({ message, action, className }: ErrorBannerProps) {
  return (
    <div role="alert" className={cn('flex items-start gap-2 rounded-lg border border-danger-pill bg-danger-pill px-3 py-2 text-small text-danger-pill-foreground', className)}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">{message}</div>
      {action !== undefined ? (
        <Button variant="outline" size="small" onClick={action.onClick} className="shrink-0">
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
