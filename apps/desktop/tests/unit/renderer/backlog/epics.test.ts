import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogChild, BacklogEpicGroup, BacklogRowView, ChildBlockerRead, ChildrenRead, ParentRead } from '@/types/backlog'
import type { BlockerRead } from '@/types/github'
import { buildEpicLayout, epicBodyEntries, epicProgressSegments, isEpic } from '@/renderer/backlog/epics'

const REPO_ID = 'repo-a' as RepoId
const NO_LINKS: BlockerRead = { ok: true, open: [], shown: 0, total: 0 }
const CHILD_NO_LINKS: ChildBlockerRead = { ok: true, open: [], closed: [], shown: 0, total: 0 }
const NO_PARENT: ParentRead = { ok: true, parent: null }
const NO_CHILDREN: ChildrenRead = { ok: true, children: [], shown: 0, total: 0 }

function blockedBy(...numbers: number[]): ChildBlockerRead {
  return { ok: true, open: numbers.map((number) => ({ number, title: `#${number}`, url: `u${number}`, state: 'OPEN' })), closed: [], shown: numbers.length, total: numbers.length }
}

function closedBlockedBy(...numbers: number[]): ChildBlockerRead {
  return { ok: true, open: [], closed: numbers.map((number) => ({ number, title: `#${number}`, url: `u${number}`, state: 'CLOSED' })), shown: numbers.length, total: numbers.length }
}

function child(number: number, overrides: Partial<BacklogChild> = {}): BacklogChild {
  return { number, title: `Child ${number}`, state: 'OPEN', claimed: false, blockers: CHILD_NO_LINKS, ...overrides }
}

function row(number: number, overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return {
    repoId: REPO_ID,
    repo: 'acme/widgets',
    number,
    title: `Ticket ${number}`,
    url: `u${number}`,
    assignee: null,
    createdAt: '2026-01-01T00:00:00Z',
    labels: [],
    subIssueCount: 0,
    blockers: NO_LINKS,
    blocking: NO_LINKS,
    parent: NO_PARENT,
    children: NO_CHILDREN,
    ...overrides,
  }
}

function epicRow(number: number, children: readonly BacklogChild[], overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return row(number, { subIssueCount: children.length, children: { ok: true, children, shown: children.length, total: children.length }, ...overrides })
}

function memberRow(number: number, epic: number, overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return row(number, { parent: { ok: true, parent: { number: epic, title: `Epic ${epic}`, state: 'OPEN' } }, ...overrides })
}

type Layout = ReturnType<typeof buildEpicLayout>

function epicsOf(layout: Layout): BacklogEpicGroup[] {
  return layout.entries.flatMap((entry) => (entry.kind === 'epic' ? [entry.group] : []))
}

function rowsOf(layout: Layout): BacklogRowView[] {
  return layout.entries.flatMap((entry) => (entry.kind === 'row' ? [entry.row] : []))
}

// `E1` for an epic entry, `1` for a loose row — the layout's whole order in one array.
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

