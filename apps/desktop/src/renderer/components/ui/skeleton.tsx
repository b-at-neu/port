import type { ComponentProps } from 'react'
import { cn } from '@/renderer/lib/utils'

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-accent', className)} {...props} />
}
