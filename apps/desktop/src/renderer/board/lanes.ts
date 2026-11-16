// The Board's swimlanes — one `boardColumns` projection per repository, never a second column rule.
import { boardColumns } from '@/renderer/board/columns'
import type { BoardItemRow, BoardLane } from '@/types/board'
import type { RepoId } from '@/utils/repos'

interface LaneRepo {
  readonly repoId: RepoId
  readonly name: string
}

export function boardLanes(rows: readonly BoardItemRow[], ungated: readonly BoardItemRow[], repos: readonly LaneRepo[]): readonly BoardLane[] {
  return repos.map(({ repoId, name }): BoardLane => {
    const columns = boardColumns(rows, ungated, { repo: repoId })
    return { repoId, name, count: columns.reduce((sum, column) => sum + column.cards.length, 0), columns }
  })
}

/** The J/K order: lane by lane, column by column within a lane, skipping collapsed lanes. */
export function navigableLaneRows(lanes: readonly BoardLane[], collapsed: ReadonlySet<RepoId>): readonly BoardItemRow[] {
  return lanes.filter((lane) => !collapsed.has(lane.repoId)).flatMap((lane) => lane.columns.flatMap((column) => column.cards.map((card) => card.row)))
}
