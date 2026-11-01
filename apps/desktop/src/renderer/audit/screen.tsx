// The Audit screen — every write port made to GitHub, newest first. Read-only: it reads `audit:list` and writes nothing.
import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, ScrollText, X } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { StatusPill } from '@/renderer/components/status-pill'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { formatAgo } from '@/renderer/lib/relative-time'
import { auditRows } from '@/renderer/audit/model'
import {
  ACTOR_LABEL,
  ALL_REPOSITORIES,
  AUDIT_TITLE,
  EMPTY_UNFILTERED,
  emptyFilteredCopy,
  failureCopy,
  footnotes,
  INVOKE_ERROR,
  NO_COMMAND,
  REFRESH_LABEL,
  REMOVE_TICKET_FILTER,
  SHOW_ALL_ACTION,
} from '@/renderer/audit/copy'
import type { AuditRowView } from '@/types/writes'
import type { RepoId, RepositoryEntry } from '@/utils/repos'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

export function AuditScreen() {
  const search = useSearch({ from: ROUTE_IDS.audit })
  const navigate = useNavigate()
  const repoId = search.repo ?? null
  const number = search.number ?? null
  const audit = useIpcQuery('audit:list', { repoId, number })
  const repos = useIpcQuery('repos:list')
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []
  const repoName = readyRepos.find((repo) => repo.id === repoId)?.config.repo ?? repoId ?? ''
  const filtered = repoId !== null
  const readAt = audit.data?.readAt ?? ''

  function setFilters(next: { readonly repo: RepoId | null; readonly number: number | null }): void {
    void navigate({ to: ROUTE_IDS.audit, search: next })
  }

  return (
    <Screen
      header={
        <ScreenHeader className="justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span>{AUDIT_TITLE}</span>
            <Select value={repoId ?? 'all'} onValueChange={(value) => setFilters({ repo: value === 'all' ? null : (value as RepoId), number: null })}>
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
            {number !== null ? (
              <Button variant="outline" size="small" aria-label={REMOVE_TICKET_FILTER} onClick={() => setFilters({ repo: repoId, number: null })}>
                #{number}
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <Button variant="ghost" size="small" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
            <RefreshCw aria-hidden="true" className={audit.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {REFRESH_LABEL}
          </Button>
        </ScreenHeader>
      }
    >
      <ScreenBody variant="list">
        {audit.status === 'pending' ? (
          <div className="flex flex-col gap-1 px-4 py-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : audit.status === 'error' ? (
          <ErrorBanner message={INVOKE_ERROR} className="mx-4 my-2" />
        ) : !audit.data.ok ? (
          <ErrorBanner message={failureCopy(audit.data.kind, audit.data.message)} className="mx-4 my-2" />
        ) : audit.data.entries.length === 0 ? (
          filtered ? (
            <EmptyState icon={ScrollText} message={emptyFilteredCopy(repoName, number)} action={{ label: SHOW_ALL_ACTION, onClick: () => setFilters({ repo: null, number: null }) }} className="px-4 py-6" data-slot="audit-empty" />
          ) : (
            <EmptyState icon={ScrollText} message={EMPTY_UNFILTERED} className="px-4 py-6" data-slot="audit-empty" />
          )
        ) : (
          <div className="flex flex-col">
            {auditRows(audit.data.entries).map((row) => (
              <AuditRow key={row.key} row={row} readAt={readAt} />
            ))}
            {footnotes(audit.data.malformed, audit.data.previousPath, audit.data.entries.length).map((note) => (
              <p key={note} className="px-4 py-1 text-meta text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        )}
      </ScreenBody>
    </Screen>
  )
}

function AuditRow({ row, readAt }: { readonly row: AuditRowView; readonly readAt: string }) {
  const [open, setOpen] = useState(false)
  const expandable = row.detail !== null
  const target = row.target === null ? row.repo : `#${String(row.target.number)} ${row.repo}`

  return (
    <div className="flex flex-col" data-slot="audit-row">
      <div className="flex h-9 items-center gap-3 px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="w-16 shrink-0 rounded-sm text-meta text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{formatAgo(new Date(readAt).getTime() - new Date(row.at).getTime())}</span>
          </TooltipTrigger>
          <TooltipContent>{row.at}</TooltipContent>
        </Tooltip>
        <span className="w-10 shrink-0 text-small">{ACTOR_LABEL[row.actor]}</span>
        <span className="w-44 shrink-0 truncate text-small">{target}</span>
        <span className="w-40 shrink-0 truncate font-mono text-meta">{row.action}</span>
        <StatusPill status={row.outcome.tone} label={row.outcome.label} className="shrink-0" />
        {row.command === null ? (
          <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">{NO_COMMAND}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="min-w-0 flex-1 truncate rounded-sm font-mono text-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.command}</span>
            </TooltipTrigger>
            <TooltipContent>{row.command}</TooltipContent>
          </Tooltip>
        )}
        {expandable ? (
          <Button variant="ghost" size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide detail' : 'Detail'}
          </Button>
        ) : null}
      </div>
      {open && row.detail !== null ? <p className="px-4 pb-2 text-meta text-muted-foreground">{row.detail}</p> : null}
    </div>
  )
}
