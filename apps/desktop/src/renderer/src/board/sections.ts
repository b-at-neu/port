// The Board's three-section split — Waiting on you, In progress, Queued —
// each optionally broken into phase or repo sub-groups.
import { needsYouReasonOf } from '../../../shared/board/needs-you'
import type { BoardItemRow } from '../../../shared/board/types'
import { LABEL_DEFAULTS } from '../../../shared/labels/defaults'
import type { RepoId } from '../../../shared/repos'
import { PHASE_NAMES } from '../lib/phase'

export type BoardGroupBy = 'phase' | 'repo'

export interface BoardSubGroup {
  readonly key: string
  readonly name: string
  readonly rows: readonly BoardItemRow[]
}

export type BoardSectionKey = 'waiting-on-you' | 'in-progress' | 'queued'

export interface BoardSection {
  readonly key: BoardSectionKey
  readonly name: string
  readonly count: number
  readonly subGroups: readonly BoardSubGroup[]
}

export interface BoardSectionsParams {
  readonly group: BoardGroupBy
  // null means every repository.
  readonly repo: RepoId | null
}

const SECTION_NAMES: Readonly<Record<BoardSectionKey, string>> = {
  'waiting-on-you': 'Waiting on you',
  'in-progress': 'In progress',
  queued: 'Queued',
}

// First hit wins: a relay-pending row reads as Waiting on you even if
// otherwise in-flight.
function sectionOf(row: BoardItemRow): BoardSectionKey {
  if (needsYouReasonOf(row.stageLabel?.key) !== undefined || row.relay !== null) return 'waiting-on-you'
  if (row.displayStatus.status === 'in-flight' || row.displayStatus.status === 'stalled') return 'in-progress'
  return 'queued'
}

// LABEL_DEFAULTS' own order, names read straight from PHASE_NAMES.
const PIPELINE_ORDER: readonly string[] = LABEL_DEFAULTS.filter((def) => def.role !== 'marker' && PHASE_NAMES[def.key] !== null).map((def) => def.key)
const UNSTAGED_KEY = 'unstaged'

function phaseGroupKey(row: BoardItemRow): string {
  const key = row.stageLabel?.key
  return key !== undefined && PHASE_NAMES[key] !== null ? key : UNSTAGED_KEY
}

function phaseGroupName(key: string): string {
  if (key === UNSTAGED_KEY) return 'Unstaged'
  return PHASE_NAMES[key as keyof typeof PHASE_NAMES] ?? key
}

function repoGroupKey(row: BoardItemRow): string {
  return row.item.repoId
}

function repoGroupName(row: BoardItemRow): string {
  return row.item.repo
}

// Orders by first appearance — rows already sort by repo display name.
function repoSubGroupsOf(rows: readonly BoardItemRow[]): readonly BoardSubGroup[] {
  const order: string[] = []
  const byKey = new Map<string, BoardItemRow[]>()
  for (const row of rows) {
    const key = repoGroupKey(row)
    const group = byKey.get(key)
    if (group === undefined) {
      byKey.set(key, [row])
      order.push(key)
    } else {
      group.push(row)
    }
  }
  return order.map((key): BoardSubGroup => {
    const groupRows = byKey.get(key) ?? []
    return { key, name: groupRows[0] !== undefined ? repoGroupName(groupRows[0]) : key, rows: groupRows }
  })
}

function subGroupsOf(rows: readonly BoardItemRow[], group: BoardGroupBy): readonly BoardSubGroup[] {
  if (group === 'repo') return repoSubGroupsOf(rows)
  return [...PIPELINE_ORDER, UNSTAGED_KEY]
    .map((key): BoardSubGroup => ({ key, name: phaseGroupName(key), rows: rows.filter((row) => phaseGroupKey(row) === key) }))
    .filter((subGroup) => subGroup.rows.length > 0)
}

export function boardSections(rows: readonly BoardItemRow[], params: BoardSectionsParams): readonly BoardSection[] {
  const filtered = params.repo === null ? rows : rows.filter((row) => row.item.repoId === params.repo)

  const bySection = new Map<BoardSectionKey, BoardItemRow[]>([
    ['waiting-on-you', []],
    ['in-progress', []],
    ['queued', []],
  ])
  for (const row of filtered) {
    bySection.get(sectionOf(row))?.push(row)
  }

  const order: readonly BoardSectionKey[] = ['waiting-on-you', 'in-progress', 'queued']
  return order
    .map((key): BoardSection => {
      const sectionRows = bySection.get(key) ?? []
      return { key, name: SECTION_NAMES[key], count: sectionRows.length, subGroups: subGroupsOf(sectionRows, params.group) }
    })
    .filter((section) => section.count > 0)
}