describe('buildEpicLayout', () => {
  it('returns the input as loose rows when there are no epics', () => {
    const rows = [row(3), row(1), row(2)]
    const layout = buildEpicLayout(rows)
    expect(epicsOf(layout)).toEqual([])
    expect(rowsOf(layout)).toEqual(rows)
  })

  it('passes the same row objects through, in input order, when there are no epics', () => {
    const rows = [row(3, { labels: [{ name: 'bug', color: 'd73a4a' }] }), row(1, { assignee: 'octocat' }), row(2)]
    const loose = rowsOf(buildEpicLayout(rows))
    expect(loose).toHaveLength(rows.length)
    loose.forEach((r, i) => expect(r).toBe(rows[i]))
  })

  it('places a chain and an independent ticket into waves', () => {
    const children = [child(2), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(3) }), child(5)]
    const rows = [epicRow(1, children), memberRow(2, 1), memberRow(3, 1), memberRow(4, 1), memberRow(5, 1)]
    const layout = buildEpicLayout(rows)
    const epics = epicsOf(layout)
    expect(rowsOf(layout)).toEqual([])
    expect(epics).toHaveLength(1)
    expect(waveNumbers(epics[0]!)).toEqual([[2, 5], [3], [4]])
    expect(epics[0]!.waves.map((w) => w.number)).toEqual([1, 2, 3])
  })

  describe('created-time order', () => {
    it('puts a newer loose row, then an epic, then an older loose row in that order', () => {
      const rows = [
        row(10, { createdAt: '2026-01-01T00:00:00Z' }),
        epicRow(1, [child(2)], { createdAt: '2026-02-01T00:00:00Z' }),
        memberRow(2, 1),
        row(11, { createdAt: '2026-03-01T00:00:00Z' }),
      ]
      expect(orderOf(buildEpicLayout(rows))).toEqual(['11', 'E1', '10'])
    })

    it('sorts input given out of created order', () => {
      const rows = [row(1, { createdAt: '2026-01-01T00:00:00Z' }), row(2, { createdAt: '2026-03-01T00:00:00Z' }), row(3, { createdAt: '2026-02-01T00:00:00Z' })]
      expect(orderOf(buildEpicLayout(rows))).toEqual(['2', '3', '1'])
    })

    it('keeps input order for equal times, epics and rows alike', () => {
      const rows = [row(5), epicRow(1, [child(2)]), memberRow(2, 1), row(4)]
      expect(orderOf(buildEpicLayout(rows))).toEqual(['5', 'E1', '4'])
    })

    it('sinks an unparsable or empty time to the bottom', () => {
      const rows = [row(1, { createdAt: '' }), row(2, { createdAt: 'not a date' }), row(3, { createdAt: '2020-01-01T00:00:00Z' })]
      expect(orderOf(buildEpicLayout(rows))).toEqual(['3', '1', '2'])
    })

    it('places an epic hidden by the filter but with a shown member by the epic own time', () => {
      const rows = [
        row(10, { createdAt: '2026-01-01T00:00:00Z' }),
        epicRow(1, [child(2)], { createdAt: '2026-02-01T00:00:00Z' }),
        memberRow(2, 1, { createdAt: '2026-04-01T00:00:00Z' }),
        row(11, { createdAt: '2026-03-01T00:00:00Z' }),
      ]
      expect(orderOf(buildEpicLayout(rows, new Set([2, 10, 11])))).toEqual(['11', 'E1', '10'])
    })

    it('never lists a member as a top-level row entry', () => {
      const rows = [epicRow(1, [child(2)]), memberRow(2, 1, { createdAt: '2027-01-01T00:00:00Z' }), row(3)]
      expect(rowsOf(buildEpicLayout(rows)).map((r) => r.number)).toEqual([3])
    })
  })

  it('puts a diamond join one past the highest blocker', () => {
    const children = [child(2), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(3) }), child(5, { blockers: blockedBy(2, 4) })]
    const rows = [epicRow(1, children), ...[2, 3, 4, 5].map((n) => memberRow(n, 1))]
    expect(waveNumbers(epicsOf(buildEpicLayout(rows))[0]!)).toEqual([[2], [3], [4], [5]])
  })

  it('treats a closed sibling blocker as satisfied even when the blocker read lists it open', () => {
    const children = [child(2, { state: 'CLOSED' }), child(3, { blockers: blockedBy(2) })]
    const rows = [epicRow(1, children), memberRow(3, 1)]
    const group = epicsOf(buildEpicLayout(rows))[0]!
    expect(waveNumbers(group)).toEqual([[3]])
    expect(group.waves.map((w) => w.number)).toEqual([2])
    expect(summaryOf(group).canStart.map((c) => c.number)).toEqual([3])
    expect(summaryOf(group).done).toBe(1)
  })

  describe('stable wave numbers', () => {
    const waveShape = (group: BacklogEpicGroup) => group.waves.map((w) => ({ number: w.number, rows: w.rows.map((r) => r.number) }))

    it('keeps a wave number the same before and after a merge', () => {
      const rows = [epicRow(1, []), ...[2, 3, 4, 5].map((n) => memberRow(n, 1))]
      const before = [child(2), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(3) }), child(5)]
      const beforeGroup = epicsOf(buildEpicLayout([{ ...rows[0]!, children: { ok: true, children: before, shown: 4, total: 4 } }, ...rows.slice(1)]))[0]!
      expect(waveShape(beforeGroup)).toEqual([
        { number: 1, rows: [2, 5] },
        { number: 2, rows: [3] },
        { number: 3, rows: [4] },
      ])

      const after = [child(2, { state: 'CLOSED' }), child(3, { blockers: closedBlockedBy(2) }), child(4, { blockers: blockedBy(3) }), child(5, { state: 'CLOSED' })]
      const afterGroup = epicsOf(buildEpicLayout([{ ...rows[0]!, children: { ok: true, children: after, shown: 4, total: 4 } }, ...rows.slice(1)]))[0]!
      expect(waveShape(afterGroup)).toEqual([
        { number: 2, rows: [3] },
        { number: 3, rows: [4] },
      ])
    })

    it('leaves a gap for a fully closed first wave', () => {
      const children = [child(2, { state: 'CLOSED' }), child(3, { blockers: closedBlockedBy(2) })]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(3, 1)]))[0]!
      expect(group.waves.map((w) => w.number)).toEqual([2])
    })

    it('lets a chain of closed children push an open dependent down', () => {
      const children = [child(2, { state: 'CLOSED' }), child(3, { state: 'CLOSED', blockers: closedBlockedBy(2) }), child(4, { blockers: closedBlockedBy(3) })]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(4, 1)]))[0]!
      expect(group.waves.map((w) => w.number)).toEqual([3])
      expect(waveNumbers(group)).toEqual([[4]])
    })

    it('does not report a cycle among closed children', () => {
      const children = [child(2, { state: 'CLOSED', blockers: closedBlockedBy(3) }), child(3, { state: 'CLOSED', blockers: closedBlockedBy(2) }), child(4)]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(4, 1)]))[0]!
      expect(summaryOf(group).cycles).toEqual([])
    })

    it('reports only the open members of a cycle', () => {
      const children = [child(2, { state: 'CLOSED', blockers: closedBlockedBy(3) }), child(3, { blockers: blockedBy(2) })]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(3, 1)]))[0]!
      expect(summaryOf(group).cycles).toEqual([3])
    })

    it('does not flag waves as shifting for a full read', () => {
      const group = epicsOf(buildEpicLayout([epicRow(1, [child(2)]), memberRow(2, 1)]))[0]!
      expect(summaryOf(group).wavesMayShift).toBe(false)
    })

    it('flags waves as shifting when the children read is truncated', () => {
      const epic = row(1, { subIssueCount: 5, children: { ok: true, children: [child(2)], shown: 1, total: 5 } })
      const group = epicsOf(buildEpicLayout([epic, memberRow(2, 1)]))[0]!
      expect(summaryOf(group).wavesMayShift).toBe(true)
    })

    it('flags waves as shifting for a truncated or failed blocker read on a closed child, without marking it uncertain', () => {
      const truncated: ChildBlockerRead = { ok: true, open: [], closed: [], shown: 0, total: 3 }
      const failed: ChildBlockerRead = { ok: false, reason: 'boom' }
      for (const blockers of [truncated, failed]) {
        const group = epicsOf(buildEpicLayout([epicRow(1, [child(2, { state: 'CLOSED', blockers }), child(3)]), memberRow(3, 1)]))[0]!
        expect(summaryOf(group).wavesMayShift).toBe(true)
        expect(summaryOf(group).uncertain).toEqual([])
      }
    })
  })

  it('hides a claimed child wave but lets it block a later wave', () => {
    const children = [child(2, { claimed: true }), child(3, { blockers: blockedBy(2) })]
    const rows = [epicRow(1, children), memberRow(3, 1)]
    const group = epicsOf(buildEpicLayout(rows))[0]!
    expect(waveNumbers(group)).toEqual([[3]])
    expect(group.waves.map((w) => w.number)).toEqual([2])
    expect(summaryOf(group).canStart).toEqual([])
  })

  it('ignores a blocker outside the epic for wave placement but never offers the child to start', () => {
    const children = [child(2, { blockers: blockedBy(99) })]
    const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(2, 1)]))[0]!
    expect(waveNumbers(group)).toEqual([[2]])
    expect(summaryOf(group).canStart).toEqual([])
  })

  describe('cycles', () => {
    it('shares a wave between two mutual blockers and refuses to start them', () => {
      const children = [child(2, { blockers: blockedBy(3) }), child(3, { blockers: blockedBy(2) })]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(2, 1), memberRow(3, 1)]))[0]!
      expect(waveNumbers(group)).toEqual([[2, 3]])
      expect(summaryOf(group).cycles).toEqual([2, 3])
      expect(summaryOf(group).canStart).toEqual([])
    })

    it('counts a self-loop as a cycle', () => {
      const children = [child(2, { blockers: blockedBy(2) })]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), memberRow(2, 1)]))[0]!
      expect(summaryOf(group).cycles).toEqual([2])
      expect(waveNumbers(group)).toEqual([[2]])
    })

    it('places a ticket blocked by a cycle after it', () => {
      const children = [child(2, { blockers: blockedBy(3) }), child(3, { blockers: blockedBy(2) }), child(4, { blockers: blockedBy(2) })]
      const group = epicsOf(buildEpicLayout([epicRow(1, children), ...[2, 3, 4].map((n) => memberRow(n, 1))]))[0]!
      expect(waveNumbers(group)).toEqual([[2, 3], [4]])
      expect(summaryOf(group).cycles).toEqual([2, 3])
    })
  })

  it('marks truncated blockers as uncertain and not startable', () => {
    const truncated: ChildBlockerRead = { ok: true, open: [], closed: [], shown: 0, total: 3 }
    const group = epicsOf(buildEpicLayout([epicRow(1, [child(2, { blockers: truncated })]), memberRow(2, 1)]))[0]!
    expect(summaryOf(group).uncertain).toEqual([2])
    expect(summaryOf(group).canStart).toEqual([])
    expect(waveNumbers(group)).toEqual([[2]])
  })

  it('marks failed blockers as uncertain and not startable', () => {
    const failed: ChildBlockerRead = { ok: false, reason: 'boom' }
    const group = epicsOf(buildEpicLayout([epicRow(1, [child(2, { blockers: failed })]), memberRow(2, 1)]))[0]!
    expect(summaryOf(group).uncertain).toEqual([2])
    expect(summaryOf(group).canStart).toEqual([])
  })

  it('reports truncated children and leaves a missing child unplaced', () => {
    const epic = row(1, { subIssueCount: 5, children: { ok: true, children: [child(2)], shown: 1, total: 5 } })
    const group = epicsOf(buildEpicLayout([epic, memberRow(2, 1), memberRow(3, 1)]))[0]!
    expect(summaryOf(group).truncated).toEqual({ shown: 1, total: 5 })
    expect(summaryOf(group).total).toBe(5)
    expect(group.unplaced.map((r) => r.number)).toEqual([3])
  })

  it('keeps parented rows unplaced, not loose, when the children read failed', () => {
    const epic = row(1, { subIssueCount: 2, children: { ok: false, reason: 'nope' } })
    const layout = buildEpicLayout([epic, memberRow(2, 1), memberRow(3, 1), row(4)])
    const group = epicsOf(layout)[0]!
    expect(group.summary).toEqual({ ok: false, reason: 'nope' })
    expect(group.waves).toEqual([])
    expect(group.unplaced.map((r) => r.number)).toEqual([2, 3])
    expect(rowsOf(layout).map((r) => r.number)).toEqual([4])
  })

  it('sends orphans to loose rows', () => {
    const epic = epicRow(1, [child(2)])
    const noParent = row(3)
    const missingParent = memberRow(4, 77)
    const failedParent = row(5, { parent: { ok: false, reason: 'x' } })
    const layout = buildEpicLayout([epic, memberRow(2, 1), noParent, missingParent, failedParent])
    expect(rowsOf(layout).map((r) => r.number)).toEqual([3, 4, 5])
  })

  describe('nested epics', () => {
    const nestedEpic = (number: number, children: readonly BacklogChild[], parent: number) => epicRow(number, children, { parent: { ok: true, parent: { number: parent, title: `Epic ${parent}`, state: 'OPEN' } } })

    it('nests instead of making a top-level group', () => {
      const rows = [epicRow(1, [child(2), child(20)]), memberRow(2, 1), nestedEpic(20, [child(21)], 1), memberRow(21, 20)]
      const layout = buildEpicLayout(rows)
      const epics = epicsOf(layout)
      expect(epics).toHaveLength(1)
      expect(epics[0]!.epics.map((g) => g.epic.number)).toEqual([20])
      expect(waveNumbers(epics[0]!)).toEqual([[2]])
      expect(waveNumbers(epics[0]!.epics[0]!)).toEqual([[21]])
      expect(rowsOf(layout)).toEqual([])
    })

    it('continues numbering through a nested epic', () => {
      const parent = epicRow(1, [child(2), child(20, { blockers: blockedBy(2) }), child(3, { blockers: blockedBy(20) })])
      const inner = nestedEpic(20, [child(21), child(22, { blockers: blockedBy(21) })], 1)
      const group = epicsOf(buildEpicLayout([parent, memberRow(2, 1), inner, memberRow(21, 20), memberRow(22, 20), memberRow(3, 1)]))[0]!
      expect(group.waves.map((w) => ({ number: w.number, rows: w.rows.map((r) => r.number) }))).toEqual([
        { number: 1, rows: [2] },
        { number: 4, rows: [3] },
      ])
      const nested = group.epics[0]!
      expect(nested.start).toBe(2)
      expect(nested.waves.map((w) => ({ number: w.number, rows: w.rows.map((r) => r.number) }))).toEqual([
        { number: 2, rows: [21] },
        { number: 3, rows: [22] },
      ])
    })

    it('shares the nested epic first number with a parallel ticket', () => {
      const parent = epicRow(1, [child(2), child(20, { blockers: blockedBy(2) }), child(3, { blockers: blockedBy(20) }), child(4, { blockers: blockedBy(2) })])
      const inner = nestedEpic(20, [child(21)], 1)
      const group = epicsOf(buildEpicLayout([parent, memberRow(2, 1), inner, memberRow(21, 20), memberRow(3, 1), memberRow(4, 1)]))[0]!
      const order = epicBodyEntries(group).map((entry) => (entry.kind === 'wave' ? `w${entry.wave.number}` : `e${entry.group.epic.number}`))
      expect(order).toEqual(['w1', 'w2', 'e20', 'w3'])
    })

    it('stays stable across a merge inside the nested epic', () => {
      const parent = epicRow(1, [child(2), child(20, { blockers: blockedBy(2) }), child(3, { blockers: blockedBy(20) })])
      const closedInner = nestedEpic(20, [child(21, { state: 'CLOSED' }), child(22, { blockers: closedBlockedBy(21) })], 1)
      const group = epicsOf(buildEpicLayout([parent, memberRow(2, 1), closedInner, memberRow(22, 20), memberRow(3, 1)]))[0]!
      expect(group.epics[0]!.waves.map((w) => w.number)).toEqual([3])
      expect(group.waves.map((w) => w.number)).toEqual([1, 4])
    })

    it('accumulates offsets over three levels', () => {
      const rows = [
        epicRow(1, [child(2), child(10, { blockers: blockedBy(2) })]),
        memberRow(2, 1),
        nestedEpic(10, [child(11), child(20, { blockers: blockedBy(11) })], 1),
        memberRow(11, 10),
        nestedEpic(20, [child(21)], 10),
        memberRow(21, 20),
      ]
      const root = epicsOf(buildEpicLayout(rows))[0]!
      const innermost = root.epics[0]!.epics[0]!
      expect(innermost.start).toBe(3)
      expect(innermost.waves.map((w) => w.number)).toEqual([3])
    })

    it('counts a nested epic once in the parent progress and never offers it to start', () => {
      const rows = [epicRow(1, [child(2), child(20)]), memberRow(2, 1), nestedEpic(20, [child(21)], 1), memberRow(21, 20)]
      const summary = summaryOf(epicsOf(buildEpicLayout(rows))[0]!)
      expect(summary).toMatchObject({ total: 2, open: 2 })
      expect(summary.canStart.map((c) => c.number)).toEqual([2])
    })

    it('places a parent-named epic missing from a truncated read after the last wave', () => {
      const parent = row(1, { subIssueCount: 5, children: { ok: true, children: [child(2)], shown: 1, total: 5 } })
      const group = epicsOf(buildEpicLayout([parent, memberRow(2, 1), nestedEpic(30, [child(31)], 1), memberRow(31, 30)]))[0]!
      expect(group.epics[0]!.start).toBe(2)
    })

    it('places a parent-named epic at 1 when the parent read failed', () => {
      const parent = row(1, { subIssueCount: 2, children: { ok: false, reason: 'nope' } })
      const group = epicsOf(buildEpicLayout([parent, nestedEpic(30, [child(31)], 1), memberRow(31, 30)]))[0]!
      expect(group.epics[0]!.start).toBe(1)
    })

    it('drops a nested epic with nothing shown and keeps a parent whose only content is a nested epic', () => {
      const rows = [epicRow(1, [child(2), child(20)]), memberRow(2, 1), nestedEpic(20, [child(21)], 1), memberRow(21, 20)]
      expect(epicsOf(buildEpicLayout(rows, new Set([2])))[0]!.epics).toEqual([])
      expect(epicsOf(buildEpicLayout(rows, new Set([21])))[0]!.epics.map((g) => g.epic.number)).toEqual([20])
    })

    it('terminates on two epics listing each other and builds each once', () => {
      const rows = [epicRow(1, [child(2)]), epicRow(2, [child(1)])]
      const epics = epicsOf(buildEpicLayout(rows))
      const seen = (group: BacklogEpicGroup): number[] => [group.epic.number, ...group.epics.flatMap(seen)]
      expect(epics.flatMap(seen).sort()).toEqual([1, 2])
    })

    it('propagates wavesMayShift from a nested epic', () => {
      const inner = row(20, { subIssueCount: 5, children: { ok: true, children: [child(21)], shown: 1, total: 5 }, parent: { ok: true, parent: { number: 1, title: 'Epic 1', state: 'OPEN' } } })
      const group = epicsOf(buildEpicLayout([epicRow(1, [child(20)]), inner, memberRow(21, 20)]))[0]!
      expect(summaryOf(group).wavesMayShift).toBe(true)
    })

    it('ignores the filter when computing a span', () => {
      const parent = epicRow(1, [child(20), child(3, { blockers: blockedBy(20) })])
      const inner = nestedEpic(20, [child(21), child(22, { blockers: blockedBy(21) })], 1)
      const group = epicsOf(buildEpicLayout([parent, inner, memberRow(21, 20), memberRow(22, 20), memberRow(3, 1)], new Set([22, 3])))[0]!
      expect(group.waves.map((w) => w.number)).toEqual([3])
    })
  })

  it('summarises done, in-progress, open, total and canStart in children order', () => {
    const children = [child(2, { state: 'CLOSED' }), child(3, { claimed: true }), child(5), child(4), child(6, { blockers: blockedBy(4) })]
    const rows = [epicRow(1, children), ...[4, 5, 6].map((n) => memberRow(n, 1))]
    const summary = summaryOf(epicsOf(buildEpicLayout(rows))[0]!)
    expect(summary).toMatchObject({ done: 1, inProgress: 1, open: 3, total: 5, truncated: null })
    expect(summary.canStart.map((c) => c.number)).toEqual([5, 4])
  })

  describe('shown', () => {
    it('keeps wave numbers when a member is hidden', () => {
      const children = [child(2), child(3, { blockers: blockedBy(2) })]
      const rows = [epicRow(1, children), memberRow(2, 1), memberRow(3, 1)]
      const group = epicsOf(buildEpicLayout(rows, new Set([1, 3])))[0]!
      expect(group.waves.map((w) => w.number)).toEqual([2])
      expect(summaryOf(group).canStart.map((c) => c.number)).toEqual([2])
    })

    it('drops an epic with nothing shown', () => {
      const rows = [epicRow(1, [child(2)]), memberRow(2, 1), row(9)]
      const layout = buildEpicLayout(rows, new Set([9]))
      expect(epicsOf(layout)).toEqual([])
      expect(rowsOf(layout).map((r) => r.number)).toEqual([9])
    })

    it('keeps an epic whose row is hidden while a member is shown', () => {
      const rows = [epicRow(1, [child(2)]), memberRow(2, 1)]
      expect(epicsOf(buildEpicLayout(rows, new Set([2])))).toHaveLength(1)
    })

    it('filters the loose rows', () => {
      const layout = buildEpicLayout([row(1), row(2)], new Set([2]))
      expect(rowsOf(layout).map((r) => r.number)).toEqual([2])
    })
  })

  it('does not depend on input row order', () => {
    const children = [child(2), child(3, { blockers: blockedBy(2) }), child(4)]
    const rows = [epicRow(1, children), memberRow(2, 1), memberRow(3, 1), memberRow(4, 1)]
    const shuffled = [rows[3]!, rows[1]!, rows[0]!, rows[2]!]
    const sorted = (rs: typeof rows) => epicsOf(buildEpicLayout(rs))[0]!.waves.map((w) => ({ n: w.number, rows: w.rows.map((r) => r.number).sort() }))
    expect(sorted(shuffled)).toEqual(sorted(rows))
  })

  it('does not mutate its input', () => {
    const rows = Object.freeze([epicRow(1, [child(2)]), memberRow(2, 1)])
    expect(() => buildEpicLayout(rows)).not.toThrow()
  })
})

describe('isEpic', () => {
  it('is true for a readable children read with sub-issues', () => {
    expect(isEpic(epicRow(1, [child(2)]))).toBe(true)
  })

  it('falls back to the sub-issue count when the children read failed', () => {
    expect(isEpic(row(1, { subIssueCount: 2, children: { ok: false, reason: 'nope' } }))).toBe(true)
  })

  it('is false for a plain row', () => {
    expect(isEpic(row(1))).toBe(false)
  })
})

describe('epicProgressSegments', () => {
  it('splits the bar into done then in progress', () => {
    expect(epicProgressSegments(1, 1, 4)).toEqual({ done: 25, inProgress: 25 })
  })

  it('is empty for an epic with no sub-issues', () => {
    expect(epicProgressSegments(0, 0, 0)).toEqual({ done: 0, inProgress: 0 })
  })

  it('never sums past 100 after rounding', () => {
    const { done, inProgress } = epicProgressSegments(1, 1, 3)
    expect(done + inProgress).toBeLessThanOrEqual(100)
  })

  it('fills the bar when everything is done', () => {
    expect(epicProgressSegments(3, 0, 3)).toEqual({ done: 100, inProgress: 0 })
  })
})
