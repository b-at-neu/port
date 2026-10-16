// DESIGN §1/§3 — the layout every screen is built from: a 44px ScreenHeader,
// then one body variant. A screen never sets its own outer padding.
import type { ReactNode } from 'react'
import { cn } from '@/renderer/lib/utils'

interface ScreenProps {
  readonly header: ReactNode
  readonly children: ReactNode
  readonly className?: string
}

export function Screen({ header, children, className }: ScreenProps) {
  return <div className={cn('flex h-full min-h-0 flex-col', className)}>{header}{children}</div>
}

type ScreenBodyVariant = 'list' | 'page' | 'form' | 'conversation'

const BODY_CLASS: Readonly<Record<ScreenBodyVariant, string>> = {
  list: 'min-h-0 flex-1 overflow-y-auto',
  page: 'min-h-0 flex-1 overflow-y-auto p-4',
  form: 'min-h-0 flex-1 overflow-y-auto p-4',
  conversation: 'flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4',
}

interface ScreenBodyProps {
  readonly variant: ScreenBodyVariant
  readonly children: ReactNode
  readonly className?: string
}

export function ScreenBody({ variant, children, className }: ScreenBodyProps) {
  if (variant === 'list') return <div className={cn(BODY_CLASS.list, className)}>{children}</div>

  if (variant === 'page') {
    return (
      <div className={cn(BODY_CLASS.page, className)}>
        <div className="flex flex-col gap-3">{children}</div>
      </div>
    )
  }

  if (variant === 'form') {
    return (
      <div className={cn(BODY_CLASS.form, className)}>
        <div className="flex max-w-lg flex-col gap-6 text-left">{children}</div>
      </div>
    )
  }

  return (
    <div className={cn(BODY_CLASS.conversation, className)}>
      <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col gap-3">{children}</div>
    </div>
  )
}
