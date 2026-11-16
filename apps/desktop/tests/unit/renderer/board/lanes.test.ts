import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardItemRow } from '@/types/board'
import type { ReconciledItem, StageLabel } from '@/types/state'
import type { Ticket } from '@/types/ticket'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { ticketIndex } from '@/utils/tickets/ticket'
import { boardColumns } from '@/renderer/board/columns'
import { laneToggleAria } from '@/renderer/board/copy'
import { boardLanes, navigableLaneRows } from '@/renderer/board/lanes'

function row(repoId: string, number: number, stageKey: LabelKey | null): BoardItemRow {
  const stageLabel: StageLabel | null = stageKey !== null ? { key: stageKey, name: stageKey, role: 'trigger' } : null
  const item = { repoId, repo: repoId, kind: 'issue', number, title: 't', url: 'https://example.com', assignees: [], stage: stageKey, stages: stageLabel !== null ? [stageLabel] : [], marked: true, autoPlan: false, status: 'waiting', state: 'OPEN', sources: ['github'] } as unknown as ReconciledItem
  return { item, ticket: ticketIndex([item]).tickets[0] as Ticket, stageLabel, blockedOn: null } as unknown as BoardItemRow
}

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const C = 'repo-c' as RepoId
const REPOS = [
  { repoId: A, name: 'o/a' },
  { repoId: B, name: 'o/b' },
  { repoId: C, name: 'o/c' },
]

const a1 = row(A, 1, 'ready')
const a2 = row(A, 2, 'planning')
const a3 = row(A, 3, 'inProgress')
const b1 = row(B, 4, 'ready')
const b2 = row(B, 5, 'reviewing')
const aUngated = row(A, 6, 'readyForReview')
const ROWS = [a1, a2, a3, b1, b2]

function numbers(rows: readonly BoardItemRow[]): number[] {
  return rows.map((r) => r.item.number)
}

describe('boardLanes', () => {
  const lanes = boardLanes(ROWS, [aUngated], REPOS)

  it('gives one lane per repository in the given order, including an empty one', () => {
    expect(lanes.map((lane) => lane.repoId)).toEqual([A, B, C])
    expect(lanes.map((lane) => lane.name)).toEqual(['o/a', 'o/b', 'o/c'])
    expect(lanes[2]?.count).toBe(0)
    expect(lanes[2]?.columns).toHaveLength(6)
    expect(lanes[2]?.columns.every((column) => column.cards.length === 0)).toBe(true)
  })

  it('holds only its own repository rows, ungated included', () => {
    expect(numbers(lanes[0]?.columns.flatMap((c) => c.cards.map((card) => card.row)) ?? []).sort()).toEqual([1, 2, 3, 6])
    expect(numbers(lanes[1]?.columns.flatMap((c) => c.cards.map((card) => card.row)) ?? []).sort()).toEqual([4, 5])
  })

  it('counts the lane card total', () => {
    expect(lanes.map((lane) => lane.count)).toEqual([4, 2, 0])
  })

  it('loses and duplicates no row against the all-repositories projection', () => {
    const all = boardColumns(ROWS, [aUngated], { repo: null })
    all.forEach((column, index) => {
      const fromLanes = lanes.flatMap((lane) => lane.columns[index]?.cards ?? [])
      expect(fromLanes.map((card) => card.row.item.number).sort()).toEqual(column.cards.map((card) => card.row.item.number).sort())
    })
  })
})

describe('navigableLaneRows', () => {
  const lanes = boardLanes(ROWS, [], REPOS)

  it('walks lanes in order and columns top to bottom within a lane', () => {
    expect(numbers(navigableLaneRows(lanes, new Set()))).toEqual([1, 2, 3, 4, 5])
  })

  it('skips a collapsed lane', () => {
    expect(numbers(navigableLaneRows(lanes, new Set([A])))).toEqual([4, 5])
  })

  it('is empty when every lane is collapsed', () => {
    expect(navigableLaneRows(lanes, new Set([A, B, C]))).toEqual([])
  })
})

describe('laneToggleAria', () => {
  it('names the action the toggle will take', () => {
    expect(laneToggleAria('acme/widgets', false)).toBe('Collapse acme/widgets')
    expect(laneToggleAria('acme/widgets', true)).toBe('Expand acme/widgets')
  })
})
