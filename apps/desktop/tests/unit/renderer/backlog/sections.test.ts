import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogEpicGroup, BacklogEpicLayout, BacklogGroupView, BacklogRowView, BacklogWave } from '@/types/backlog'
import { navigableRows, repoFilterCount, rowKey, toggleHiddenRepo, visibleRepos } from '@/renderer/backlog/sections'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const C = 'repo-c' as RepoId
const REPOS = [{ id: A }, { id: B }, { id: C }]

const row = (repoId: RepoId, number: number): BacklogRowView => ({ repoId, number }) as BacklogRowView
const wave = (number: number, rows: BacklogRowView[]): BacklogWave => ({ number, rows })
const epic = (number: number, waves: BacklogWave[], unplaced: BacklogRowView[] = [], epics: BacklogEpicGroup[] = [], start = 1): BacklogEpicGroup => ({ epic: row(A, number), start, waves, epics, unplaced, summary: { ok: false, reason: 'x' } })

function loaded(repoId: RepoId, layout: BacklogEpicLayout): BacklogGroupView {
  return { kind: 'loaded', repoId, repo: String(repoId), items: [], totalCount: 0, labelOptions: [], truncatedNote: null, layout }
}

const flat = (repoId: RepoId, ...numbers: number[]): BacklogGroupView => loaded(repoId, { entries: numbers.map((n) => ({ kind: 'row', row: row(repoId, n) })) })

const EPIC_LAYOUT = loaded(A, { entries: [{ kind: 'row', row: row(A, 120) }, { kind: 'epic', group: epic(100, [wave(1, [row(A, 101)]), wave(3, [row(A, 103)])], [row(A, 104)]) }, { kind: 'row', row: row(A, 110) }] })
const NESTED_LAYOUT = loaded(A, { entries: [{ kind: 'epic', group: epic(100, [wave(1, [row(A, 101)]), wave(4, [row(A, 103)])], [], [epic(200, [wave(2, [row(A, 201)]), wave(3, [row(A, 202)])], [], [], 2)]) }, { kind: 'row', row: row(A, 110) }] })

describe('repository filter', () => {
  it('keeps registry order, drops hidden ids and toggles without mutating', () => {
    expect(visibleRepos(REPOS, new Set([B])).map((r) => r.id)).toEqual([A, C])
    const empty: ReadonlySet<RepoId> = new Set()
    const hidden = toggleHiddenRepo(empty, A)
    expect([...hidden]).toEqual([A])
    expect(empty.size).toBe(0)
    expect(toggleHiddenRepo(hidden, A).size).toBe(0)
  })

  it.each([
    ['some hidden', new Set([A]), 2],
    ['a stale hidden id', new Set(['gone' as RepoId]), 3],
    ['every repository hidden', new Set([A, B, C]), 0],
  ])('counts shown with %s', (_name, hidden, shown) => {
    expect(repoFilterCount(REPOS, hidden)).toEqual({ shown, total: 3 })
  })

  it('joins the repository id and the number into a row key', () => {
    expect(rowKey(A, 41)).toBe('repo-a:41')
  })
})

describe('navigableRows', () => {
  const none = new Set<string>()
  const numbers = (groups: BacklogGroupView[], collapsed: ReadonlySet<RepoId> = new Set(), collapsedEpics: ReadonlySet<string> = none) => navigableRows(groups, collapsed, collapsedEpics).map((r) => r.number)

  it.each([
    ['loaded rows in group order', [flat(A, 1, 2), flat(B, 3)], new Set<RepoId>(), none, [1, 2, 3]],
    ['not collapsed groups only', [flat(A, 1, 2), flat(B, 3)], new Set([A]), none, [3]],
    ['not-loaded groups skipped', [{ kind: 'loading', repoId: A, repo: 'a' }, { kind: 'invoke-error', repoId: B, repo: 'b', message: 'x' }, flat(C, 9)] as BacklogGroupView[], new Set<RepoId>(), none, [9]],
    ['an epic then its wave and unplaced rows', [EPIC_LAYOUT], new Set<RepoId>(), none, [120, 100, 101, 103, 104, 110]],
    ['a collapsed epic as its own row', [EPIC_LAYOUT], new Set<RepoId>(), new Set([rowKey(A, 100)]), [120, 100, 110]],
    ['nothing for a collapsed repository', [EPIC_LAYOUT], new Set([A]), none, []],
    ['a nested epic in body order', [NESTED_LAYOUT], new Set<RepoId>(), none, [100, 101, 200, 201, 202, 103, 110]],
    ['a collapsed nested epic as its own row', [NESTED_LAYOUT], new Set<RepoId>(), new Set([rowKey(A, 200)]), [100, 101, 200, 103, 110]],
    ['a nested epic hidden by its collapsed parent', [NESTED_LAYOUT], new Set<RepoId>(), new Set([rowKey(A, 100)]), [100, 110]],
  ])('lists %s', (_name, groups, collapsed, collapsedEpics, expected) => {
    expect(numbers(groups, collapsed, collapsedEpics)).toEqual(expected)
  })
})
