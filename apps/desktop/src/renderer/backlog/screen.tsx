// The Backlog screen — open, unclaimed issues per ready repo, with a detail pane for the clicked row; Work on claims at once, or after a confirmation for a blocked ticket, and reports by toast. No `useEffect`: the list navigator is registered directly in the render body.
import { useState } from 'react'
import type { MouseEvent } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, ListTodo } from 'lucide-react'
import { SHOW_ALL_REPOSITORIES, unknownRepoCopy } from '@/renderer/lib/copy'
import { CollapsibleGroupHeader } from '@/renderer/components/collapsible-group-header'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { workOn } from '@/renderer/claim/work-on'
import { registerListNavigator } from '@/renderer/shell/stores'
import { isControlPress, pressZone, useListSelection } from '@/renderer/shell/list-selection'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { buildBacklogGroup, relativeAge, staleSinceAt } from '@/renderer/backlog/group'
import type { BacklogGroupView, BacklogLabelFilter, BacklogRowView, RenderBacklogRow } from '@/types/backlog'
import type { PlanGateChoice } from '@/types/claim'
import { BACKLOG_ALL_HIDDEN, BACKLOG_FILTER_CLEAR, BACKLOG_REPO_FILTER_SHOW_ALL, backlogCountCopy, backlogEmptyGroupCopy, backlogFilteredEmptyCopy, backlogGroupToggleAria, backlogNotReadyCopy } from '@/renderer/backlog/copy'
import { workOnReasons } from '@/renderer/backlog/confirm'
import { isEpic } from '@/renderer/backlog/epics'
import { WorkOnConfirm } from '@/renderer/backlog/work-on-confirm'
import { EMPTY_FILTER } from '@/renderer/backlog/filter'
import { readBacklogCollapsed, readBacklogCollapsedEpics, readBacklogFilters, readBacklogHiddenRepos, setBacklogCollapsed, setBacklogCollapsedEpic, setBacklogFilter, setBacklogHiddenRepos } from '@/renderer/backlog/prefs'
import { navigableRows, rowKey, toggleHiddenRepo, visibleRepos } from '@/renderer/backlog/sections'
import { BacklogRow } from '@/renderer/backlog/backlog-row'
import { backlogRowPress, findEpicGroup } from '@/renderer/backlog/detail'
import { BacklogDetailPane } from '@/renderer/backlog/detail-panel'
import { EpicGroup } from '@/renderer/backlog/epic-group'
import { LabelFilterMenu } from '@/renderer/backlog/label-filter-menu'
import { RepoFilterMenu } from '@/renderer/backlog/repo-filter-menu'
import { isReadyRepo } from '@/utils/repos'
import type { RepoId } from '@/utils/repos'

type RowProps = ReturnType<ReturnType<typeof useListSelection>['rowProps']>

interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

function GroupHeader({
  group,
  filter,
  collapsed,
  onToggleCollapsed,
  onFilterChange,
}: {
  readonly group: BacklogGroupView
  readonly filter: BacklogLabelFilter
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly onFilterChange: (filter: BacklogLabelFilter) => void
}) {
  return (
    <CollapsibleGroupHeader
      label={group.kind === 'loaded' ? backlogCountCopy(group.repo, group.items.length, group.totalCount) : group.repo}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
      toggleLabel={backlogGroupToggleAria(group.repo, collapsed)}
      toggleSlot="backlog-group-toggle"
    >
      {group.kind === 'loaded' && group.labelOptions.length > 0 ? <LabelFilterMenu options={group.labelOptions} filter={filter} onChange={onFilterChange} /> : null}
    </CollapsibleGroupHeader>
  )
}

