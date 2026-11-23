// The Board's four-section split — Waiting on you, In progress, Blocked, Queued —
// each broken into phase sub-groups.
import { ticketViewOf } from '@/renderer/lib/ticket-view'
import type { BoardItemRow, BoardSectionKey } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { sectionOf, stageGroupOf, stageNameOf } from '@/utils/pipeline/stages'

interface BoardSubGroup {
  readonly key: string
  readonly name: string
  readonly rows: readonly BoardItemRow[]
}

interface BoardSection {
  readonly key: BoardSectionKey
  readonly name: string
  readonly count: number
  readonly subGroups: readonly BoardSubGroup[]
}

interface BoardSectionsParams {
  // null means every repository.
  readonly repo: RepoId | null
}

const SECTION_NAMES: Readonly<Record<BoardSectionKey, string>> = {
  'waiting-on-you': 'Waiting on you',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  queued: 'Queued',
}

function rowSectionOf(row: BoardItemRow): BoardSectionKey {
  const { status } = row.displayStatus
  return sectionOf(ticketViewOf(row.item), { autoApproving: row.autoApproving, blocked: row.blockedOn !== null, working: status === 'in-flight' || status === 'stalled' })
}

function subGroupsOf(rows: readonly BoardItemRow[]): readonly BoardSubGroup[] {
  const groups = new Map<string, { readonly rank: number; readonly name: string; readonly rows: BoardItemRow[] }>()
  for (const row of rows) {
    const view = ticketViewOf(row.item)
    const { key, rank } = stageGroupOf(view)
    const group = groups.get(key) ?? { rank, name: stageNameOf(view), rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.entries()].sort(([, a], [, b]) => a.rank - b.rank).map(([key, group]) => ({ key, name: group.name, rows: group.rows }))
}

export function boardSections(rows: readonly BoardItemRow[], params: BoardSectionsParams): readonly BoardSection[] {
  const filtered = params.repo === null ? rows : rows.filter((row) => row.item.repoId === params.repo)

  const bySection = new Map<BoardSectionKey, BoardItemRow[]>([
    ['waiting-on-you', []],
    ['in-progress', []],
    ['blocked', []],
    ['queued', []],
  ])
  for (const row of filtered) {
    bySection.get(rowSectionOf(row))?.push(row)
  }

  const order: readonly BoardSectionKey[] = ['waiting-on-you', 'in-progress', 'blocked', 'queued']
  return order
    .map((key): BoardSection => {
      const sectionRows = bySection.get(key) ?? []
      return { key, name: SECTION_NAMES[key], count: sectionRows.length, subGroups: subGroupsOf(sectionRows) }
    })
    .filter((section) => section.count > 0)
}
