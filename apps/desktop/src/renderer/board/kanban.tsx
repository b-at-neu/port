// The Board's read-only kanban — pinned column headers over one grid, or one collapsible swimlane per repository.
import { PhaseDot } from '@/renderer/components/phase-dot'
import { PHASE_RULE_CLASS } from '@/renderer/components/phase-classes'
import { CollapsibleGroupHeader } from '@/renderer/components/collapsible-group-header'
import { TicketCard } from '@/renderer/components/ticket-card'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { cn } from '@/renderer/lib/utils'
import { emptyColumnLabel, laneToggleAria } from '@/renderer/board/copy'
import { rowKey } from '@/renderer/board/row-model'
import type { BoardColumn, BoardLane } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import type { useListSelection } from '@/renderer/shell/list-selection'

const GRID_CLASS = 'grid grid-cols-[repeat(6,minmax(15rem,1fr))] gap-4'
const ROOT_CLASS = 'min-h-0 flex-1 overflow-auto'
const HEADER_ROW_CLASS = `sticky top-0 z-10 bg-background px-4 pt-4 ${GRID_CLASS}`

interface BoardKanbanProps {
  readonly columns: readonly BoardColumn[]
  readonly lanes: readonly BoardLane[] | null
  readonly collapsed: ReadonlySet<RepoId>
  readonly onToggleLane: (repoId: RepoId) => void
  readonly selection: ReturnType<typeof useListSelection>
}

function ColumnHeaders({ columns }: { readonly columns: readonly BoardColumn[] }) {
  return (
    <div className={HEADER_ROW_CLASS}>
      {columns.map((column) => (
        <h3 key={column.key} className={cn('flex h-8 items-center gap-2 text-small font-medium text-foreground-secondary', PHASE_RULE_CLASS[column.tone.palette])}>
          <PhaseDot tone={column.tone} />
          <span>{column.name}</span>
          <span className="tabular-nums">· {column.cards.length}</span>
        </h3>
      ))}
    </div>
  )
}

function ColumnCells({ columns, selection, emptyLabel }: { readonly columns: readonly BoardColumn[]; readonly selection: BoardKanbanProps['selection']; readonly emptyLabel: (index: number) => boolean }) {
  return (
    <>
      {columns.map((column, index) => (
        <section key={column.key} aria-label={column.name} className="flex flex-col gap-2">
          {column.cards.length === 0 && emptyLabel(index) ? <span className="text-meta text-muted-foreground">{emptyColumnLabel()}</span> : null}
          {column.cards.map((card) => (
            <TicketCard key={rowKey(card.row)} row={card.row} ungated={card.ungated} rowProps={selection.rowProps(rowKey(card.row))} />
          ))}
        </section>
      ))}
    </>
  )
}

function Lane({ lane, collapsed, onToggle, selection }: { readonly lane: BoardLane; readonly collapsed: boolean; readonly onToggle: () => void; readonly selection: BoardKanbanProps['selection'] }) {
  return (
    <section data-slot="board-lane" data-repo={lane.repoId} data-collapsed={collapsed} aria-label={lane.name}>
      <CollapsibleGroupHeader label={`${lane.name} · ${lane.count}`} collapsed={collapsed} onToggle={onToggle} toggleLabel={laneToggleAria(lane.name, collapsed)} toggleSlot="board-lane-toggle" />
      {collapsed ? null : (
        <div className={cn('px-4 py-2', GRID_CLASS)}>
          <ColumnCells columns={lane.columns} selection={selection} emptyLabel={(index) => lane.count === 0 && index === 0} />
        </div>
      )}
    </section>
  )
}

export function BoardKanban({ columns, lanes, collapsed, onToggleLane, selection }: BoardKanbanProps) {
  return (
    <div data-slot="board-kanban" className={ROOT_CLASS}>
      <div className="min-w-fit">
        <ColumnHeaders columns={columns} />
        {lanes === null ? (
          <div className={cn('px-4 py-2', GRID_CLASS)}>
            <ColumnCells columns={columns} selection={selection} emptyLabel={() => true} />
          </div>
        ) : (
          lanes.map((lane) => <Lane key={lane.repoId} lane={lane} collapsed={collapsed.has(lane.repoId)} onToggle={() => onToggleLane(lane.repoId)} selection={selection} />)
        )}
      </div>
    </div>
  )
}

export function BoardKanbanSkeleton() {
  return (
    <div data-slot="board-kanban" className={ROOT_CLASS}>
      <div className={HEADER_ROW_CLASS}>
        {Array.from({ length: 6 }, (_, column) => (
          <Skeleton key={column} className="h-8 w-full" />
        ))}
      </div>
      <div className={cn('px-4 py-2', GRID_CLASS)}>
        {Array.from({ length: 6 }, (_, column) => (
          <div key={column} className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
