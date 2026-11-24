// A Settings card over one query: it renders loading, error and empty, and the caller supplies only the ready view.
import type { ReactNode } from 'react'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { pageState } from '@/renderer/components/page-state'
import { SettingsCard } from '@/renderer/components/settings-card'
import { Skeleton } from '@/renderer/components/ui/skeleton'

interface QueryCardProps<D> {
  readonly title: string
  readonly query: { readonly data: D | undefined; readonly status: 'pending' | 'error' | 'success' }
  readonly errorMessage: string
  readonly loading?: ReactNode
  readonly isEmpty?: (data: D) => boolean
  readonly empty?: ReactNode
  readonly description?: string
  readonly actions?: ReactNode
  readonly className?: string
  readonly footer?: ReactNode
  readonly children: (data: D) => ReactNode
}

export function QueryCard<D>({ title, query, errorMessage, loading, isEmpty, empty, description, actions, className, footer, children }: QueryCardProps<D>) {
  const state = pageState(query, isEmpty ?? (() => false))
  return (
    <SettingsCard title={title} description={description} actions={actions} className={className}>
      {state === 'loading' ? (loading ?? <Skeleton className="h-9 w-full" />) : null}
      {state === 'error' ? <ErrorBanner message={errorMessage} /> : null}
      {state === 'empty' ? empty : null}
      {state === 'ready' && query.data !== undefined ? children(query.data) : null}
      {footer}
    </SettingsCard>
  )
}
