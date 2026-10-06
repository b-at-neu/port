import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'w-full min-w-0 resize-y rounded-md border border-border bg-transparent px-3 py-2 text-small outline-none transition-colors placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
      {...props}
    />
  )
}
