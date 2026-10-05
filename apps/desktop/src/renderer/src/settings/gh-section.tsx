// Reads `gh:status` as a query; `gh-model.ts` decides what to show.
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useIpcQuery } from '../data/query'
import { StatusPill } from '../components/status-pill'
import { ErrorBanner } from '../components/error-banner'
import { ghStatusModel } from './gh-model'

export function GhSection() {
  const query = useIpcQuery('gh:status')

  if (query.status === 'pending') {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-meta font-medium text-muted-foreground">GitHub CLI</h2>
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-56" />
      </section>
    )
  }

  if (query.status === 'error') {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-meta font-medium text-muted-foreground">GitHub CLI</h2>
        <ErrorBanner message="Couldn't reach the main process to check gh. Restart port to try again." />
      </section>
    )
  }

  const model = ghStatusModel(query.data)

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-meta font-medium text-muted-foreground">GitHub CLI</h2>
      <StatusPill status={model.pillStatus} label={model.pillLabel} />
      <p className="text-small text-foreground-secondary">{model.body}</p>
      <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
        {query.isFetching ? (
          <>
            <Loader2 aria-hidden="true" className="animate-spin" />
            Checking…
          </>
        ) : (
          'Check again'
        )}
      </Button>
    </section>
  )
}
