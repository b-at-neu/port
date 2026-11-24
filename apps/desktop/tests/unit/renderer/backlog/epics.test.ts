import { describe, expect, it } from 'vitest'
import type { BacklogChild, BacklogEpicGroup, BacklogRowView, ChildBlockerRead } from '@/types/backlog'
import { buildEpicLayout, epicBodyEntries, epicProgressSegments, isEpic } from '@/renderer/backlog/epics'
import { backlogRow as row, blockedBy, child, closedBlockedBy, epicRow, memberRow } from '../../../support/backlog-row'

type Layout = ReturnType<typeof buildEpicLayout>

function epicsOf(layout: Layout): BacklogEpicGroup[] {
  return layout.entries.flatMap((entry) => (entry.kind === 'epic' ? [entry.group] : []))
}

function rowsOf(layout: Layout): BacklogRowView[] {
  return layout.entries.flatMap((entry) => (entry.kind === 'row' ? [entry.row] : []))
}

function orderOf(layout: Layout): string[] {
  return layout.entries.map((entry) => (entry.kind === 'epic' ? `E${entry.group.epic.number}` : String(entry.row.number)))
}

function waveNumbers(group: BacklogEpicGroup): number[][] {
  return group.waves.map((wave) => wave.rows.map((r) => r.number))
}

function summaryOf(group: BacklogEpicGroup) {
  if (!group.summary.ok) throw new Error('expected an ok summary')
  return group.summary
}

function groupOf(epic: BacklogRowView, ...members: BacklogRowView[]): BacklogEpicGroup {
  return epicsOf(buildEpicLayout([epic, ...members]))[0]!
}

const truncatedBlockers: ChildBlockerRead = { ok: true, open: [], closed: [], shown: 0, total: 3 }
const failedBlockers: ChildBlockerRead = { ok: false, reason: 'boom' }
const nestedEpic = (number: number, children: readonly BacklogChild[], parent: number) => epicRow(number, children, { parent: { ok: true, parent: { number: parent, title: `Epic ${parent}`, state: 'OPEN' } } })

describe('buildEpicLayout order', () => {
  it.each([
    ['newest first across rows and epics', [row(10, { createdAt: '2026-01-01T00:00:00Z' }), epicRow(1, [child(2)], { createdAt: '2026-02-01T00:00:00Z' }), memberRow(2, 1), row(11, { createdAt: '2026-03-01T00:00:00Z' })], ['11', 'E1', '10']],
    ['input order for equal times', [row(5), epicRow(1, [child(2)]), memberRow(2, 1), row(4)], ['5', 'E1', '4']],
    ['unparsable times last', [row(1, { createdAt: '' }), row(2, { createdAt: 'not a date' }), row(3, { createdAt: '2020-01-01T00:00:00Z' })], ['3', '1', '2']],
    ['an epic by its own time, not its newest member', [row(10, { createdAt: '2026-01-01T00:00:00Z' }), epicRow(1, [child(2)], { createdAt: '2026-02-01T00:00:00Z' }), memberRow(2, 1, { createdAt: '2026-04-01T00:00:00Z' }), row(11, { createdAt: '2026-03-01T00:00:00Z' })], ['11', 'E1', '10']],
  ])('puts %s', (_name, rows, order) => {
    expect(orderOf(buildEpicLayout(rows))).toEqual(order)
  })

  it('never lists a member as a loose row, and sends orphans to loose rows', () => {
    const rows = [epicRow(1, [child(2)]), memberRow(2, 1), row(3), memberRow(4, 77), row(5, { parent: { ok: false, reason: 'x' } })]
    expect(rowsOf(buildEpicLayout(rows)).map((r) => r.number)).toEqual([3, 4, 5])
  })
})

