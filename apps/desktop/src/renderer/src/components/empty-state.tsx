// DESIGN §4 EmptyState — an icon, one sentence, and the single useful
// action.
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

export interface EmptyStateAction {
  readonly label: string
  readonly onClick: () => void
}

export interface EmptyStateProps {
  readonly icon: ComponentType<{ className?: string }>
  readonly message: string
  readonly action?: EmptyStateAction
  readonly className?: string
}

export function EmptyState({ icon: Icon, message, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2 py-6 text-center text-small text-muted-foreground', className)}>
      <Icon aria-hidden="true" className="size-5" />
      <p>{message}</p>
      {action !== undefined ? (
        <Button variant="outline" size="small" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
