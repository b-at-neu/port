// The Board screen — header, pipeline status, banners, the three-section
// list, and the detail pane.
import { useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { LayoutGrid } from 'lucide-react'
import { EmptyState } from '@/renderer/components/empty-state'
import { TicketRow } from '@/renderer/components/ticket-row'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { ipcQueryOptions, observeIpcQuery, useIpcQuery } from '@/renderer/data/query'
import { invoke } from '@/renderer/data/invoke'
import { ROUTE_IDS } from '@/renderer/router/routes'
import type { BoardItemRef, BoardSearch } from '@/types/router'
import { projectBoard } from '@/renderer/board/project'
import type { BoardItemRow } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { registerListNavigator } from '@/renderer/shell/stores'
import { useListSelection } from '@/renderer/shell/list-selection'
import { pruneItemActionStates } from '@/renderer/board/actions'
import { BoardBanners } from '@/renderer/board/banners'
import { BoardHeader } from '@/renderer/board/header'
import { ItemPane } from '@/renderer/board/item-pane'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { PipelineStatus } from '@/renderer/board/pipeline-status'
import { boardSections } from '@/renderer/board/sections'
import type { BoardGroupBy } from '@/types/board'
import { operatorJoinedOf } from '@/renderer/board/row-model'
import type { DispatchRecord } from '@/types/dispatch'

// Registered once from main.ts's boot — never a useEffect inside the
// component.
export function connectItemActionPruning(client: QueryClient): () => void {
  return observeIpcQuery(client, 'board:snapshot', undefined, (result) => {
    if (result.status === 'success') pruneItemActionStates(result.data)
  })
}

function rowKey(row: BoardItemRow): string {
  return `${row.item.repoId}:${String(row.item.number)}`
}

function sameItem(row: BoardItemRow, ref: BoardItemRef): boolean {
  return row.item.repoId === ref.repoId && row.item.number === ref.number
}

export function BoardScreen() {
  const search = useSearch({ from: ROUTE_IDS.board })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const query = useIpcQuery('board:snapshot')
  const [refreshing, setRefreshing] = useState(false)
  const now = new Date()

  const snapshot = query.data ?? null

  function setSearch(patch: Partial<BoardSearch>): void {
    void navigate({ to: ROUTE_IDS.board, search: (prev: BoardSearch) => ({ ...prev, ...patch }) })
  }

  function selectRow(row: BoardItemRow | null): void {
    setSearch({ item: row !== null ? { repoId: row.item.repoId, number: row.item.number } : null })
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      const fresh = await invoke('board:refresh', {})
      queryClient.setQueryData(ipcQueryOptions('board:snapshot').queryKey, fresh)
    } catch (error) {
      console.error('Failed to refresh the board', error)
    }
    setRefreshing(false)
  }

  const group: BoardGroupBy = search.group === 'repo' ? 'repo' : 'phase'
  const repo = search.repo ?? null

  const projection = snapshot !== null ? projectBoard({ snapshot, groupBy: group === 'repo' ? 'repo' : 'stage', now }) : null
  // Ungated rows are the banner's alone — excluded here so a row is never
  // mounted twice, and placed first in `flatRows` to match the banner above.
  const sections = projection !== null ? boardSections(projection.rows.filter((row) => !row.actions.gate.available), { group, repo }) : []
  const sectionRows = sections.flatMap((section) => section.subGroups.flatMap((g) => g.rows))
  const flatRows = projection !== null ? [...projection.ungated, ...sectionRows] : []

  // An item that no longer matches any row closes the pane silently.
  const itemRef = search.item ?? null
  const selectedRow = itemRef !== null ? (flatRows.find((row) => sameItem(row, itemRef)) ?? null) : null

  const selection = useListSelection(flatRows.map(rowKey), {
    value: selectedRow !== null ? rowKey(selectedRow) : null,
    onChange: (key) => selectRow(key !== null ? (flatRows.find((row) => rowKey(row) === key) ?? null) : null),
  })

  registerListNavigator('board', {
    next: () => selection.next(),
    prev: () => selection.prev(),
    // J/K already opens the pane on every move (above); Enter on an
    // already-selected row has nothing further to do.
    open: () => undefined,
  })

  const report = selectedRow !== null && snapshot !== null ? snapshot.tick.find((r) => r.repoId === selectedRow.item.repoId) : undefined
  const owner = selectedRow !== null && snapshot !== null ? (snapshot.dispatch.find((d) => d.repoId === selectedRow.item.repoId)?.owner ?? 'none') : 'none'

  function recordsFor(repoId: RepoId): readonly DispatchRecord[] {
    const status = snapshot?.dispatch.find((d) => d.repoId === repoId)
    return status !== undefined && status.state.kind === 'active' ? status.state.recent : []
  }

  return (
    <Screen
      header={
        <BoardHeader
          snapshot={snapshot}
          now={now}
          refreshing={refreshing}
          onRefresh={() => void handleRefresh()}
          group={group}
          onGroupChange={(nextGroup: BoardGroupBy) => setSearch({ group: nextGroup })}
          repo={repo}
          onRepoChange={(nextRepo: RepoId | null) => setSearch({ repo: nextRepo })}
        />
      }
    >
      {snapshot !== null ? <PipelineStatus snapshot={snapshot} now={now} /> : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ScreenBody variant="list" className="flex-1">
          <div>
            {snapshot === null ? (
              <div className="flex flex-col gap-1 px-4 py-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : projection !== null ? (
              <>
                <BoardBanners projection={projection} selection={selection} />
                {snapshot.state.repositories.length === 0 ? (
                  <EmptyState icon={LayoutGrid} message="Add a repository to see its pipeline." action={{ label: 'Open Repositories', onClick: () => void navigate({ to: ROUTE_IDS.repos }) }} className="px-4 py-6" />
                ) : sections.length === 0 ? (
                  <EmptyState
                    icon={LayoutGrid}
                    message={repo !== null ? "Nothing in this repository's pipeline." : 'Nothing in the pipeline.'}
                    action={repo !== null ? { label: 'Show all repositories', onClick: () => setSearch({ repo: null }) } : undefined}
                    className="px-4 py-6"
                  />
                ) : (
                  sections.map((section) => (
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
                  ))
                )}
              </>
            ) : null}
          </div>
        </ScreenBody>
        {selectedRow !== null ? <ItemPane row={selectedRow} report={report} owner={owner} records={recordsFor(selectedRow.item.repoId)} onClose={() => selectRow(null)} /> : null}
      </div>
    </Screen>
  )
}
