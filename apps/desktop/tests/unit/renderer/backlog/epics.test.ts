import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogChild, BacklogEpicGroup, BacklogRowView, ChildrenRead, ParentRead } from '@/types/backlog'
import type { BlockerRead } from '@/types/github'
import { buildEpicLayout, epicProgressSegments, isEpic } from '@/renderer/backlog/epics'

const REPO_ID = 'repo-a' as RepoId
const NO_LINKS: BlockerRead = { ok: true, open: [], shown: 0, total: 0 }
const NO_PARENT: ParentRead = { ok: true, parent: null }
const NO_CHILDREN: ChildrenRead = { ok: true, children: [], shown: 0, total: 0 }

function blockedBy(...numbers: number[]): BlockerRead {
  return { ok: true, open: numbers.map((number) => ({ number, title: `#${number}`, url: `u${number}`, state: 'OPEN' })), shown: numbers.length, total: numbers.length }
}

function child(number: number, overrides: Partial<BacklogChild> = {}): BacklogChild {
  return { number, title: `Child ${number}`, state: 'OPEN', claimed: false, blockers: NO_LINKS, ...overrides }
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
    expect(summaryOf(group).canStart.map((c) => c.number)).toEqual([3])
    expect(summaryOf(group).done).toBe(1)
  })

  it('counts a claimed child in its wave and lets it block a later wave', () => {
    const children = [child(2, { claimed: true }), child(3, { blockers: blockedBy(2) })]
    const rows = [epicRow(1, children), memberRow(3, 1)]
    const group = epicsOf(buildEpicLayout(rows))[0]!
    expect(group.waves[0]).toMatchObject({ number: 1, rows: [], inProgress: 1, unlisted: 0, inProgressOnly: true })
    expect(waveNumbers(group)).toEqual([[], [3]])
    expect(summaryOf(group).canStart).toEqual([])
  })

  it('does not mark a wave in-progress-only when it also holds a row', () => {
    const children = [child(2, { claimed: true }), child(3)]
    const rows = [epicRow(1, children), memberRow(3, 1)]
    const wave = epicsOf(buildEpicLayout(rows))[0]!.waves[0]!
    expect(wave).toMatchObject({ inProgress: 1, inProgressOnly: false })
    expect(wave.rows.map((r) => r.number)).toEqual([3])
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
    const truncated: BlockerRead = { ok: true, open: [], shown: 0, total: 3 }
    const group = epicsOf(buildEpicLayout([epicRow(1, [child(2, { blockers: truncated })]), memberRow(2, 1)]))[0]!
    expect(summaryOf(group).uncertain).toEqual([2])
    expect(summaryOf(group).canStart).toEqual([])
    expect(waveNumbers(group)).toEqual([[2]])
  })

  it('marks failed blockers as uncertain and not startable', () => {
    const failed: BlockerRead = { ok: false, reason: 'boom' }
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

  it('makes a nested epic its own group, counts it as unlisted, and never duplicates it', () => {
    const inner = epicRow(2, [child(3)], { parent: { ok: true, parent: { number: 1, title: 'Epic 1', state: 'OPEN' } } })
    const outer = epicRow(1, [child(2), child(4)])
    const rows = [outer, inner, memberRow(3, 2), memberRow(4, 1)]
    const layout = buildEpicLayout(rows)
    const epics = epicsOf(layout)
    expect(epics.map((g) => g.epic.number)).toEqual([1, 2])
    expect(epics[0]!.waves[0]).toMatchObject({ unlisted: 1 })
    expect(waveNumbers(epics[0]!)).toEqual([[4]])
    expect(waveNumbers(epics[1]!)).toEqual([[3]])
    expect(rowsOf(layout)).toEqual([])
  })

  it('summarises done, in-progress, open, total and canStart in children order', () => {
    const children = [child(2, { state: 'CLOSED' }), child(3, { claimed: true }), child(5), child(4), child(6, { blockers: blockedBy(4) })]
    const rows = [epicRow(1, children), ...[4, 5, 6].map((n) => memberRow(n, 1))]
    const summary = summaryOf(epicsOf(buildEpicLayout(rows))[0]!)
    expect(summary).toMatchObject({ done: 1, inProgress: 1, open: 3, total: 5, truncated: null })
    expect(summary.canStart.map((c) => c.number)).toEqual([5, 4])
  })

  describe('shown', () => {
    it('keeps wave numbers when a member is hidden and counts it as unlisted', () => {
      const children = [child(2), child(3, { blockers: blockedBy(2) })]
      const rows = [epicRow(1, children), memberRow(2, 1), memberRow(3, 1)]
      const group = epicsOf(buildEpicLayout(rows, new Set([1, 3])))[0]!
      expect(group.waves.map((w) => w.number)).toEqual([1, 2])
      expect(group.waves[0]).toMatchObject({ rows: [], unlisted: 1, inProgressOnly: false })
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
