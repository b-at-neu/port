// Settings → Usage & storage: spend by repository and period, plus app data, plugin cache and worktree disk use.
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Wallet } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { SettingsCard } from '@/renderer/components/settings-card'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { cardReadError, WIDE_CARD } from '@/renderer/settings/copy'
import { sizeText, usageCell, usageFootnote } from '@/renderer/settings/usage-model'
import type { StorageEntry } from '@/types/settings'

function SizeCell({ entry }: { readonly entry: StorageEntry }) {
  const text = sizeText(entry.size)
  if (entry.size.ok) return <span className="shrink-0 tabular-nums text-foreground">{text}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="shrink-0 rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{entry.size.message}</TooltipContent>
    </Tooltip>
  )
}

function SpendCard() {
  const usage = useIpcQuery('usage:summary')
  const repos = useIpcQuery('repos:list')
  const names: Record<string, string> = {}
  if (repos.data?.ok === true) {
    for (const entry of repos.data.repositories) names[entry.id] = 'config' in entry ? entry.config.repo : entry.displayName
  }

  return (
    <SettingsCard title="Spend" className={WIDE_CARD}>
      {usage.status === 'pending' ? (
        <Skeleton className="h-24 w-full" />
      ) : usage.status === 'error' ? (
        <ErrorBanner message={cardReadError('usage')} />
      ) : usage.data.rows.length === 0 ? (
        <EmptyState icon={Wallet} message="No usage recorded yet. Totals appear after port hosts a session." className="py-6" />
      ) : (
        <>
          <table className="w-full text-small">
            <thead>
              <tr className="text-left text-meta text-muted-foreground">
                <th className="py-1 font-medium">Repository</th>
                <th className="py-1 font-medium">Today</th>
                <th className="py-1 font-medium">7 days</th>
                <th className="py-1 font-medium">30 days</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.rows.map((row) => (
                <tr key={row.repoId ?? 'other'} data-slot="usage-row" className="border-t border-border">
                  <td className="py-1.5 text-foreground">{row.repoId === null ? 'Other folders' : (names[row.repoId] ?? row.repoId)}</td>
                  <td className="py-1.5 tabular-nums text-foreground-secondary">{usageCell(row.today)}</td>
                  <td className="py-1.5 tabular-nums text-foreground-secondary">{usageCell(row.week)}</td>
                  <td className="py-1.5 tabular-nums text-foreground-secondary">{usageCell(row.month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-small text-muted-foreground">{usageFootnote(usage.data.since)}</p>
        </>
      )}
    </SettingsCard>
  )
}

function StorageCard() {
  const storage = useIpcQuery('storage:report')
  const navigate = useNavigate()

  const recalculate = (
    <Button variant="outline" size="small" disabled={storage.isFetching} onClick={() => void storage.refetch()}>
      {storage.isFetching ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          Calculating…
        </>
      ) : (
        'Recalculate'
      )}
    </Button>
  )

  return (
    <SettingsCard title="Storage" className={WIDE_CARD} actions={recalculate}>
      {storage.status === 'pending' ? (
        <Skeleton className="h-24 w-full" />
      ) : storage.status === 'error' ? (
        <ErrorBanner message={cardReadError('storage')} />
      ) : (
        <div className="flex flex-col">
          {[...storage.data.appData, storage.data.pluginCache].map((entry) => (
            <div key={entry.path} data-slot="usage-row" className="flex h-9 items-center gap-3 border-t border-border text-small first:border-t-0">
              <span className="w-28 shrink-0 text-foreground">{entry.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{entry.path}</span>
              <SizeCell entry={entry} />
            </div>
          ))}
          {storage.data.worktrees.map((entry) => (
            <div key={entry.path} data-slot="usage-row" className="flex h-9 items-center gap-3 border-t border-border text-small">
              <span className="w-28 shrink-0 truncate text-foreground">{entry.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{entry.path}</span>
              <SizeCell entry={entry} />
              <Button variant="outline" size="small" onClick={() => void navigate({ to: ROUTE_IDS.settingsRepo, params: { repoId: entry.repoId }, search: { tab: 'worktrees' } })}>
                Clean up…
              </Button>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  )
}

export function UsageTab() {
  return (
    <>
      <SpendCard />
      <StorageCard />
    </>
  )
}
