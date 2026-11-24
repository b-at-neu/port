// The Backlog screen — open, unclaimed issues per ready repo, with a detail pane for the clicked row; Work on claims at once, or after a confirmation for a blocked ticket, and reports by toast. No `useEffect`: the list navigator is registered directly in the render body.
import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RefreshCw, ListTodo } from 'lucide-react'
import { SHOW_ALL_REPOSITORIES, unknownRepoCopy } from '@/renderer/lib/copy'
import { CollapsibleGroupHeader } from '@/renderer/components/collapsible-group-header'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { ConfirmDialog } from '@/renderer/components/confirm-dialog'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { Page } from '@/renderer/components/page'
import { ipcQueryOptions, useIpcQuery } from '@/renderer/data/query'
import { useWorkOn } from '@/renderer/claim/use-work-on'
import { listNavigatorRef } from '@/renderer/shell/list-navigator'
import { isControlPress, pressZone, useListSelection } from '@/renderer/shell/list-selection'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { buildBacklogGroup, staleSinceAt } from '@/renderer/backlog/group'
import { formatAgo } from '@/renderer/lib/time'
import type { BacklogGroupView, BacklogLabelFilter, BacklogRowView, RenderBacklogRow, WorkOnReasons } from '@/types/backlog'
import type { PlanGateChoice } from '@/types/claim'
import {
  BACKLOG_ALL_HIDDEN,
  BACKLOG_FILTER_CLEAR,
  BACKLOG_NO_REPOS,
  BACKLOG_OPEN_REPOSITORIES,
  BACKLOG_REFRESH,
  BACKLOG_REPO_FILTER_SHOW_ALL,
  BACKLOG_TITLE,
  backlogCountCopy,
  backlogEmptyGroupCopy,
  backlogFilteredEmptyCopy,
  backlogGroupToggleAria,
  backlogNotReadyCopy,
  backlogUpdatedCopy,
} from '@/renderer/backlog/copy'
import { workOnReasons } from '@/renderer/backlog/confirm'
import { isEpic } from '@/renderer/backlog/epics'
import { workOnConfirmSpec } from '@/renderer/backlog/work-on-confirm'
import { EMPTY_FILTER } from '@/renderer/backlog/filter'
import { backlogPageState, backlogView } from '@/renderer/backlog/model'
import type { BacklogBody } from '@/renderer/backlog/model'
import { readBacklogCollapsed, readBacklogCollapsedEpics, readBacklogFilters, readBacklogHiddenRepos, setBacklogCollapsed, setBacklogCollapsedEpic, setBacklogFilter, setBacklogHiddenRepos } from '@/renderer/backlog/prefs'
import { navigableRows, rowKey, toggleHiddenRepo } from '@/renderer/backlog/sections'
import { BacklogRow } from '@/renderer/backlog/backlog-row'
import { backlogRowPress, findEpicGroup } from '@/renderer/backlog/detail'
import { BacklogDetailPane } from '@/renderer/backlog/detail-panel'
import { EpicGroup } from '@/renderer/backlog/epic-group'
import { LabelFilterMenu } from '@/renderer/backlog/label-filter-menu'
import { RepoFilterMenu } from '@/renderer/backlog/repo-filter-menu'
import type { RepoId, RepositoryEntry } from '@/utils/repos'

type RowProps = ReturnType<ReturnType<typeof useListSelection>['rowProps']>

interface PendingConfirm {
  readonly row: BacklogRowView
  readonly planGate: PlanGateChoice
  readonly reasons: WorkOnReasons
  readonly open: boolean
}