describe('wave placement', () => {
  it.each([
    ['a chain beside an independent ticket', [child(2), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(3) }), child(5)], [[2, 5], [3], [4]], [1, 2, 3]],
    ['a diamond join one past its highest blocker', [child(2), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(3) }), child(5, { blockers: blockedBy(2, 4) })], [[2], [3], [4], [5]], [1, 2, 3, 4]],
    ['a closed sibling blocker as satisfied', [child(2, { state: 'CLOSED' }), child(3, { blockers: blockedBy(2) })], [[3]], [2]],
    ['a fully closed first wave as a gap', [child(2, { state: 'CLOSED' }), child(3, { blockers: closedBlockedBy(2) })], [[3]], [2]],
    ['a closed chain pushing an open dependent down', [child(2, { state: 'CLOSED' }), child(3, { state: 'CLOSED', blockers: closedBlockedBy(2) }), child(4, { blockers: closedBlockedBy(3) })], [[4]], [3]],
    ['a claimed child hidden but still blocking', [child(2, { claimed: true }), child(3, { blockers: blockedBy(2) })], [[3]], [2]],
    ['a blocker outside the epic ignored', [child(2, { blockers: blockedBy(99) })], [[2]], [1]],
  ])('places %s', (_name, children, rows, numbers) => {
    const shown = children.filter((c) => c.state === 'OPEN' && !c.claimed)
    const group = groupOf(epicRow(1, children), ...shown.map((c) => memberRow(c.number, 1)))
    expect(waveNumbers(group)).toEqual(rows)
    expect(group.waves.map((w) => w.number)).toEqual(numbers)
  })

  it('keeps wave numbers when a member is hidden', () => {
    const rows = [epicRow(1, [child(2), child(3, { blockers: blockedBy(2) })]), memberRow(2, 1), memberRow(3, 1)]
    const group = epicsOf(buildEpicLayout(rows, new Set([1, 3])))[0]!
    expect(group.waves.map((w) => w.number)).toEqual([2])
    expect(summaryOf(group).canStart.map((c) => c.number)).toEqual([2])
  })

  it('is independent of input row order', () => {
    const rows = [epicRow(1, [child(2), child(3, { blockers: blockedBy(2) }), child(4)]), memberRow(2, 1), memberRow(3, 1), memberRow(4, 1)]
    const shapeOf = (input: BacklogRowView[]) => epicsOf(buildEpicLayout(input))[0]!.waves.map((w) => ({ n: w.number, rows: w.rows.map((r) => r.number).sort() }))
    expect(shapeOf([rows[3]!, rows[1]!, rows[0]!, rows[2]!])).toEqual(shapeOf(rows))
  })
})

describe('cycles', () => {
  it.each([
    ['mutual blockers', [child(2, { blockers: blockedBy(3) }), child(3, { blockers: blockedBy(2) })], [[2, 3]], [2, 3]],
    ['a self-loop', [child(2, { blockers: blockedBy(2) })], [[2]], [2]],
    ['a ticket blocked by a cycle, placed after it', [child(2, { blockers: blockedBy(3) }), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(2) })], [[2, 3], [4]], [2, 3]],
    ['only the open members of a mixed cycle', [child(2, { state: 'CLOSED', blockers: closedBlockedBy(3) }), child(3, { blockers: blockedBy(2) })], [[3]], [3]],
    ['nothing among closed children', [child(2, { state: 'CLOSED', blockers: closedBlockedBy(3) }), child(3, { state: 'CLOSED', blockers: closedBlockedBy(2) }), child(4)], [[4]], []],
  ])('reports %s', (_name, children, rows, cycles) => {
    const open = children.filter((c) => c.state === 'OPEN')
    const group = groupOf(epicRow(1, children), ...open.map((c) => memberRow(c.number, 1)))
    expect(waveNumbers(group)).toEqual(rows)
    expect(summaryOf(group).cycles).toEqual(cycles)
  })
})

