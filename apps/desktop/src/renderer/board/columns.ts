// The Board's kanban projection — each ticket lands in exactly one of six columns.
import { columnName } from '@/renderer/board/copy'
import { PIPELINE_ORDER } from '@/renderer/board/sections'
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

const STAGE_COLUMN: Readonly<Record<string, BoardColumnKey>> = {
  approved: 'needs-you',
  needsHuman: 'needs-you',
  refreshBranch: 'needs-you',
  refreshing: 'needs-you',
  ready: 'queued',
  planChangesRequested: 'plan',
  planning: 'plan',
  planReview: 'plan',
  planApproved: 'implement',
  inProgress: 'implement',
  readyForReview: 'review',
  reviewing: 'review',
  needsRevision: 'revise',
  revising: 'revise',
}

function columnOf(row: BoardItemRow): BoardColumnKey {
  const key = row.stageLabel?.key
  const column = key !== undefined ? STAGE_COLUMN[key] : undefined
  if (column === 'needs-you') return column
  if (row.blockedOn !== null) return 'queued'
  return column ?? 'queued'
}

function pipelineRank(row: BoardItemRow): number {
  const rank = PIPELINE_ORDER.indexOf(row.stageLabel?.key ?? '')
  return rank === -1 ? PIPELINE_ORDER.length : rank
}

export function boardColumns(rows: readonly BoardItemRow[], ungated: readonly BoardItemRow[], params: BoardColumnsParams): readonly BoardColumn[] {
  const inRepo = (row: BoardItemRow): boolean => params.repo === null || row.item.repoId === params.repo
  const byColumn = new Map<BoardColumnKey, BoardColumnCard[]>(COLUMN_KEYS.map((key) => [key, []]))

  for (const row of ungated.filter(inRepo)) byColumn.get('needs-you')?.push({ row, ungated: true })
  const ordered = rows
    .filter(inRepo)
    .map((row, index) => ({ row, index }))
    .sort((a, b) => pipelineRank(a.row) - pipelineRank(b.row) || a.index - b.index)
  for (const { row } of ordered) byColumn.get(columnOf(row))?.push({ row, ungated: false })

  return COLUMN_KEYS.map((key): BoardColumn => ({ key, name: columnName(key), tone: { palette: COLUMN_PALETTE[key], fill: 'active', pulse: false }, cards: byColumn.get(key) ?? [] }))
}
