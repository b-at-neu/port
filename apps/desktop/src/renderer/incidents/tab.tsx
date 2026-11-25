// Settings → Incidents — every anomaly port recorded, grouped by signature. Read-only: it reads the incident channels and writes nothing but the operator's own export.
import { useState } from 'react'
import { Download, RefreshCw, TriangleAlert } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { PageStates } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { SettingsCard } from '@/renderer/components/settings-card'
import { StatusPill } from '@/renderer/components/status-pill'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { WIDE_CARD } from '@/renderer/settings/copy'
import { formatAgoSince } from '@/renderer/lib/time'
import { exportToast, groupRows, recordRow } from '@/renderer/incidents/model'
import type { IncidentGroupRow } from '@/types/incidents'
import {
  ALL_REPOSITORIES,
  EMPTY_UNFILTERED,
  emptyFilteredCopy,
  EXPORT_LABEL,
  failureCopy,
  footnotes,
  HIDE_INCIDENTS,
  INCIDENTS_TITLE,
  INVOKE_ERROR,
  LIST_ERROR,
  REFRESH_LABEL,
  SHOW_ALL_ACTION,
  SHOW_INCIDENTS,
} from '@/renderer/incidents/copy'
import type { RepoId, RepositoryEntry } from '@/utils/repos'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

export function IncidentsTab() {
  const [repoId, setRepoId] = useState<RepoId | null>(null)
  const incidents = useIpcQuery('incidents.groups', { repoId })
  const repos = useIpcQuery('repos.list')
  const exportIncidents = useActionMutation('incidents.export', { toast: { result: exportToast } })
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const repoName = readyRepos.find((repo) => repo.id === repoId)?.config.repo ?? repoId ?? ''
  const readAt = incidents.data?.readAt ?? ''

  const actions = (
    <>
      <Select value={repoId ?? 'all'} onValueChange={(value) => setRepoId(value === 'all' ? null : (value as RepoId))}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{ALL_REPOSITORIES}</SelectItem>
          {readyRepos.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.config.repo}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="ghost" size="small" onClick={() => exportIncidents.request({ repoId })} disabled={exportIncidents.pending}>
        <Download aria-hidden="true" className="size-3.5" />
        {EXPORT_LABEL}
      </Button>
      <Button variant="ghost" size="small" onClick={() => void incidents.refetch()} disabled={incidents.isFetching}>
        <RefreshCw aria-hidden="true" className={incidents.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
        {REFRESH_LABEL}
      </Button>
    </>
  )

  return (
    <SettingsCard title={INCIDENTS_TITLE} className={WIDE_CARD} actions={actions}>
      <PageStates
        state={pageState({ data: incidents.data, status: incidents.status }, (data) => data.ok && data.groups.length === 0)}
        errorMessage={INVOKE_ERROR}
        onRetry={() => void incidents.refetch()}
        empty={
          repoId === null ? (
            <EmptyState icon={TriangleAlert} message={EMPTY_UNFILTERED} className="py-6" data-slot="incidents-empty" />
          ) : (
            <EmptyState icon={TriangleAlert} message={emptyFilteredCopy(repoName)} action={{ label: SHOW_ALL_ACTION, onClick: () => setRepoId(null) }} className="py-6" data-slot="incidents-empty" />
          )
        }
      >
        {incidents.data === undefined ? null : !incidents.data.ok ? (
          <ErrorBanner message={failureCopy(incidents.data.kind, incidents.data.message)} />
        ) : (
          <div className="flex flex-col">
            {groupRows(incidents.data.groups).map((row) => (
              <GroupRow key={row.signature} row={row} repoId={repoId} readAt={readAt} />
            ))}
            {footnotes(incidents.data.malformed, incidents.data.pruned).map((note) => (
              <p key={note} className="py-1 text-meta text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        )}
      </PageStates>
    </SettingsCard>
  )
}

function GroupRow({ row, repoId, readAt }: { readonly row: IncidentGroupRow; readonly repoId: RepoId | null; readonly readAt: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col" data-slot="incident-group">
      <div className="flex h-9 items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="w-16 shrink-0 rounded-sm text-meta text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{formatAgoSince(row.lastAt, new Date(readAt))}</span>
          </TooltipTrigger>
          <TooltipContent>{row.lastAt}</TooltipContent>
        </Tooltip>
        <StatusPill status={row.tone} label={row.bucket} className="shrink-0" />
        <span className="w-40 shrink-0 truncate font-mono text-meta">{row.condition}</span>
        <span className="w-10 shrink-0 text-small">×{row.count}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="min-w-0 flex-1 truncate rounded-sm text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.tickets}</span>
          </TooltipTrigger>
          <TooltipContent>{row.tickets}</TooltipContent>
        </Tooltip>
        <span className="w-16 shrink-0 text-meta text-muted-foreground">{formatAgoSince(row.firstAt, new Date(readAt))}</span>
        <Button variant="ghost" size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? HIDE_INCIDENTS : SHOW_INCIDENTS}
        </Button>
      </div>
      {open ? <GroupRecords signature={row.signature} repoId={repoId} readAt={readAt} /> : null}
    </div>
  )
}

function GroupRecords({ signature, repoId, readAt }: { readonly signature: string; readonly repoId: RepoId | null; readonly readAt: string }) {
  const list = useIpcQuery('incidents.list', { repoId, signature })
  return (
    <PageStates
      state={pageState({ data: list.data, status: list.status }, () => false)}
      loading={
        <div className="flex flex-col gap-1 pb-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      }
      errorMessage={LIST_ERROR}
      onRetry={() => void list.refetch()}
      empty={null}
    >
      {list.data === undefined ? null : !list.data.ok ? (
        <ErrorBanner message={failureCopy(list.data.kind, list.data.message)} />
      ) : (
        <ul className="flex flex-col gap-1 pb-2">
          {list.data.records.map((record) => {
            const view = recordRow(record)
            const parts = [formatAgoSince(view.at, new Date(readAt)), view.ticket, view.action, view.outcome, ...(view.heads === null ? [] : [`head ${view.heads}`])]
            return (
              <li key={view.key} className="font-mono text-meta text-muted-foreground">
                {parts.join(' · ')}
              </li>
            )
          })}
        </ul>
      )}
    </PageStates>
  )
}
