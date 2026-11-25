import { describe, expect, it } from 'vitest'
import type { ReposListResponse } from '@/types/ipc'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { backlogPageState, backlogView } from '@/renderer/backlog/model'
import { readyEntry } from '../../../support/repo-config'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const NOT_READY = { id: 'repo-c' as RepoId, displayName: 'acme/broken', status: 'unreadable' } as unknown as RepositoryEntry

const ready = (...ids: RepoId[]): ReposListResponse => ({ ok: true, repositories: ids.map((id) => ({ ...readyEntry(), id })) })
const none = new Set<RepoId>()

describe('backlogView body', () => {
  it.each<readonly [string, ReposListResponse | undefined, RepoId | null, ReadonlySet<RepoId>, string]>([
    ['normal', ready(A, B), null, none, 'groups'],
    ['no ready repositories', ready(), null, none, 'no-repos'],
    ['only a not-ready repository', { ok: true, repositories: [NOT_READY] }, null, none, 'no-repos'],
    ['an unknown scoped id', ready(A), 'gone' as RepoId, none, 'unknown-repo'],
    ['a scoped not-ready repository', { ok: true, repositories: [readyEntry(), NOT_READY] }, NOT_READY.id, none, 'scoped-not-ready'],
    ['everything hidden', ready(A, B), null, new Set([A, B]), 'all-hidden'],
    ['a scoped repository, whatever is hidden', ready(A, B), A, new Set([A]), 'groups'],
    ['an unread list', undefined, null, none, 'no-repos'],
  ])('is decided by %s', (_name, reposData, scopedRepo, hidden, body) => {
    expect(backlogView({ reposData, scopedRepo, hidden }).body.kind).toBe(body)
  })

  it('lists not-ready repositories only for the scoped one when scoped', () => {
    const reposData: ReposListResponse = { ok: true, repositories: [{ ...readyEntry(), id: A }, NOT_READY] }
    expect(backlogView({ reposData, scopedRepo: null, hidden: none }).notReadyRepos).toEqual([NOT_READY])
    expect(backlogView({ reposData, scopedRepo: A, hidden: none }).notReadyRepos).toEqual([])
  })
})

describe('backlogPageState', () => {
  const view = backlogView({ reposData: ready(A), scopedRepo: null, hidden: none })
  const empty = backlogView({ reposData: ready(), scopedRepo: null, hidden: none })

  it.each([
    ['pending', { data: undefined, status: 'pending' }, view, 'loading'],
    ['a rejected query with no data', { data: undefined, status: 'error' }, view, 'error'],
    ['an ok:false reply', { data: { ok: false, kind: 'unreadable', message: 'bad json' }, status: 'success' }, view, 'error'],
    ['data in hand beating a refetch error', { data: ready(A), status: 'error' }, view, 'ready'],
    ['an empty body', { data: ready(), status: 'success' }, empty, 'empty'],
  ] as unknown as ReadonlyArray<readonly [string, Parameters<typeof backlogPageState>[0], ReturnType<typeof backlogView>, string]>)('is %s', (_name, query, built, state) => {
    expect(backlogPageState(query, built).state).toBe(state)
  })

  it('names the reason only for an unreadable list', () => {
    const reply = { data: { ok: false, kind: 'unreadable', message: 'bad json' }, status: 'success' } as unknown as Parameters<typeof backlogPageState>[0]
    expect(backlogPageState(reply, view).errorMessage).toContain('bad json')
    expect(backlogPageState({ data: undefined, status: 'pending' }, view).errorMessage).toBe('')
  })
})