describe('uncertainty and truncation', () => {
  it.each([
    ['truncated', truncatedBlockers],
    ['failed', failedBlockers],
  ])('marks %s blockers uncertain and not startable', (_name, blockers) => {
    const group = groupOf(epicRow(1, [child(2, { blockers })]), memberRow(2, 1))
    expect(summaryOf(group).uncertain).toEqual([2])
    expect(summaryOf(group).canStart).toEqual([])
  })

  it.each([
    ['a full read', epicRow(1, [child(2)]), false],
    ['a truncated children read', row(1, { subIssueCount: 5, children: { ok: true, children: [child(2)], shown: 1, total: 5 } }), true],
    ['a truncated blocker read on a closed child', epicRow(1, [child(2, { state: 'CLOSED', blockers: truncatedBlockers }), child(3)]), true],
    ['a failed blocker read on a closed child', epicRow(1, [child(2, { state: 'CLOSED', blockers: failedBlockers }), child(3)]), true],
  ])('sets wavesMayShift for %s', (_name, epic, shifts) => {
    const group = groupOf(epic, memberRow(2, 1), memberRow(3, 1))
    expect(summaryOf(group).wavesMayShift).toBe(shifts)
    expect(summaryOf(group).uncertain).toEqual([])
  })

  it('reports truncated children and leaves a missing child unplaced', () => {
    const group = groupOf(row(1, { subIssueCount: 5, children: { ok: true, children: [child(2)], shown: 1, total: 5 } }), memberRow(2, 1), memberRow(3, 1))
    expect(summaryOf(group)).toMatchObject({ truncated: { shown: 1, total: 5 }, total: 5 })
    expect(group.unplaced.map((r) => r.number)).toEqual([3])
  })

  it('keeps parented rows unplaced, not loose, when the children read failed', () => {
    const layout = buildEpicLayout([row(1, { subIssueCount: 2, children: { ok: false, reason: 'nope' } }), memberRow(2, 1), memberRow(3, 1), row(4)])
    const group = epicsOf(layout)[0]!
    expect(group.summary).toEqual({ ok: false, reason: 'nope' })
    expect(group.unplaced.map((r) => r.number)).toEqual([2, 3])
    expect(rowsOf(layout).map((r) => r.number)).toEqual([4])
  })
})

