// The Board's read-only kanban — six columns, each a header and a stack of cards.
import { PhaseDot } from '@/renderer/components/phase-dot'
import { PHASE_RULE_CLASS } from '@/renderer/components/phase-classes'
import { TicketCard } from '@/renderer/components/ticket-card'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { cn } from '@/renderer/lib/utils'
import { emptyColumnLabel } from '@/renderer/board/copy'
import { rowKey } from '@/renderer/board/row-model'
import type { BoardColumn } from '@/types/board'
import type { useListSelection } from '@/renderer/shell/list-selection'

const COLUMN_CLASS = 'flex min-w-60 flex-1 flex-col gap-2'

interface BoardKanbanProps {
  readonly columns: readonly BoardColumn[]
  readonly selection: ReturnType<typeof useListSelection>
  readonly showRepo: boolean
}

export function BoardKanban({ columns, selection, showRepo }: BoardKanbanProps) {
  return (
    <div className="flex gap-4 overflow-x-auto p-4">
      {columns.map((column) => (
        <section key={column.key} aria-label={column.name} className={COLUMN_CLASS}>
          <h3 className={cn('flex h-8 items-center gap-2 bg-background text-small font-medium text-foreground-secondary', PHASE_RULE_CLASS[column.tone.palette])}>
            <PhaseDot tone={column.tone} />
            <span>{column.name}</span>
            <span className="tabular-nums">· {column.cards.length}</span>
          </h3>
          <div className="flex flex-col gap-2">
            {column.cards.length === 0 ? (
              <span className="text-meta text-muted-foreground">{emptyColumnLabel()}</span>
            ) : (
              column.cards.map((card) => <TicketCard key={rowKey(card.row)} row={card.row} ungated={card.ungated} showRepo={showRepo} rowProps={selection.rowProps(rowKey(card.row))} />)
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

export function BoardKanbanSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto p-4">
      {Array.from({ length: 6 }, (_, column) => (
        <div key={column} className={COLUMN_CLASS}>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  )
}
