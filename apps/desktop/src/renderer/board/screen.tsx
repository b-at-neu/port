// The Board screen — header, Waiting on you, banners, the remaining
// sections, and the detail pane.
import { useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { LayoutGrid } from 'lucide-react'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { EmptyState } from '@/renderer/components/empty-state'
import { TicketRow } from '@/renderer/components/ticket-row'
import { ipcQueryOptions, observeIpcQuery, useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/app/routes'
import type { BoardItemRef, BoardSearch, BoardView } from '@/types/router'
import { projectBoard } from '@/renderer/board/project'
import type { BoardItemRow } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { listNavigatorRef } from '@/renderer/app/list-navigator'
import { useListSelection } from '@/renderer/app/list-selection'
import { pruneItemActionStates } from '@/renderer/board/actions'
import { BoardBanners } from '@/renderer/board/banners'
import { BoardHeader } from '@/renderer/board/header'
import { ItemPane } from '@/renderer/board/item-pane'
import { Page } from '@/renderer/components/page'
import { pageState } from '@/renderer/components/page-state'
import { BOARD_UNREACHABLE, NO_REPOSITORIES_EMPTY, OPEN_REPOSITORIES_LABEL, SHOW_ALL_REPOSITORIES_LABEL, nothingAssignedEmpty } from '@/renderer/board/copy'
import { boardSections } from '@/renderer/board/sections'
import { boardColumns } from '@/renderer/board/columns'
import { BoardKanban, BoardKanbanSkeleton } from '@/renderer/board/kanban'
import { boardLanes, navigableLaneRows } from '@/renderer/board/lanes'
import { readBoardCollapsedLanes, readBoardView, setBoardLaneCollapsed, setBoardView } from '@/renderer/board/prefs'
import { operatorJoinedOf, rowKey } from '@/renderer/board/row-model'
import type { DispatchRecord } from '@/types/dispatch'

// Registered once from main.ts's boot — never a useEffect inside the
// component.
export function connectItemActionPruning(client: QueryClient): () => void {
  return observeIpcQuery(client, 'board.snapshot', undefined, (result) => {
    if (result.status === 'success') pruneItemActionStates(result.data)
  })
}

// A pull request number still selects its ticket, so an older `?item=` link resolves.
function sameItem(row: BoardItemRow, ref: BoardItemRef): boolean {
  return row.item.repoId === ref.repoId && (row.ticket.ref.number === ref.number || row.ticket.pullRequest?.number === ref.number)
}

export function BoardScreen() {
  const search = useSearch({ from: ROUTE_IDS.board })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const query = useIpcQuery('board.snapshot')
  const sessions = useIpcQuery('session.list')
  const refresh = useActionMutation('board.refresh', {
    onResult: (fresh) => queryClient.setQueryData(ipcQueryOptions('board.snapshot').queryKey, fresh),
  })
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<RepoId>>(() => readBoardCollapsedLanes())
  const now = new Date()

  const snapshot = query.data ?? null

  function setSearch(patch: Partial<BoardSearch>): void {
    void navigate({ to: ROUTE_IDS.board, search: (prev: BoardSearch) => ({ ...prev, ...patch }) })
  }

  function selectRow(row: BoardItemRow | null): void {
    setSearch({ item: row !== null ? { repoId: row.item.repoId, number: row.ticket.ref.number } : null })
  }

  const repo = search.repo ?? null

  const view = search.view ?? readBoardView()
  const kanban = view === 'board'

  const projection = snapshot !== null ? projectBoard({ snapshot, now, sessions: sessions.data ?? [] }) : null
  const gatedRows = projection !== null ? projection.rows.filter((row) => !row.actions.gate.available) : []
  // The list's Ungated banner owns these rows, scoped to `repo` so J/K never reaches another repository's row.
  const ungatedRows = projection !== null && !kanban ? (repo === null ? projection.ungated : projection.ungated.filter((row) => row.item.repoId === repo)) : []
  const sections = projection !== null && !kanban ? boardSections(gatedRows, { repo }) : []
  const sectionRows = sections.flatMap((section) => section.subGroups.flatMap((g) => g.rows))
  const columns = projection !== null && kanban ? boardColumns(gatedRows, projection.ungated, { repo }) : []
  const readyRepos = snapshot !== null ? snapshot.state.repositories.flatMap((r) => (r.ok ? [{ repoId: r.repoId, name: r.displayName }] : [])) : []
  const laned = kanban && repo === null && readyRepos.length > 1
  const lanes = laned && projection !== null ? boardLanes(gatedRows, projection.ungated, readyRepos) : null
  // Every card, collapsed lanes included — a `?item=` into a collapsed lane still opens the pane.
  const allRows = kanban ? columns.flatMap((column) => column.cards.map((card) => card.row)) : projection !== null ? [...ungatedRows, ...sectionRows] : []
  const flatRows = lanes !== null ? navigableLaneRows(lanes, collapsedLanes) : allRows

  // An item that no longer matches any row closes the pane silently.
  const itemRef = search.item ?? null
  const selectedRow = itemRef !== null ? (allRows.find((row) => sameItem(row, itemRef)) ?? null) : null

  function toggleLane(repoId: RepoId): void {
    const collapsing = !collapsedLanes.has(repoId)
    setCollapsedLanes((prev) => {
      const next = new Set(prev)
      if (collapsing) next.add(repoId)
      else next.delete(repoId)
      return next
    })
    setBoardLaneCollapsed(repoId, collapsing)
    if (collapsing && selectedRow !== null && selectedRow.item.repoId === repoId) selectRow(null)
  }

  const selection = useListSelection(flatRows.map(rowKey), {
    value: selectedRow !== null ? rowKey(selectedRow) : null,
    onChange: (key) => selectRow(key !== null ? (flatRows.find((row) => rowKey(row) === key) ?? null) : null),
  })

  const navigatorRef = listNavigatorRef({
    next: () => selection.next(),
    prev: () => selection.prev(),
    // J/K already opens the pane on every move (above); Enter on an
    // already-selected row has nothing further to do.
    open: () => undefined,
    close: () => {
      if (selectedRow !== null) selectRow(null)
    },
  })

  const report = selectedRow !== null && snapshot !== null ? snapshot.tick.find((r) => r.repoId === selectedRow.item.repoId) : undefined
  const owner = selectedRow !== null && snapshot !== null ? (snapshot.dispatch.find((d) => d.repoId === selectedRow.item.repoId)?.owner ?? 'none') : 'none'

  function recordsFor(repoId: RepoId): readonly DispatchRecord[] {
    const status = snapshot?.dispatch.find((d) => d.repoId === repoId)
    return status !== undefined && status.state.kind === 'active' ? status.state.recent : []
  }

  const waitingSection = sections.find((section) => section.key === 'waiting-on-you')
  const otherSections = sections.filter((section) => section.key !== 'waiting-on-you')

  function renderSection(section: (typeof sections)[number]) {
    return (
      <div key={section.key}>
        <div className="bg-sidebar px-4 py-1 text-small font-medium text-foreground-secondary">
          {section.name} · {section.count}
        </div>
        {section.subGroups.map((group) => (
          <div key={group.key}>
            <div className="px-4 py-0.5 text-meta text-muted-foreground">{group.name}</div>
            {group.rows.map((row) => (
              <TicketRow key={rowKey(row)} row={row} rowProps={selection.rowProps(rowKey(row))} operatorJoined={operatorJoinedOf(recordsFor(row.item.repoId), row)} />
            ))}
          </div>
        ))}
      </div>
    )
  }

  const noRepositories = snapshot !== null && snapshot.state.repositories.length === 0
  const banners = snapshot !== null && projection !== null ? <BoardBanners snapshot={snapshot} projection={projection} ungated={ungatedRows} selection={selection} /> : null

  const empty = (
    <>
      {banners}
      {noRepositories ? (
        <EmptyState
          icon={LayoutGrid}
          message={NO_REPOSITORIES_EMPTY}
          action={{ label: OPEN_REPOSITORIES_LABEL, onClick: () => void navigate({ to: ROUTE_IDS.settings, search: { section: 'repositories' } }) }}
          className="px-4 py-6"
        />
      ) : (
        <EmptyState
          icon={LayoutGrid}
          message={nothingAssignedEmpty(repo !== null)}
          action={repo !== null ? { label: SHOW_ALL_REPOSITORIES_LABEL, onClick: () => setSearch({ repo: null }) } : undefined}
          className="px-4 py-6"
        />
      )}
    </>
  )

  return (
    <Page
      ref={navigatorRef}
      onMouseDown={selection.surfaceProps().onMouseDown}
      header={
        <BoardHeader
          snapshot={snapshot}
          now={now}
          refreshing={refresh.pending}
          onRefresh={() => refresh.request({})}
          repo={repo}
          onRepoChange={(nextRepo: RepoId | null) => setSearch({ repo: nextRepo })}
          view={view}
          onViewChange={(nextView: BoardView) => {
            setSearch({ view: nextView })
            setBoardView(nextView)
          }}
        />
      }
      variant="list"
      bodyClassName={kanban ? 'flex flex-col overflow-hidden' : undefined}
      state={pageState({ data: snapshot ?? undefined, status: query.status }, () => noRepositories || allRows.length === 0)}
      loading={kanban ? <BoardKanbanSkeleton /> : undefined}
      errorMessage={BOARD_UNREACHABLE}
      onRetry={() => void query.refetch()}
      empty={empty}
      aside={selectedRow !== null ? <ItemPane row={selectedRow} report={report} owner={owner} onClose={() => selectRow(null)} /> : undefined}
    >
      <div className={kanban ? 'flex min-h-0 flex-1 flex-col' : undefined}>
        {waitingSection !== undefined ? renderSection(waitingSection) : null}
        {banners}
        {kanban ? <BoardKanban columns={columns} lanes={lanes} collapsed={collapsedLanes} onToggleLane={toggleLane} selection={selection} /> : otherSections.map(renderSection)}
      </div>
    </Page>
  )
}