function BacklogHeader({
  stale,
  now,
  repoFilter,
  isFetching,
  onRefresh,
}: {
  readonly stale: number | null
  readonly now: Date
  readonly repoFilter: ReactNode
  readonly isFetching: boolean
  readonly onRefresh: () => void
}) {
  return (
    <ScreenHeader className="justify-between">
      <span>{BACKLOG_TITLE}</span>
      <div className="flex items-center gap-2">
        {stale !== null ? <span className="text-meta font-normal text-attention-dot">{backlogUpdatedCopy(formatAgo(now.getTime() - stale))}</span> : null}
        {repoFilter}
        <Button variant="ghost" size="small" onClick={onRefresh} disabled={isFetching}>
          <RefreshCw aria-hidden="true" className={isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {BACKLOG_REFRESH}
        </Button>
      </div>
    </ScreenHeader>
  )
}

function NotReadyLines({ entries }: { readonly entries: readonly RepositoryEntry[] }) {
  return (
    <>
      {entries.map((entry) => (
        <p key={entry.id} className="px-4 py-1 text-meta text-muted-foreground">
          {backlogNotReadyCopy(entry.displayName)}
        </p>
      ))}
    </>
  )
}

function BacklogEmpty({
  body,
  notReadyRepos,
  onShowAllRepositories,
  onOpenRepositories,
  onShowAllHidden,
}: {
  readonly body: BacklogBody
  readonly notReadyRepos: readonly RepositoryEntry[]
  readonly onShowAllRepositories: () => void
  readonly onOpenRepositories: () => void
  readonly onShowAllHidden: () => void
}) {
  return (
    <div>
      {body.kind === 'unknown-repo' ? <EmptyState icon={ListTodo} message={unknownRepoCopy(body.repoId)} action={{ label: SHOW_ALL_REPOSITORIES, onClick: onShowAllRepositories }} className="px-4 py-6" /> : null}
      {body.kind === 'no-repos' ? <EmptyState icon={ListTodo} message={BACKLOG_NO_REPOS} action={{ label: BACKLOG_OPEN_REPOSITORIES, onClick: onOpenRepositories }} className="px-4 py-6" /> : null}
      {body.kind === 'all-hidden' ? <EmptyState icon={ListTodo} message={BACKLOG_ALL_HIDDEN} action={{ label: BACKLOG_REPO_FILTER_SHOW_ALL, onClick: onShowAllHidden }} className="px-4 py-6" /> : null}
      <NotReadyLines entries={notReadyRepos} />
    </div>
  )
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
  const workOn = useWorkOn()
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [filters, setFilters] = useState<ReadonlyMap<RepoId, BacklogLabelFilter>>(() => readBacklogFilters())
  const [collapsed, setCollapsed] = useState<ReadonlySet<RepoId>>(() => readBacklogCollapsed())
  const [collapsedEpics, setCollapsedEpics] = useState<ReadonlySet<string>>(() => readBacklogCollapsedEpics())
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<RepoId>>(() => readBacklogHiddenRepos())
  const now = new Date()

  const scopedRepo = useSearch({ from: ROUTE_IDS.backlog }).repo ?? null

  const view = backlogView({ reposData: reposQuery.data, scopedRepo, hidden })
  const { readyRepos, notReadyRepos, shownRepos } = view
  const { state, errorMessage } = backlogPageState(reposQuery, view)
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

  function pick(row: BacklogRowView, planGate: PlanGateChoice): boolean {
    const reasons = workOnReasons(row)
    if (reasons === null) {
      workOn.start(row, planGate)
      return false
    }
    setConfirm({ row, planGate, reasons, open: true })
    return true
  }

  function closeConfirm(): void {
    setConfirm((current) => (current === null ? null : { ...current, open: false }))
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

  const navigatorRef = listNavigatorRef({
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

  const repoFilter =
    scopedRepo === null && readyRepos.length > 1 ? <RepoFilterMenu repos={readyRepos} hidden={hidden} onToggle={(id) => changeHidden(toggleHiddenRepo(hidden, id))} onShowAll={() => changeHidden(new Set())} /> : null

  return (
    <>
      <Page
        ref={navigatorRef}
        onMouseDown={onSurfaceMouseDown}
        header={<BacklogHeader stale={stale} now={now} repoFilter={repoFilter} isFetching={isFetching} onRefresh={refreshAll} />}
        variant="list"
        state={state}
        errorMessage={errorMessage}
        onRetry={() => void reposQuery.refetch()}
        empty={
          <BacklogEmpty
            body={view.body}
            notReadyRepos={notReadyRepos}
            onShowAllRepositories={() => void navigate({ to: ROUTE_IDS.backlog, search: { repo: null } })}
            onOpenRepositories={() => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } })}
            onShowAllHidden={() => changeHidden(new Set())}
          />
        }
        aside={detailRow !== null ? <BacklogDetailPane row={detailRow} epic={detailEpic} now={now} onClose={() => setDetailKey(null)} /> : undefined}
      >
        <div>
          {groups.map((group) => {
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
                    pendingKeys={workOn.pendingKeys}
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
          })}
          <NotReadyLines entries={notReadyRepos} />
        </div>
      </Page>
      {confirm === null ? null : (
        <ConfirmDialog
          {...workOnConfirmSpec(confirm.row.number, confirm.reasons)}
          open={confirm.open}
          onCancel={closeConfirm}
          onConfirm={() => {
            closeConfirm()
            workOn.start(confirm.row, confirm.planGate)
          }}
        />
      )}
    </>
  )
}
