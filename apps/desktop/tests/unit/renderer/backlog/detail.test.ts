import { describe, expect, it } from 'vitest'
import { assigneeView, backlogRowPress, epicSummaryView, findEpicGroup, linkListView } from '@/renderer/backlog/detail'
import type { BacklogEpicGroup, BacklogGroupView, BacklogRowView } from '@/types/backlog'
import type { RepoId } from '@/utils/repos'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId

const link = (number: number, state = 'OPEN') => ({ number, title: `Ticket ${String(number)}`, url: `https://example.test/${String(number)}`, state })

function row(repoId: RepoId, number: number): BacklogRowView {
  return { repoId, number } as BacklogRowView
}

function epicGroup(repoId: RepoId, number: number, epics: BacklogEpicGroup[] = []): BacklogEpicGroup {
  return { epic: row(repoId, number), start: 1, waves: [], epics, unplaced: [], summary: { ok: false, reason: 'x' } }
}

function loaded(repoId: RepoId, group: BacklogEpicGroup): BacklogGroupView {
  return { kind: 'loaded', repoId, repo: String(repoId), items: [], totalCount: 0, labelOptions: [], truncatedNote: null, layout: { entries: [{ kind: 'epic', group }, { kind: 'row', row: row(repoId, 7) }] } }
}

describe('backlogRowPress', () => {
  it.each([
    ['a control press selects', { key: 'a:1', detailKey: 'a:1', button: 0, onControl: true }, 'select'],
    ['a non-primary press selects', { key: 'a:1', detailKey: null, button: 2, onControl: false }, 'select'],
    ['a primary press on the shown row closes', { key: 'a:1', detailKey: 'a:1', button: 0, onControl: false }, 'close'],
    ['a primary press on another row opens', { key: 'a:2', detailKey: 'a:1', button: 0, onControl: false }, 'open'],
    ['a primary press with nothing shown opens', { key: 'a:1', detailKey: null, button: 0, onControl: false }, 'open'],
  ] as const)('%s', (_name, press, expected) => {
    expect(backlogRowPress(press)).toBe(expected)
  })
})

describe('findEpicGroup', () => {
  const epic = epicGroup(A, 41)
  const inner = epicGroup(A, 48)
  const groups: BacklogGroupView[] = [loaded(A, epic), loaded(A, epicGroup(A, 50, [inner])), { kind: 'loading', repoId: B, repo: 'b' }]

  it.each([
    ['an epic in a loaded group', A, 41, epic],
    ['a nested epic', A, 48, inner],
    ['a regular row', A, 7, null],
    ['another repository', B, 41, null],
  ])('finds %s', (_name, repoId, number, expected) => {
    expect(findEpicGroup(groups, repoId, number)).toBe(expected)
  })
})

describe('linkListView', () => {
  it.each([
    ['a failed read', { ok: false, reason: 'boom' }, { kind: 'failed', reason: 'boom' }],
    ['an empty list', { ok: true, items: [], total: 0 }, { kind: 'none' }],
    ['closed items in order', { ok: true, items: [link(43), link(40, 'CLOSED')], total: 2 }, { kind: 'links', items: [{ number: 43, title: 'Ticket 43', url: 'https://example.test/43', closed: false }, { number: 40, title: 'Ticket 40', url: 'https://example.test/40', closed: true }], more: 0 }],
  ] as const)('reads %s', (_name, input, expected) => {
    expect(linkListView(input as never)).toEqual(expected)
  })

  it.each([
    ['links the page did not hold', 4, 2],
    ['never a negative remainder', 1, 0],
  ])('counts %s', (_name, total, more) => {
    expect(linkListView({ ok: true, items: [link(43), link(40)], total })).toMatchObject({ kind: 'links', more })
  })
})

describe('assigneeView', () => {
  it.each([
    [[], { kind: 'unassigned' }],
    [['bob'], { kind: 'people', text: 'bob' }],
    [['bob', 'alice'], { kind: 'people', text: 'bob, alice' }],
  ])('reads %j', (people, expected) => {
    expect(assigneeView(people)).toEqual(expected)
  })
})

describe('epicSummaryView', () => {
  const child = (number: number) => ({ number, title: `Ticket ${String(number)}`, state: 'OPEN' as const, claimed: false, blockers: { ok: true as const, open: [], closed: [], shown: 0, total: 0 } })
  const summary = { ok: true as const, wavesMayShift: false, done: 1, inProgress: 2, open: 3, total: 6, canStart: [child(44), child(46)], truncated: null, uncertain: [], cycles: [] }

  it('keeps the counts and can-start order, linking each ticket beside the epic', () => {
    expect(epicSummaryView(summary, 'https://github.com/acme/widgets/issues/41')).toEqual({
      ok: true,
      done: 1,
      total: 6,
      inProgress: 2,
      canStart: [
        { number: 44, title: 'Ticket 44', url: 'https://github.com/acme/widgets/issues/44' },
        { number: 46, title: 'Ticket 46', url: 'https://github.com/acme/widgets/issues/46' },
      ],
      truncated: null,
    })
  })

  it('passes truncation and a failed read through', () => {
    expect(epicSummaryView({ ...summary, truncated: { shown: 50, total: 70 } }, 'u/1')).toMatchObject({ truncated: { shown: 50, total: 70 } })
    expect(epicSummaryView({ ok: false, reason: 'no sub-issues' }, 'u/1')).toEqual({ ok: false, reason: 'no sub-issues' })
  })
})
