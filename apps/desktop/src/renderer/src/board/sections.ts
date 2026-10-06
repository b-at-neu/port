// The Board's own three-section split (#319, plan's own **UX states**) —
// Waiting on you, In progress, Queued, in that fixed order, each optionally
// broken into phase or repo sub-groups. Pure over an already-projected row
// list; no DOM, no IPC.
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
  /** `null` means every repository — the segmented control's own "All
   *  repositories" entry. Applied before anything below, so an empty result
   *  after filtering renders the filter's own empty state, never the
   *  no-repos-at-all one. */
  readonly repo: RepoId | null
}

const SECTION_NAMES: Readonly<Record<BoardSectionKey, string>> = {
  'waiting-on-you': 'Waiting on you',
  'in-progress': 'In progress',
  queued: 'Queued',
}

/** First hit wins, in the plan's own fixed order — a relay-pending row that
 *  is also `in-flight` reads as Waiting on you, never In progress, since a
 *  question blocks progress regardless of what the underlying agent's own
 *  status says. */
function sectionOf(row: BoardItemRow): BoardSectionKey {
  if (needsYouReasonOf(row.stageLabel?.key) !== undefined || row.relay !== null) return 'waiting-on-you'
  if (row.displayStatus.status === 'in-flight' || row.displayStatus.status === 'stalled') return 'in-progress'
  return 'queued'
}

/** "Phase" pipeline order — `LABEL_DEFAULTS`' own order, the same sequence
 *  the legacy stage grouping used, with its display name read straight from
 *  `PHASE_NAMES` (never a second copy table). An unstaged row (`stageLabel`
 *  is `null`) falls outside every pipeline position, so it gets its own
 *  trailing group — `shell/pipelines-model.ts`'s own fallback for the same
 *  case. */
const PIPELINE_ORDER: readonly string[] = LABEL_DEFAULTS.filter((def) => def.role !== 'marker' && PHASE_NAMES[def.key] !== null).map((def) => def.key)
const UNSTAGED_KEY = 'unstaged'

/** `UNSTAGED_KEY` covers both an unstaged row (no `stageLabel` at all) and
 *  one at a stage `PHASE_NAMES` names `null` (`prOpened` — "never shown as a
 *  phase"), so neither ever needs a second fallback name below. */
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

/** Repo sub-grouping orders by first appearance in `rows` — already sorted
 *  by repository display name (`projectBoard`'s own `compareRows`), so this
 *  reads alphabetically without a second sort here. */
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

/** The three fixed sections, each with its own phase or repo sub-grouping —
 *  an empty section (plan's own **UX states**: "An empty section is
 *  omitted") never appears at all. */
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
