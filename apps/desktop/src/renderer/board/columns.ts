// The Board's kanban projection — each ticket lands in exactly one of six columns.
import { columnName } from '@/renderer/board/copy'
import { ticketViewOfItem } from '@/utils/pipeline/stages'
import { columnOf, stageGroupOf } from '@/utils/pipeline/stages'
import type { BoardColumn, BoardColumnCard, BoardColumnKey, BoardItemRow } from '@/types/board'
import type { PhaseTone } from '@/types/components'
import type { RepoId } from '@/utils/repos'

interface BoardColumnsParams {
  // null means every repository.
  readonly repo: RepoId | null
}

const COLUMN_KEYS: readonly BoardColumnKey[] = ['queued', 'plan', 'implement', 'review', 'revise', 'needs-you']

const COLUMN_PALETTE: Readonly<Record<BoardColumnKey, PhaseTone['palette']>> = {
  queued: 'unstaged',
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  revise: 'revise',
  'needs-you': 'needs-you',
}

function cardColumnOf(row: BoardItemRow): BoardColumnKey {
  return columnOf(ticketViewOfItem(row.item), { autoApproving: row.autoApproving, blocked: row.blockedOn !== null })
}

function pipelineRank(row: BoardItemRow): number {
  return stageGroupOf(ticketViewOfItem(row.item)).rank
}

export function boardColumns(rows: readonly BoardItemRow[], ungated: readonly BoardItemRow[], params: BoardColumnsParams): readonly BoardColumn[] {
  const inRepo = (row: BoardItemRow): boolean => params.repo === null || row.item.repoId === params.repo
  const byColumn = new Map<BoardColumnKey, BoardColumnCard[]>(COLUMN_KEYS.map((key) => [key, []]))

  for (const row of ungated.filter(inRepo)) byColumn.get('needs-you')?.push({ row, ungated: true })
  const ordered = rows
    .filter(inRepo)
    .map((row, index) => ({ row, index }))
    .sort((a, b) => pipelineRank(a.row) - pipelineRank(b.row) || a.index - b.index)
  for (const { row } of ordered) byColumn.get(cardColumnOf(row))?.push({ row, ungated: false })

  return COLUMN_KEYS.map((key): BoardColumn => ({ key, name: columnName(key), tone: { palette: COLUMN_PALETTE[key], fill: 'active', pulse: false }, cards: byColumn.get(key) ?? [] }))
}
