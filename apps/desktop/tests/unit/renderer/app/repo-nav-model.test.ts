import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { REPO_SCREENS, activeRepoScreen, railRepoOf } from '@/renderer/app/repo-nav-model'

const id = (value: string) => value as RepoId

describe('REPO_SCREENS', () => {
  it('lists the four screens in sidebar order', () => {
    expect(REPO_SCREENS.map((screen) => [screen.key, screen.to, screen.label])).toEqual([
      ['board', '/board', 'Board'],
      ['needsYou', '/needs-you', 'Needs you'],
      ['backlog', '/backlog', 'Backlog'],
      ['releases', '/releases', 'Releases'],
    ])
  })
})

describe('activeRepoScreen', () => {
  it.each([
    ['/board', 'board'],
    ['/needs-you', 'needsYou'],
    ['/backlog', 'backlog'],
    ['/releases', 'releases'],
  ])('reads %s scoped to a repo as the %s screen', (pathname, screen) => {
    expect(activeRepoScreen(pathname, id('repo-a'))).toEqual({ repoId: 'repo-a', screen })
  })

  it('is null without a repo in the search', () => {
    expect(activeRepoScreen('/board', null)).toBeNull()
    expect(activeRepoScreen('/board', undefined)).toBeNull()
  })

  it('is null for a route that is not a repo screen', () => {
    expect(activeRepoScreen('/settings', id('repo-a'))).toBeNull()
    expect(activeRepoScreen('/session', id('repo-a'))).toBeNull()
  })
})

describe('railRepoOf', () => {
  const ready = [id('repo-a'), id('repo-b'), id('repo-c')]

  it('prefers the route repo', () => {
    expect(railRepoOf({ routeRepo: id('repo-b'), openSessionRepo: id('repo-c'), lastRepo: 'repo-a', readyRepoIds: ready })).toBe('repo-b')
  })

  it('falls back to the open session repo, then the last repo', () => {
    expect(railRepoOf({ routeRepo: null, openSessionRepo: id('repo-c'), lastRepo: 'repo-b', readyRepoIds: ready })).toBe('repo-c')
    expect(railRepoOf({ routeRepo: null, openSessionRepo: null, lastRepo: 'repo-b', readyRepoIds: ready })).toBe('repo-b')
  })

  it('skips a candidate that is not a ready repository', () => {
    expect(railRepoOf({ routeRepo: id('gone'), openSessionRepo: id('repo-c'), lastRepo: null, readyRepoIds: ready })).toBe('repo-c')
    expect(railRepoOf({ routeRepo: null, openSessionRepo: null, lastRepo: 'gone', readyRepoIds: ready })).toBe('repo-a')
  })

  it('falls back to the first ready repository', () => {
    expect(railRepoOf({ routeRepo: null, openSessionRepo: null, lastRepo: null, readyRepoIds: ready })).toBe('repo-a')
  })

  it('is null with no ready repository', () => {
    expect(railRepoOf({ routeRepo: id('repo-a'), openSessionRepo: null, lastRepo: 'repo-a', readyRepoIds: [] })).toBeNull()
  })
})
