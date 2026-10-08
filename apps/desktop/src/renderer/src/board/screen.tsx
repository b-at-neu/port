// The Board screen — header, pipeline status, banners, the three-section
// list, and the detail pane.
import { useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { LayoutGrid } from 'lucide-react'
import { EmptyState } from '../components/empty-state'
import { TicketRow } from '../components/ticket-row'
import { Skeleton } from '@/components/ui/skeleton'
import { ipcQueryOptions, observeIpcQuery, useIpcQuery } from '../data/query'
import { invoke } from '../data/invoke'
import { ROUTE_IDS } from '../router/routes'
import type { BoardItemRef, BoardSearch } from '../router/routes'
import { projectBoard } from '../../../shared/board/project'
import type { BoardItemRow } from '../../../shared/board/types'
import type { RepoId } from '../../../shared/repos'
import { registerListNavigator } from '../shell/stores'
import { pruneItemActionStates } from './actions'
import { BoardBanners } from './banners'
import { BoardHeader } from './header'
import { ItemPane } from './item-pane'
import { PipelineStatus } from './pipeline-status'
import { boardSections } from './sections'
import type { BoardGroupBy } from './sections'

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
  const sections = projection !== null ? boardSections(projection.rows, { group, repo }) : []
  const flatRows = sections.flatMap((section) => section.subGroups.flatMap((g) => g.rows))

  // An item that no longer matches any row closes the pane silently.
  const itemRef = search.item ?? null
  const selectedRow = itemRef !== null ? (flatRows.find((row) => sameItem(row, itemRef)) ?? null) : null

  registerListNavigator('board', {
    next: () => {
      if (flatRows.length === 0) return
      const index = selectedRow !== null ? flatRows.findIndex((row) => row === selectedRow) : -1
      const nextRow = flatRows[Math.min(index + 1, flatRows.length - 1)]
      if (nextRow !== undefined) selectRow(nextRow)
    },
    prev: () => {
      if (flatRows.length === 0) return
      const index = selectedRow !== null ? flatRows.findIndex((row) => row === selectedRow) : 0
      const prevRow = flatRows[Math.max(index - 1, 0)]
      if (prevRow !== undefined) selectRow(prevRow)
    },
    // J/K already opens the pane on every move (below); Enter on an
    // already-selected row has nothing further to do.
    open: () => undefined,
  })

  const report = selectedRow !== null && snapshot !== null ? snapshot.tick.find((r) => r.repoId === selectedRow.item.repoId) : undefined
  const owner = selectedRow !== null && snapshot !== null ? (snapshot.dispatch.find((d) => d.repoId === selectedRow.item.repoId)?.owner ?? 'cockpit') : 'cockpit'

  return (
    <div className="flex h-full flex-col">
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
      {snapshot !== null ? <PipelineStatus snapshot={snapshot} now={now} /> : null}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {snapshot === null ? (
            <div className="flex flex-col gap-1 px-4 py-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : projection !== null ? (
            <>
              <BoardBanners snapshot={snapshot} projection={projection} now={now} onSelectRow={selectRow} />
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
                          <TicketRow key={rowKey(row)} row={row} selected={row === selectedRow} onSelect={() => selectRow(row)} />
                        ))}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </>
          ) : null}
        </div>
        {selectedRow !== null ? <ItemPane row={selectedRow} report={report} owner={owner} onClose={() => selectRow(null)} /> : null}
      </div>
    </div>
  )
}
