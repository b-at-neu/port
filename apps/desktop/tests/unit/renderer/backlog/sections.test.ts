import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogEpicGroup, BacklogEpicLayout, BacklogGroupView, BacklogRowView, BacklogWave } from '@/types/backlog'
import { navigableRows, repoFilterCount, rowKey, toggleHiddenRepo, visibleRepos } from '@/renderer/backlog/sections'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const C = 'repo-c' as RepoId
const REPOS = [{ id: A }, { id: B }, { id: C }]

function row(repoId: RepoId, number: number): BacklogRowView {
  return { repoId, number } as BacklogRowView
}

function loaded(repoId: RepoId, numbers: readonly number[], layout: BacklogEpicLayout = { entries: numbers.map((n) => ({ kind: 'row', row: row(repoId, n) })) }): BacklogGroupView {
  return { kind: 'loaded', repoId, repo: String(repoId), items: numbers.map((n) => row(repoId, n)), totalCount: numbers.length, labelOptions: [], truncatedNote: null, layout }
}

function wave(number: number, rows: BacklogRowView[]): BacklogWave {
  return { number, rows }
}

function epic(repoId: RepoId, number: number, waves: BacklogWave[], unplaced: BacklogRowView[] = [], epics: BacklogEpicGroup[] = [], start = 1): BacklogEpicGroup {
  return { epic: row(repoId, number), start, waves, epics, unplaced, summary: { ok: false, reason: 'x' } }
}

const EPIC_LAYOUT: BacklogEpicLayout = {
  entries: [
    { kind: 'row', row: row(A, 120) },
    { kind: 'epic', group: epic(A, 100, [wave(1, [row(A, 101)]), wave(3, [row(A, 103)])], [row(A, 104)]) },
    { kind: 'row', row: row(A, 110) },
  ],
}

const NESTED_LAYOUT: BacklogEpicLayout = {
  entries: [
    {
      kind: 'epic',
      group: epic(A, 100, [wave(1, [row(A, 101)]), wave(4, [row(A, 103)])], [], [epic(A, 200, [wave(2, [row(A, 201)]), wave(3, [row(A, 202)])], [], [], 2)]),
    },
    { kind: 'row', row: row(A, 110) },
  ],
}

describe('visibleRepos', () => {
  it('keeps registry order and drops hidden ids', () => {
    expect(visibleRepos(REPOS, new Set([B])).map((r) => r.id)).toEqual([A, C])
  })

  it('shows everything when nothing is hidden', () => {
    expect(visibleRepos(REPOS, new Set())).toEqual(REPOS)
  })
})

describe('toggleHiddenRepo', () => {
  it('hides a shown repository and restores a hidden one without mutating', () => {
    const empty: ReadonlySet<RepoId> = new Set()
    const hidden = toggleHiddenRepo(empty, A)
    expect([...hidden]).toEqual([A])
    expect(empty.size).toBe(0)
    expect(toggleHiddenRepo(hidden, A).size).toBe(0)
  })
})

describe('repoFilterCount', () => {
  it('counts shown against total', () => {
    expect(repoFilterCount(REPOS, new Set([A]))).toEqual({ shown: 2, total: 3 })
  })

  it('ignores a stale hidden id that is no longer registered', () => {
    expect(repoFilterCount(REPOS, new Set(['gone' as RepoId]))).toEqual({ shown: 3, total: 3 })
  })

  it('reports zero shown when every repository is hidden', () => {
    expect(repoFilterCount(REPOS, new Set([A, B, C])).shown).toBe(0)
  })
})

describe('rowKey', () => {
  it('joins the repository id and the number', () => {
    expect(rowKey(A, 41)).toBe('repo-a:41')
  })
})

describe('navigableRows', () => {
  const none = new Set<string>()

  it('lists loaded rows in group order', () => {
    expect(navigableRows([loaded(A, [1, 2]), loaded(B, [3])], new Set(), none).map((r) => r.number)).toEqual([1, 2, 3])
  })

  it('skips collapsed groups', () => {
    expect(navigableRows([loaded(A, [1, 2]), loaded(B, [3])], new Set([A]), none).map((r) => r.number)).toEqual([3])
  })

  it('skips groups that are not loaded', () => {
    const groups: BacklogGroupView[] = [{ kind: 'loading', repoId: A, repo: 'a' }, { kind: 'invoke-error', repoId: B, repo: 'b', message: 'x' }, loaded(C, [9])]
    expect(navigableRows(groups, new Set(), none).map((r) => r.number)).toEqual([9])
  })

  it('walks entries in order, an epic then its wave rows and unplaced rows', () => {
    const groups = [loaded(A, [], EPIC_LAYOUT)]
    expect(navigableRows(groups, new Set(), none).map((r) => r.number)).toEqual([120, 100, 101, 103, 104, 110])
  })

  it('walks a nested epic in body order', () => {
    expect(navigableRows([loaded(A, [], NESTED_LAYOUT)], new Set(), none).map((r) => r.number)).toEqual([100, 101, 200, 201, 202, 103, 110])
  })

  it('contributes only the row for a collapsed nested epic', () => {
    expect(navigableRows([loaded(A, [], NESTED_LAYOUT)], new Set(), new Set([rowKey(A, 200)])).map((r) => r.number)).toEqual([100, 101, 200, 103, 110])
  })

  it('hides a nested epic with its collapsed parent', () => {
    expect(navigableRows([loaded(A, [], NESTED_LAYOUT)], new Set(), new Set([rowKey(A, 100)])).map((r) => r.number)).toEqual([100, 110])
  })

  it('contributes only the epic row for a collapsed epic, in the middle of the list', () => {
    const groups = [loaded(A, [], EPIC_LAYOUT)]
    expect(navigableRows(groups, new Set(), new Set([rowKey(A, 100)])).map((r) => r.number)).toEqual([120, 100, 110])
  })

  it('contributes nothing for a collapsed repository, whatever its epics', () => {
    expect(navigableRows([loaded(A, [], EPIC_LAYOUT)], new Set([A]), none)).toEqual([])
  })
})
