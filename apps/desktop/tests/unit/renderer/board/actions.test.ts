import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ItemActionState } from '@/types/board'
import type { RepositoryState } from '@/types/state'
import { withoutGone } from '@/renderer/board/actions'
import { boardSnapshot, reconciledItem, repositoryState } from '../../../support/board-snapshot'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const PENDING: ItemActionState = { kind: 'pending', action: 'pause' }

function readyRepo(repoId: RepoId, numbers: readonly number[]): RepositoryState {
  return repositoryState(
    numbers.map((number) => reconciledItem({ repoId, number })),
    { repoId },
  )
}

const NOT_READY = { ok: false, reason: 'not-ready', repoId: A, displayName: 'o/a' } as unknown as RepositoryState

describe('withoutGone', () => {
  it.each([
    { name: 'an empty map', keys: [], repos: [readyRepo(A, [1])], kept: [], same: true },
    { name: 'every item still on the board', keys: ['repo-a#1', 'repo-a#2'], repos: [readyRepo(A, [1, 2])], kept: ['repo-a#1', 'repo-a#2'], same: true },
    { name: 'one item gone', keys: ['repo-a#1', 'repo-a#2'], repos: [readyRepo(A, [1])], kept: ['repo-a#1'], same: false },
    { name: 'an item in a repository that is not ready', keys: ['repo-a#1'], repos: [NOT_READY], kept: [], same: false },
    { name: 'the same number in two repositories', keys: ['repo-a#1', 'repo-b#1'], repos: [readyRepo(A, [1]), readyRepo(B, [])], kept: ['repo-a#1'], same: false },
  ])('$name', ({ keys, repos, kept, same }) => {
    const current: ReadonlyMap<string, ItemActionState> = new Map(keys.map((key) => [key, PENDING]))
    const next = withoutGone(current, boardSnapshot(repos))
    expect([...next.keys()]).toEqual(kept)
    expect(next === current).toBe(same)
  })
})
