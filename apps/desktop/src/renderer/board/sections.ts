// The Board's four-section split — Waiting on you, In progress, Blocked, Queued —
// each broken into phase sub-groups.
import { waitsOnYou } from '@/renderer/board/needs-you'
import type { BoardItemRow } from '@/types/board'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import type { RepoId } from '@/utils/repos'
import { PHASE_NAMES } from '@/renderer/lib/phase'

interface BoardSubGroup {
  readonly key: string
  readonly name: string
  readonly rows: readonly BoardItemRow[]
}

type BoardSectionKey = 'waiting-on-you' | 'in-progress' | 'blocked' | 'queued'

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

function sectionOf(row: BoardItemRow): BoardSectionKey {
  if (waitsOnYou(row)) return 'waiting-on-you'
  if (row.blockedOn !== null) return 'blocked'
  if (row.autoApproving) return 'in-progress'
  if (row.displayStatus.status === 'in-flight' || row.displayStatus.status === 'stalled') return 'in-progress'
  return 'queued'
}

// LABEL_DEFAULTS' own order, names read straight from PHASE_NAMES.
export const PIPELINE_ORDER: readonly string[] = LABEL_DEFAULTS.filter((def) => def.role !== 'marker' && PHASE_NAMES[def.key] !== null).map((def) => def.key)
const UNSTAGED_KEY = 'unstaged'

function phaseGroupKey(row: BoardItemRow): string {
  const key = row.stageLabel?.key
  return key !== undefined && PHASE_NAMES[key] !== null ? key : UNSTAGED_KEY
}

function phaseGroupName(key: string): string {
  if (key === UNSTAGED_KEY) return 'Unstaged'
  return PHASE_NAMES[key as keyof typeof PHASE_NAMES] ?? key
}

function subGroupsOf(rows: readonly BoardItemRow[]): readonly BoardSubGroup[] {
  return [...PIPELINE_ORDER, UNSTAGED_KEY]
    .map((key): BoardSubGroup => ({ key, name: phaseGroupName(key), rows: rows.filter((row) => phaseGroupKey(row) === key) }))
    .filter((subGroup) => subGroup.rows.length > 0)
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
    bySection.get(sectionOf(row))?.push(row)
  }

  const order: readonly BoardSectionKey[] = ['waiting-on-you', 'in-progress', 'blocked', 'queued']
  return order
    .map((key): BoardSection => {
      const sectionRows = bySection.get(key) ?? []
      return { key, name: SECTION_NAMES[key], count: sectionRows.length, subGroups: subGroupsOf(sectionRows) }
    })
    .filter((section) => section.count > 0)
}