function GroupBody({
  group,
  now,
  rowPropsFor,
  menuOpenKey,
  pendingKeys,
  collapsedEpics,
  setMenuOpenKey,
  onToggleEpic,
  onOpenDetail,
  onPick,
  onClearFilter,
}: {
  readonly group: BacklogGroupView
  readonly now: Date
  readonly rowPropsFor: (key: string) => RowProps
  readonly menuOpenKey: string | null
  readonly pendingKeys: ReadonlySet<string>
  readonly collapsedEpics: ReadonlySet<string>
  readonly setMenuOpenKey: (key: string | null) => void
  readonly onToggleEpic: (key: string) => void
  readonly onOpenDetail: (key: string) => void
  readonly onPick: (row: BacklogRowView, planGate: PlanGateChoice) => boolean
  readonly onClearFilter: () => void
}) {
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
    if (group.totalCount > 0) {
      return <EmptyState icon={ListTodo} message={backlogFilteredEmptyCopy(group.repo)} action={{ label: BACKLOG_FILTER_CLEAR, onClick: onClearFilter }} className="px-4" />
    }
    return <EmptyState icon={ListTodo} message={backlogEmptyGroupCopy(group.repo)} className="px-4" />
  }
  const renderRow: RenderBacklogRow = (row, extras) => {
    const key = rowKey(row.repoId, row.number)
    return (
      <BacklogRow
        key={key}
        row={row}
        now={now}
        rowProps={rowPropsFor(key)}
        menuOpen={menuOpenKey === key}
        pending={pendingKeys.has(key)}
        onMenuOpenChange={(next) => setMenuOpenKey(next ? key : null)}
        onPick={(planGate) => onPick(row, planGate)}
        onOpenDetail={() => onOpenDetail(key)}
        {...extras}
      />
    )
  }
  return (
    <div>
      {group.truncatedNote !== null ? <p className="px-4 py-1 text-meta text-muted-foreground">{group.truncatedNote}</p> : null}
      {group.layout.entries.map((entry) => {
        if (entry.kind === 'row') return renderRow(entry.row)
        const key = rowKey(entry.group.epic.repoId, entry.group.epic.number)
        return <EpicGroup key={key} group={entry.group} collapsedEpics={collapsedEpics} onToggleEpic={onToggleEpic} renderRow={renderRow} />
      })}
    </div>
  )
}

