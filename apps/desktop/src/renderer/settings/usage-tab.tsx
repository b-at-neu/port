// Settings → Usage & storage: spend by repository and period, plus app data, plugin cache and worktree disk use.
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Wallet } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { EmptyState } from '@/renderer/components/empty-state'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import {
  CALCULATING_LABEL,
  cardReadError,
  CLEAN_UP_LABEL,
  OTHER_FOLDERS,
  RECALCULATE_LABEL,
  SPEND_COLUMNS,
  SPEND_EMPTY,
  SPEND_SUBJECT,
  SPEND_TITLE,
  STORAGE_SUBJECT,
  STORAGE_TITLE,
  WIDE_CARD,
} from '@/renderer/settings/copy'
import { QueryCard } from '@/renderer/settings/query-card'
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
  const usage = useIpcQuery('usage.summary')
  const repos = useIpcQuery('repos.list')
  const names: Record<string, string> = {}
  if (repos.data?.ok === true) {
    for (const entry of repos.data.repositories) names[entry.id] = 'config' in entry ? entry.config.repo : entry.displayName
  }

  return (
    <QueryCard
      title={SPEND_TITLE}
      className={WIDE_CARD}
      query={usage}
      errorMessage={cardReadError(SPEND_SUBJECT)}
      loading={<Skeleton className="h-24 w-full" />}
      isEmpty={(summary) => summary.rows.length === 0}
      empty={<EmptyState icon={Wallet} message={SPEND_EMPTY} className="py-6" />}
    >
      {(summary) => (
        <>
          <table className="w-full text-small">
            <thead>
              <tr className="text-left text-meta text-muted-foreground">
                {SPEND_COLUMNS.map((column) => (
                  <th key={column} className="py-1 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.repoId ?? 'other'} data-slot="usage-row" className="border-t border-border">
                  <td className="py-1.5 text-foreground">{row.repoId === null ? OTHER_FOLDERS : (names[row.repoId] ?? row.repoId)}</td>
                  <td className="py-1.5 tabular-nums text-foreground-secondary">{usageCell(row.today)}</td>
                  <td className="py-1.5 tabular-nums text-foreground-secondary">{usageCell(row.week)}</td>
                  <td className="py-1.5 tabular-nums text-foreground-secondary">{usageCell(row.month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-small text-muted-foreground">{usageFootnote(summary.since)}</p>
        </>
      )}
    </QueryCard>
  )
}

function StorageCard() {
  const storage = useIpcQuery('storage.report')
  const navigate = useNavigate()

  const recalculate = (
    <Button variant="outline" size="small" disabled={storage.isFetching} onClick={() => void storage.refetch()}>
      {storage.isFetching ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          {CALCULATING_LABEL}
        </>
      ) : (
        RECALCULATE_LABEL
      )}
    </Button>
  )

  return (
    <QueryCard title={STORAGE_TITLE} className={WIDE_CARD} actions={recalculate} query={storage} errorMessage={cardReadError(STORAGE_SUBJECT)} loading={<Skeleton className="h-24 w-full" />}>
      {(report) => (
        <div className="flex flex-col">
          {[...report.appData, report.pluginCache].map((entry) => (
            <div key={entry.path} data-slot="usage-row" className="flex h-9 items-center gap-3 border-t border-border text-small first:border-t-0">
              <span className="w-28 shrink-0 text-foreground">{entry.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{entry.path}</span>
              <SizeCell entry={entry} />
            </div>
          ))}
          {report.worktrees.map((entry) => (
            <div key={entry.path} data-slot="usage-row" className="flex h-9 items-center gap-3 border-t border-border text-small">
              <span className="w-28 shrink-0 truncate text-foreground">{entry.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{entry.path}</span>
              <SizeCell entry={entry} />
              <Button variant="outline" size="small" onClick={() => void navigate({ to: ROUTE_IDS.settingsRepo, params: { repoId: entry.repoId }, search: { tab: 'worktrees' } })}>
                {CLEAN_UP_LABEL}
              </Button>
            </div>
          ))}
        </div>
      )}
    </QueryCard>
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
