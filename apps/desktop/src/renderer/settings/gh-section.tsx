// Reads `gh:status` as a query; `gh-model.ts` decides what to show.
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { useIpcQuery } from '@/renderer/data/query'
import { StatusPill } from '@/renderer/components/status-pill'
import { formatAgoSince } from '@/renderer/lib/time'
import { ghStatusModel } from '@/renderer/settings/gh-model'
import { cardCheckError, checkedAgoLine, CHECKING_LABEL, GH_SUBJECT, GH_TITLE, RECHECK_LABEL } from '@/renderer/settings/copy'
import { QueryCard } from '@/renderer/settings/query-card'

export function GhSection() {
  const query = useIpcQuery('gh.status')

  return (
    <QueryCard
      title={GH_TITLE}
      query={query}
      errorMessage={cardCheckError(GH_SUBJECT)}
      loading={
        <>
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-4 w-56" />
        </>
      }
    >
      {(status) => {
        const model = ghStatusModel(status)
        return (
          <>
            <StatusPill status={model.pillStatus} label={model.pillLabel} />
            <p className="text-small text-foreground-secondary">{model.body}</p>
            {model.scopesLine !== null ? <p className="font-mono text-small text-muted-foreground">{model.scopesLine}</p> : null}
            <p className="text-small text-muted-foreground">{checkedAgoLine(formatAgoSince(status.checkedAt, new Date()))}</p>
            <Button className="w-fit" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {query.isFetching ? (
                <>
                  <Loader2 aria-hidden="true" className="animate-spin" />
                  {CHECKING_LABEL}
                </>
              ) : (
                RECHECK_LABEL
              )}
            </Button>
          </>
        )
      }}
    </QueryCard>
  )
}
