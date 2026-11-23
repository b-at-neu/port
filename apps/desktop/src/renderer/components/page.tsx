// DESIGN §4: every data region renders loading, error and empty; a screen supplies only its view.
import type { ReactNode } from 'react'
import { useIpcQuery } from '@/renderer/data/query'
import type { ActionInput, ActionOutput, QueryName } from '@/types/ipc'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import type { ScreenBodyVariant } from '@/renderer/components/screen'
import { pageState } from '@/renderer/components/page-state'
import type { PageStateKind } from '@/renderer/components/page-state'
import { cn } from '@/renderer/lib/utils'

const RETRY_LABEL = 'Try again'
const SKELETON_ROWS = [0, 1, 2]

function DefaultLoading({ variant }: { readonly variant: ScreenBodyVariant }) {
  return (
    <div className={cn('flex flex-col gap-1', variant === 'list' && 'px-4 py-2')}>
      {SKELETON_ROWS.map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  )
}

interface PageProps {
  readonly header: ReactNode
  readonly variant: ScreenBodyVariant
  readonly state: PageStateKind
  readonly loading?: ReactNode
  readonly errorMessage: string
  readonly onRetry: () => void
  readonly empty: ReactNode
  readonly children: ReactNode
}

export function Page({ header, variant, state, loading, errorMessage, onRetry, empty, children }: PageProps) {
  return (
    <Screen header={header}>
      <ScreenBody variant={variant}>
        {state === 'loading' ? (loading ?? <DefaultLoading variant={variant} />) : null}
        {state === 'error' ? <ErrorBanner message={errorMessage} action={{ label: RETRY_LABEL, onClick: onRetry }} /> : null}
        {state === 'empty' ? empty : null}
        {state === 'ready' ? children : null}
      </ScreenBody>
    </Screen>
  )
}

interface PageSpec<C extends QueryName, V> {
  readonly query: C
  readonly input?: ActionInput<C>
  readonly select?: (data: ActionOutput<C>) => V
  readonly isEmpty?: (view: V) => boolean
  readonly header: (view: V | null) => ReactNode
  readonly variant: ScreenBodyVariant
  readonly loading?: () => ReactNode
  readonly errorMessage: string
  readonly empty: (view: V) => ReactNode
  readonly view: (view: V) => ReactNode
}

/** A screen component over one query: `header` renders in every state, `empty` and `view` only once data is in hand. */
export function definePage<C extends QueryName, V = ActionOutput<C>>(spec: PageSpec<C, V>) {
  return function DefinedPage() {
    const query = useIpcQuery(spec.query, spec.input)
    const view = query.data === undefined ? undefined : spec.select !== undefined ? spec.select(query.data) : (query.data as unknown as V)
    const state = pageState({ data: view, status: query.status }, spec.isEmpty ?? (() => false))
    return (
      <Page
        header={spec.header(view ?? null)}
        variant={spec.variant}
        state={state}
        loading={spec.loading?.()}
        errorMessage={spec.errorMessage}
        onRetry={() => void query.refetch()}
        empty={view === undefined ? null : spec.empty(view)}
      >
        {view === undefined ? null : spec.view(view)}
      </Page>
    )
  }
}
