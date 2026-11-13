import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogGroupView, BacklogRowView } from '@/types/backlog'
import { navigableRows, repoFilterCount, toggleHiddenRepo, visibleRepos } from '@/renderer/backlog/sections'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const C = 'repo-c' as RepoId
const REPOS = [{ id: A }, { id: B }, { id: C }]

function row(repoId: RepoId, number: number): BacklogRowView {
  return { repoId, number } as BacklogRowView
}

function loaded(repoId: RepoId, numbers: readonly number[]): BacklogGroupView {
  return { kind: 'loaded', repoId, repo: String(repoId), items: numbers.map((n) => row(repoId, n)), totalCount: numbers.length, labelOptions: [], truncatedNote: null }
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

describe('navigableRows', () => {
  it('lists loaded rows in group order', () => {
    expect(navigableRows([loaded(A, [1, 2]), loaded(B, [3])], new Set()).map((r) => r.number)).toEqual([1, 2, 3])
  })

  it('skips collapsed groups', () => {
    expect(navigableRows([loaded(A, [1, 2]), loaded(B, [3])], new Set([A])).map((r) => r.number)).toEqual([3])
  })

  it('skips groups that are not loaded', () => {
    const groups: BacklogGroupView[] = [{ kind: 'loading', repoId: A, repo: 'a' }, { kind: 'invoke-error', repoId: B, repo: 'b', message: 'x' }, loaded(C, [9])]
    expect(navigableRows(groups, new Set()).map((r) => r.number)).toEqual([9])
  })
})
