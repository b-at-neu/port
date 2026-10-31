// Reads `gh:status` as a query; `gh-model.ts` decides what to show.
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { SettingsCard } from '@/renderer/components/settings-card'
import { useIpcQuery } from '@/renderer/data/query'
import { StatusPill } from '@/renderer/components/status-pill'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { formatAgo } from '@/renderer/lib/relative-time'
import { ghStatusModel } from '@/renderer/settings/gh-model'

export function GhSection() {
  const query = useIpcQuery('gh:status')

  if (query.status === 'pending') {
    return (
      <SettingsCard title="GitHub CLI">
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-56" />
      </SettingsCard>
    )
  }

  if (query.status === 'error') {
    return (
      <SettingsCard title="GitHub CLI">
        <ErrorBanner message="Couldn't reach the main process to check gh. Restart port to try again." />
      </SettingsCard>
    )
  }

  const model = ghStatusModel(query.data)

  return (
    <SettingsCard title="GitHub CLI">
      <StatusPill status={model.pillStatus} label={model.pillLabel} />
      <p className="text-small text-foreground-secondary">{model.body}</p>
      {model.scopesLine !== null ? <p className="font-mono text-small text-muted-foreground">{model.scopesLine}</p> : null}
      <p className="text-small text-muted-foreground">Checked {formatAgo(Date.now() - Date.parse(query.data.checkedAt))}</p>
      <Button className="w-fit" disabled={query.isFetching} onClick={() => void query.refetch()}>
        {query.isFetching ? (
          <>
            <Loader2 aria-hidden="true" className="animate-spin" />
            Checking…
          </>
        ) : (
          'Recheck'
        )}
      </Button>
    </SettingsCard>
  )
}
