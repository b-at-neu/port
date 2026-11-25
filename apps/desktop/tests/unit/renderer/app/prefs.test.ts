import { describe, expect, it } from 'vitest'
import { parseShellPrefs, restoreHashOf } from '@/renderer/app/prefs'

describe('parseShellPrefs lastRepo', () => {
  it('keeps a stored repo id', () => {
    expect(parseShellPrefs(JSON.stringify({ lastRepo: 'repo-a' })).lastRepo).toBe('repo-a')
  })

  it.each([undefined, '', 3, null, ['repo-a'], { id: 'repo-a' }])('reads %j as null', (lastRepo) => {
    expect(parseShellPrefs(JSON.stringify({ lastRepo })).lastRepo).toBeNull()
  })

  it('defaults to null with nothing stored or unparseable input', () => {
    expect(parseShellPrefs(null).lastRepo).toBeNull()
    expect(parseShellPrefs('{not json').lastRepo).toBeNull()
  })
})

describe('restoreHashOf', () => {
  it('restores a repo screen scoped to its repository', () => {
    expect(restoreHashOf({ lastRoute: '/backlog', lastRepo: 'repo-a' })).toBe('#/backlog?repo=repo-a')
  })

  it('encodes the repository id', () => {
    expect(restoreHashOf({ lastRoute: '/board', lastRepo: 'a b&c' })).toBe('#/board?repo=a%20b%26c')
  })

  it('restores a repo screen bare when no repository was seen', () => {
    expect(restoreHashOf({ lastRoute: '/releases', lastRepo: null })).toBe('#/releases')
  })

  it('restores any other route bare, whatever the last repository', () => {
    expect(restoreHashOf({ lastRoute: '/settings', lastRepo: 'repo-a' })).toBe('#/settings')
  })

  it('is null with no last route', () => {
    expect(restoreHashOf({ lastRoute: null, lastRepo: 'repo-a' })).toBeNull()
  })
})