describe('nested epics', () => {
  const waveShape = (group: BacklogEpicGroup) => group.waves.map((w) => ({ number: w.number, rows: w.rows.map((r) => r.number) }))

  it('nests an epic inside its parent instead of listing it top level', () => {
    const layout = buildEpicLayout([epicRow(1, [child(2), child(20)]), memberRow(2, 1), nestedEpic(20, [child(21)], 1), memberRow(21, 20)])
    const [root] = epicsOf(layout)
    expect(epicsOf(layout)).toHaveLength(1)
    expect(root!.epics.map((g) => g.epic.number)).toEqual([20])
    expect(waveNumbers(root!.epics[0]!)).toEqual([[21]])
    expect(summaryOf(root!)).toMatchObject({ total: 2, open: 2 })
    expect(summaryOf(root!).canStart.map((c) => c.number)).toEqual([2])
  })

  it('continues wave numbering through a nested epic', () => {
    const parent = epicRow(1, [child(2), child(20, { blockers: blockedBy(2) }), child(3, { blockers: blockedBy(20) })])
    const inner = nestedEpic(20, [child(21), child(22, { blockers: blockedBy(21) })], 1)
    const group = groupOf(parent, memberRow(2, 1), inner, memberRow(21, 20), memberRow(22, 20), memberRow(3, 1))
    expect(waveShape(group)).toEqual([{ number: 1, rows: [2] }, { number: 4, rows: [3] }])
    expect(group.epics[0]!.start).toBe(2)
    expect(waveShape(group.epics[0]!)).toEqual([{ number: 2, rows: [21] }, { number: 3, rows: [22] }])
  })

  it('shares the first wave number with a parallel ticket and orders body entries', () => {
    const parent = epicRow(1, [child(2), child(20, { blockers: blockedBy(2) }), child(3, { blockers: blockedBy(20) }), child(4, { blockers: blockedBy(2) })])
    const group = groupOf(parent, memberRow(2, 1), nestedEpic(20, [child(21)], 1), memberRow(21, 20), memberRow(3, 1), memberRow(4, 1))
    expect(epicBodyEntries(group).map((entry) => (entry.kind === 'wave' ? `w${entry.wave.number}` : `e${entry.group.epic.number}`))).toEqual(['w1', 'w2', 'e20', 'w3'])
  })

  it('accumulates offsets over three levels', () => {
    const root = groupOf(
      epicRow(1, [child(2), child(10, { blockers: blockedBy(2) })]),
      memberRow(2, 1),
      nestedEpic(10, [child(11), child(20, { blockers: blockedBy(11) })], 1),
      memberRow(11, 10),
      nestedEpic(20, [child(21)], 10),
      memberRow(21, 20),
    )
    expect(root.epics[0]!.epics[0]!.start).toBe(3)
  })

  it.each([
    ['a parent named in a truncated read, after the last wave', row(1, { subIssueCount: 5, children: { ok: true, children: [child(2)], shown: 1, total: 5 } }), 2],
    ['a parent whose read failed, at 1', row(1, { subIssueCount: 2, children: { ok: false, reason: 'nope' } }), 1],
  ])('places an epic under %s', (_name, parent, start) => {
    expect(groupOf(parent, memberRow(2, 1), nestedEpic(30, [child(31)], 1), memberRow(31, 30)).epics[0]!.start).toBe(start)
  })

  it('terminates on two epics listing each other and builds each once', () => {
    const seen = (group: BacklogEpicGroup): number[] => [group.epic.number, ...group.epics.flatMap(seen)]
    expect(epicsOf(buildEpicLayout([epicRow(1, [child(2)]), epicRow(2, [child(1)])])).flatMap(seen).sort()).toEqual([1, 2])
  })
})

describe('shown filtering', () => {
  const rows = [epicRow(1, [child(2)]), memberRow(2, 1), row(9)]

  it.each([
    ['drops an epic with nothing shown', new Set([9]), 0, [9]],
    ['keeps an epic whose row is hidden while a member is shown', new Set([2]), 1, []],
    ['keeps loose rows in the set beside a shown epic', new Set([2, 9]), 1, [9]],
  ])('%s', (_name, shown, epics, loose) => {
    const layout = buildEpicLayout(rows, shown)
    expect(epicsOf(layout)).toHaveLength(epics)
    expect(rowsOf(layout).map((r) => r.number)).toEqual(loose)
  })
})

describe('summary and helpers', () => {
  it('summarises done, in-progress, open, total and canStart in children order', () => {
    const children = [child(2, { state: 'CLOSED' }), child(3, { claimed: true }), child(5), child(4), child(6, { blockers: blockedBy(4) })]
    const summary = summaryOf(groupOf(epicRow(1, children), ...[4, 5, 6].map((n) => memberRow(n, 1))))
    expect(summary).toMatchObject({ done: 1, inProgress: 1, open: 3, total: 5, truncated: null })
    expect(summary.canStart.map((c) => c.number)).toEqual([5, 4])
  })

  it.each([
    ['a readable children read', epicRow(1, [child(2)]), true],
    ['a failed read with sub-issues', row(1, { subIssueCount: 2, children: { ok: false, reason: 'nope' } }), true],
    ['a plain row', row(1), false],
  ])('isEpic is decided by %s', (_name, input, expected) => {
    expect(isEpic(input)).toBe(expected)
  })

  it.each([
    [[1, 1, 4], { done: 25, inProgress: 25 }],
    [[0, 0, 0], { done: 0, inProgress: 0 }],
    [[3, 0, 3], { done: 100, inProgress: 0 }],
  ] as const)('epicProgressSegments%j', ([done, inProgress, total], expected) => {
    expect(epicProgressSegments(done, inProgress, total)).toEqual(expected)
  })
})
