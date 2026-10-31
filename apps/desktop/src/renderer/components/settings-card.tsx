// The one card every Settings tab is built from (DESIGN §4).
import type { ReactNode } from 'react'
import { cn } from '@/renderer/lib/utils'

interface SettingsCardProps {
  readonly title: string
  readonly description?: string
  readonly actions?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}

export function SettingsCard({ title, description, actions, children, className }: SettingsCardProps) {
  return (
    <section data-slot="settings-card" className={cn('flex flex-col gap-3 rounded-lg border border-border bg-card p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-meta font-medium text-muted-foreground">{title}</h2>
          {description !== undefined ? <p className="text-small text-muted-foreground">{description}</p> : null}
        </div>
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}