export function BacklogScreen() {
  const reposQuery = useIpcQuery('repos.list')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [menuOpenKey, setMenuOpenKey] = useState<string | null>(null)
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  const [confirm, setConfirm] = useState<{
    readonly row: BacklogRowView
    readonly planGate: PlanGateChoice
  } | null>(null)
  const [filters, setFilters] = useState<ReadonlyMap<RepoId, BacklogLabelFilter>>(() => readBacklogFilters())
  const [collapsed, setCollapsed] = useState<ReadonlySet<RepoId>>(() => readBacklogCollapsed())
  const [collapsedEpics, setCollapsedEpics] = useState<ReadonlySet<string>>(() => readBacklogCollapsedEpics())
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<RepoId>>(() => readBacklogHiddenRepos())
  const now = new Date()

  const scopedRepo = useSearch({ from: ROUTE_IDS.backlog }).repo ?? null

  const entries = reposQuery.data?.ok === true ? reposQuery.data.repositories : []
  const readyRepos: readonly ReadyRepo[] = entries.filter(isReadyRepo).map((e) => ({ id: e.id, repo: e.config.repo }))
  const notReadyRepos = entries.filter((e) => !isReadyRepo(e) && (scopedRepo === null || e.id === scopedRepo))
  const unknownRepo = scopedRepo !== null && reposQuery.data?.ok === true && !entries.some((e) => e.id === scopedRepo) ? scopedRepo : null

  const shownRepos = scopedRepo !== null ? readyRepos.filter((r) => r.id === scopedRepo) : visibleRepos(readyRepos, hidden)
  const queries = useQueries({
    queries: shownRepos.map((r) => ipcQueryOptions('backlog.list', { repoId: r.id })),
  })

  function toggleCollapsed(repoId: RepoId): void {
    const next = !collapsed.has(repoId)
    setCollapsed((previous) => {
      const updated = new Set(previous)
      if (next) updated.add(repoId)
      else updated.delete(repoId)
      return updated
    })
    setBacklogCollapsed(repoId, next)
  }
  function toggleEpic(key: string): void {
    const next = !collapsedEpics.has(key)
    setCollapsedEpics((previous) => {
      const updated = new Set(previous)
      if (next) updated.add(key)
      else updated.delete(key)
      return updated
    })
    setBacklogCollapsedEpic(key, next)
  }
  function changeHidden(next: ReadonlySet<RepoId>): void {
    setHidden(next)
    setBacklogHiddenRepos(next)
  }

  const filterOf = (repoId: RepoId): BacklogLabelFilter => filters.get(repoId) ?? EMPTY_FILTER
  function changeFilter(repoId: RepoId, filter: BacklogLabelFilter): void {
    setFilters((previous) => new Map(previous).set(repoId, filter))
    setBacklogFilter(repoId, filter)
  }

  const groups: BacklogGroupView[] = shownRepos.map((r, i) => {
    const q = queries[i]
    return buildBacklogGroup(
      r.id,
      r.repo,
      {
        status: q?.status ?? 'pending',
        data: q?.data,
        isError: q?.isError ?? false,
        dataUpdatedAt: q?.dataUpdatedAt ?? 0,
      },
      filterOf(r.id),
    )
  })

  const flatRows = navigableRows(groups, collapsed, collapsedEpics)
  const flatKeys = flatRows.map((row) => rowKey(row.repoId, row.number))
  const selection = useListSelection(flatKeys)
  const detailRow = detailKey === null ? null : (flatRows.find((row) => rowKey(row.repoId, row.number) === detailKey) ?? null)
  const detailEpic = detailRow === null ? null : findEpicGroup(groups, detailRow.repoId, detailRow.number)

  function setPending(key: string, pending: boolean): void {
    setPendingKeys((previous) => {
      const next = new Set(previous)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function start(row: BacklogRowView, planGate: PlanGateChoice): void {
    const key = rowKey(row.repoId, row.number)
    setPending(key, true)
    void workOn({
      repoId: row.repoId,
      repo: row.repo,
      number: row.number,
      planGate,
      onClaimed: () => void queryClient.invalidateQueries({ queryKey: ['backlog.list'] }),
    }).finally(() => setPending(key, false))
  }

  function pick(row: BacklogRowView, planGate: PlanGateChoice): boolean {
    if (workOnReasons(row) === null) {
      start(row, planGate)
      return false
    }
    setConfirm({ row, planGate })
    return true
  }

  function confirmStart(): void {
    if (confirm === null) return
    const { row, planGate } = confirm
    setConfirm(null)
    start(row, planGate)
  }

  function openDetail(key: string): void {
    selection.select(key)
    setDetailKey(key)
  }

  function closeDetailAndClear(): void {
    selection.clear()
    setDetailKey(null)
  }

  function rowPropsFor(key: string): RowProps {
    const props = selection.rowProps(key)
    return {
      ...props,
      onMouseDown: (event: MouseEvent) => {
        const press = backlogRowPress({
          key,
          detailKey,
          button: event.button,
          onControl: isControlPress(event),
        })
        if (press === 'close') {
          // Without this the focus that follows the press would select the row again.
          event.preventDefault()
          closeDetailAndClear()
          return
        }
        if (press === 'open') openDetail(key)
        else selection.select(key)
      },
    }
  }

  function onSurfaceMouseDown(event: MouseEvent<HTMLElement>): void {
    if (event.button === 0 && pressZone(event, event.currentTarget) === 'blank') closeDetailAndClear()
  }

  registerListNavigator('backlog', {
    next: () => selection.next(),
    prev: () => selection.prev(),
    close: () => setDetailKey(null),
    open: () => {
      const selected = flatRows.find((row) => rowKey(row.repoId, row.number) === selection.selectedKey)
      if (selected !== undefined && !isEpic(selected)) setMenuOpenKey(rowKey(selected.repoId, selected.number))
    },
  })

  function refreshAll(): void {
    for (const q of queries) void q.refetch()
    void queryClient.invalidateQueries({ queryKey: ['backlog.detail'] })
  }

  const stale = staleSinceAt(
    queries.map((q) => ({
      query: { status: q.status, data: q.data, isError: q.isError, dataUpdatedAt: q.dataUpdatedAt },
    })),
  )
  const isFetching = queries.some((q) => q.isFetching)

  return (
    <Screen
      onMouseDown={onSurfaceMouseDown}
      header={
        <ScreenHeader className="justify-between">
          <span>Backlog</span>
          <div className="flex items-center gap-2">
            {stale !== null ? <span className="text-meta font-normal text-attention-dot">Updated {relativeAge(new Date(stale).toISOString(), now)}</span> : null}
            {scopedRepo === null && readyRepos.length > 1 ? <RepoFilterMenu repos={readyRepos} hidden={hidden} onToggle={(id) => changeHidden(toggleHiddenRepo(hidden, id))} onShowAll={() => changeHidden(new Set())} /> : null}
            <Button variant="ghost" size="small" onClick={refreshAll} disabled={isFetching}>
              <RefreshCw aria-hidden="true" className={isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
              Refresh
            </Button>
          </div>
        </ScreenHeader>
      }
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ScreenBody variant="list" className="flex-1">
          <div>
            {reposQuery.status === 'pending' ? (
              <div className="flex flex-col gap-1 px-4 py-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : unknownRepo !== null ? (
              <EmptyState
                icon={ListTodo}
                message={unknownRepoCopy(unknownRepo)}
                action={{
                  label: SHOW_ALL_REPOSITORIES,
                  onClick: () => void navigate({ to: ROUTE_IDS.backlog, search: { repo: null } }),
                }}
                className="px-4 py-6"
              />
            ) : readyRepos.length === 0 ? (
              <EmptyState
                icon={ListTodo}
                message="Register a repository to see its open tickets."
                action={{
                  label: 'Open Repositories',
                  onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }),
                }}
                className="px-4 py-6"
              />
            ) : scopedRepo !== null && shownRepos.length === 0 ? null : shownRepos.length === 0 ? (
              <EmptyState
                icon={ListTodo}
                message={BACKLOG_ALL_HIDDEN}
                action={{
                  label: BACKLOG_REPO_FILTER_SHOW_ALL,
                  onClick: () => changeHidden(new Set()),
                }}
                className="px-4 py-6"
              />
            ) : (
              groups.map((group) => {
                const isCollapsed = collapsed.has(group.repoId)
                return (
                  <div key={group.repoId} data-slot="backlog-group" data-repo={group.repo} data-collapsed={isCollapsed}>
                    <GroupHeader group={group} filter={filterOf(group.repoId)} collapsed={isCollapsed} onToggleCollapsed={() => toggleCollapsed(group.repoId)} onFilterChange={(filter) => changeFilter(group.repoId, filter)} />
                    {isCollapsed ? null : (
                      <GroupBody
                        group={group}
                        now={now}
                        rowPropsFor={rowPropsFor}
                        menuOpenKey={menuOpenKey}
                        pendingKeys={pendingKeys}
                        collapsedEpics={collapsedEpics}
                        setMenuOpenKey={setMenuOpenKey}
                        onToggleEpic={toggleEpic}
                        onOpenDetail={openDetail}
                        onPick={pick}
                        onClearFilter={() => changeFilter(group.repoId, EMPTY_FILTER)}
                      />
                    )}
                  </div>
                )
              })
            )}
            {notReadyRepos.map((entry) => (
              <p key={entry.id} className="px-4 py-1 text-meta text-muted-foreground">
                {backlogNotReadyCopy(entry.displayName)}
              </p>
            ))}
          </div>
        </ScreenBody>
        {detailRow !== null ? <BacklogDetailPane row={detailRow} epic={detailEpic} now={now} onClose={() => setDetailKey(null)} /> : null}
      </div>
      <WorkOnConfirm open={confirm !== null} number={confirm?.row.number ?? 0} reasons={confirm === null ? null : workOnReasons(confirm.row)} onCancel={() => setConfirm(null)} onConfirm={confirmStart} />
    </Screen>
  )
}
