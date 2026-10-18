// The Backlog screen — open, unclaimed issues per ready repo; Work on reuses the claim dialog. No `useEffect`: the list navigator is registered directly in the render body.
import { useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { RefreshCw, ListTodo, ChevronDown } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/renderer/components/ui/dropdown-menu'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { openClaimDialogFor } from '@/renderer/claim/controller'
import { PLAN_GATE_OPTIONS } from '@/renderer/claim/copy'
import { registerListNavigator } from '@/renderer/shell/stores'
import { useListSelection } from '@/renderer/shell/list-selection'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { buildBacklogGroup, relativeAge, exactTime, staleSinceAt } from '@/renderer/backlog/group'
import type { BacklogGroupView, BacklogRowView } from '@/types/backlog'
import { backlogEmptyGroupCopy, backlogNotReadyCopy } from '@/renderer/backlog/copy'
import { isReadyRepo } from '@/utils/repos'
import type { RepoId } from '@/utils/repos'

interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

function rowKey(repoId: RepoId, number: number): string {
  return `${repoId}:${String(number)}`
}

function WorkOnMenu({ row, open, onOpenChange }: { readonly row: BacklogRowView; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()

  function pick(planGate: 'review' | 'auto'): void {
    openClaimDialogFor({
      repoId: row.repoId,
      repo: row.repo,
      number: row.number,
      planGate,
      onClaimed: () => void queryClient.invalidateQueries({ queryKey: ['backlog:list'] }),
    })
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="small" data-slot="backlog-work-on">
          Work on
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {PLAN_GATE_OPTIONS.map((option) => (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <DropdownMenuItem onSelect={() => pick(option.value)}>{option.label}</DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent>{option.hint}</TooltipContent>
          </Tooltip>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BacklogRow({
  row,
  rowProps,
  menuOpen,
  onMenuOpenChange,
  now,
}: {
  readonly row: BacklogRowView
  readonly rowProps: ReturnType<ReturnType<typeof useListSelection>['rowProps']>
  readonly menuOpen: boolean
  readonly onMenuOpenChange: (open: boolean) => void
  readonly now: Date
}) {
  return (
    <div data-slot="backlog-row" {...rowProps} className={`flex h-9 items-center gap-2 px-4 text-body ${rowProps.className}`}>
      <span className="w-12 shrink-0 font-mono tabular-nums text-muted-foreground">#{row.number}</span>
      <a href={row.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-foreground hover:underline">
        {row.title}
      </a>
      {row.assignee !== null ? <span className="shrink-0 text-meta text-muted-foreground">{row.assignee}</span> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 text-meta text-muted-foreground">{relativeAge(row.updatedAt, now)}</span>
        </TooltipTrigger>
        <TooltipContent>{exactTime(row.updatedAt)}</TooltipContent>
      </Tooltip>
      <WorkOnMenu row={row} open={menuOpen} onOpenChange={onMenuOpenChange} />
    </div>
  )
}

function GroupHeader({ repo, count }: { readonly repo: string; readonly count: number | null }) {
  return (
    <div className="flex h-8 items-center bg-sidebar px-4 text-small font-medium text-foreground-secondary">
      {repo}
      {count !== null ? ` · ${String(count)}` : ''}
    </div>
  )
}

function GroupBody({ group, now, rowPropsFor, menuOpenKey, setMenuOpenKey }: { readonly group: BacklogGroupView; readonly now: Date; readonly rowPropsFor: (key: string) => ReturnType<ReturnType<typeof useListSelection>['rowProps']>; readonly menuOpenKey: string | null; readonly setMenuOpenKey: (key: string | null) => void }) {
  if (group.kind === 'loading') {
    return (
      <div className="flex flex-col gap-1 px-4 py-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </div>
    )
  }
  if (group.kind === 'invoke-error' || group.kind === 'read-error') {
    return (
      <div className="px-4 py-2">
        <ErrorBanner message={group.message} />
      </div>
    )
  }
  if (group.items.length === 0) {
    return <EmptyState icon={ListTodo} message={backlogEmptyGroupCopy(group.repo)} className="px-4" />
  }
  return (
    <div>
      {group.truncatedNote !== null ? <p className="px-4 py-1 text-meta text-muted-foreground">{group.truncatedNote}</p> : null}
      {group.items.map((row) => {
        const key = rowKey(row.repoId, row.number)
        return (
          <BacklogRow
            key={key}
            row={row}
            now={now}
            rowProps={rowPropsFor(key)}
            menuOpen={menuOpenKey === key}
            onMenuOpenChange={(open) => setMenuOpenKey(open ? key : null)}
          />
        )
      })}
    </div>
  )
}

export function BacklogScreen() {
  const reposQuery = useIpcQuery('repos:list')
  const navigate = useNavigate()
  const [menuOpenKey, setMenuOpenKey] = useState<string | null>(null)
  const now = new Date()

  const readyRepos: readonly ReadyRepo[] = reposQuery.data?.ok === true ? reposQuery.data.repositories.filter(isReadyRepo).map((e) => ({ id: e.id, repo: e.config.repo })) : []
  const notReadyRepos = reposQuery.data?.ok === true ? reposQuery.data.repositories.filter((e) => !isReadyRepo(e)) : []

  const queries = useQueries({ queries: readyRepos.map((r) => ipcQueryOptions('backlog:list', { repoId: r.id })) })

  const groups: BacklogGroupView[] = readyRepos.map((r, i) => {
    const q = queries[i]
    return buildBacklogGroup(r.id, r.repo, { status: q?.status ?? 'pending', data: q?.data, isError: q?.isError ?? false, dataUpdatedAt: q?.dataUpdatedAt ?? 0 })
  })

  const flatRows: BacklogRowView[] = groups.flatMap((g) => (g.kind === 'loaded' ? g.items : []))
  const flatKeys = flatRows.map((row) => rowKey(row.repoId, row.number))
  const selection = useListSelection(flatKeys)

  registerListNavigator('backlog', {
    next: () => selection.next(),
    prev: () => selection.prev(),
    open: () => {
      if (selection.selectedKey !== null) setMenuOpenKey(selection.selectedKey)
    },
  })

  function refreshAll(): void {
    for (const q of queries) void q.refetch()
  }

  const stale = staleSinceAt(queries.map((q) => ({ query: { status: q.status, data: q.data, isError: q.isError, dataUpdatedAt: q.dataUpdatedAt } })))
  const isFetching = queries.some((q) => q.isFetching)

  return (
    <Screen
      header={
        <ScreenHeader className="justify-between">
          <span>Backlog</span>
          <div className="flex items-center gap-2">
            {stale !== null ? <span className="text-meta font-normal text-attention-dot">Updated {relativeAge(new Date(stale).toISOString(), now)}</span> : null}
            <Button variant="ghost" size="small" onClick={refreshAll} disabled={isFetching}>
              <RefreshCw aria-hidden="true" className={isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
              Refresh
            </Button>
          </div>
        </ScreenHeader>
      }
    >
      <ScreenBody variant="list">
        <div>
          {reposQuery.status === 'pending' ? (
            <div className="flex flex-col gap-1 px-4 py-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ) : readyRepos.length === 0 ? (
            <EmptyState icon={ListTodo} message="Register a repository to see its open tickets." action={{ label: 'Open Repositories', onClick: () => void navigate({ to: ROUTE_IDS.repos }) }} className="px-4 py-6" />
          ) : (
            groups.map((group) => (
              <div key={group.repoId}>
                <GroupHeader repo={group.repo} count={group.kind === 'loaded' ? group.items.length : null} />
                <GroupBody group={group} now={now} rowPropsFor={(key) => selection.rowProps(key)} menuOpenKey={menuOpenKey} setMenuOpenKey={setMenuOpenKey} />
              </div>
            ))
          )}
          {notReadyRepos.map((entry) => (
            <p key={entry.id} className="px-4 py-1 text-meta text-muted-foreground">
              {backlogNotReadyCopy(entry.displayName)}
            </p>
          ))}
        </div>
      </ScreenBody>
    </Screen>
  )
}
