// DESIGN §3/§4 ScreenHeader — 44px, text-title 600, bottom border.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ScreenHeaderProps {
  readonly children: ReactNode
  readonly className?: string
}

export function ScreenHeader({ children, className }: ScreenHeaderProps) {
  return <div className={cn('flex h-11 shrink-0 items-center border-b border-border px-4 text-title font-semibold', className)}>{children}</div>
}
