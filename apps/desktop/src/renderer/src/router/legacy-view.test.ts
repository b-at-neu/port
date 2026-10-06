import { describe, expect, it } from 'vitest'
import { ROUTE_IDS, boardSearchFromRaw, containerFor, isReactScreen, repoSearchFromRaw, routeForView, transcriptSearchFromRaw, viewFromMatch } from './legacy-view'
import type { View } from './legacy-view'
import type { RepoId } from '../../../shared/repos'

const REPO_ID = 'repo-1' as RepoId

const VIEWS: readonly View[] = [
  { screen: 'board' },
  { screen: 'repos' },
  { screen: 'repo', repoId: REPO_ID, tab: 'overview' },
  { screen: 'repo', repoId: REPO_ID, tab: 'worktrees' },
  { screen: 'sessions', repoId: REPO_ID },
  { screen: 'search', repoId: REPO_ID },
  { screen: 'transcript', sessionId: 'sess-1', agentId: 'agent-1', title: 'My session', from: 'search', focusIndex: 3 },
  { screen: 'transcript', sessionId: 'sess-2', agentId: null, title: 'Other', from: 'sessions', focusIndex: null },
  { screen: 'session' },
  { screen: 'settings' },
  { screen: 'backlog' },
  { screen: 'setup' },
  { screen: 'about' },
]

describe('routeForView / viewFromMatch round trip', () => {
  for (const view of VIEWS) {
    it(`round-trips ${view.screen}`, () => {
      const route = routeForView(view)
      const result = viewFromMatch(route.to, route.params ?? {}, route.search ?? {})
      expect(result).toEqual(view)
    })
  }
})

describe('viewFromMatch', () => {
  it('falls back to board for an unrecognized routeId', () => {
    expect(viewFromMatch('/not-a-route', {}, {})).toEqual({ screen: 'board' })
  })

  it('falls back to an empty repoId/sessionId rather than throwing on a missing param', () => {
    expect(viewFromMatch(ROUTE_IDS.sessions, {}, {})).toEqual({ screen: 'sessions', repoId: '' })
    expect(viewFromMatch(ROUTE_IDS.transcript, {}, {})).toMatchObject({ screen: 'transcript', sessionId: '' })
  })
})

describe('transcriptSearchFromRaw', () => {
  it('reads an invalid focusIndex as null', () => {
    expect(transcriptSearchFromRaw({ focusIndex: 'three' }).focusIndex).toBeNull()
    expect(transcriptSearchFromRaw({ focusIndex: Number.NaN }).focusIndex).toBeNull()
    expect(transcriptSearchFromRaw({}).focusIndex).toBeNull()
  })

  it('keeps a valid focusIndex', () => {
    expect(transcriptSearchFromRaw({ focusIndex: 7 }).focusIndex).toBe(7)
  })

  it('reads an invalid from as sessions', () => {
    expect(transcriptSearchFromRaw({ from: 'nowhere' }).from).toBe('sessions')
    expect(transcriptSearchFromRaw({ from: 'search' }).from).toBe('search')
  })

  it('reads a non-string agentId/title as null/empty', () => {
    expect(transcriptSearchFromRaw({ agentId: 42 }).agentId).toBeNull()
    expect(transcriptSearchFromRaw({ title: 42 }).title).toBe('')
  })
})

describe('containerFor', () => {
  it('maps every screen to its legacy container', () => {
    expect(containerFor({ screen: 'board' })).toBe('react')
    expect(containerFor({ screen: 'repos' })).toBe('react')
    expect(containerFor({ screen: 'repo', repoId: REPO_ID, tab: 'overview' })).toBe('react')
    expect(containerFor({ screen: 'sessions', repoId: REPO_ID })).toBe('repositories')
    expect(containerFor({ screen: 'search', repoId: REPO_ID })).toBe('repositories')
    expect(containerFor({ screen: 'transcript', sessionId: 's', agentId: null, title: '', from: 'sessions', focusIndex: null })).toBe('repositories')
    expect(containerFor({ screen: 'session' })).toBe('session')
    expect(containerFor({ screen: 'settings' })).toBe('react')
    expect(containerFor({ screen: 'backlog' })).toBe('react')
    expect(containerFor({ screen: 'setup' })).toBe('react')
    expect(containerFor({ screen: 'about' })).toBe('react')
  })
})

describe('isReactScreen', () => {
  it('is true for every React screen, false for every legacy one', () => {
    expect(isReactScreen({ screen: 'settings' })).toBe(true)
    expect(isReactScreen({ screen: 'backlog' })).toBe(true)
    expect(isReactScreen({ screen: 'setup' })).toBe(true)
    expect(isReactScreen({ screen: 'about' })).toBe(true)
    expect(isReactScreen({ screen: 'board' })).toBe(true)
    expect(isReactScreen({ screen: 'repos' })).toBe(true)
    expect(isReactScreen({ screen: 'repo', repoId: REPO_ID, tab: 'overview' })).toBe(true)
    expect(isReactScreen({ screen: 'session' })).toBe(false)
    expect(isReactScreen({ screen: 'sessions', repoId: REPO_ID })).toBe(false)
  })
})

describe('boardSearchFromRaw', () => {
  it('parses a valid item ref', () => {
    expect(boardSearchFromRaw({ item: 'repo-a:41' })).toEqual({ item: { repoId: 'repo-a', number: 41 }, group: 'phase', repo: null })
  })

  it('falls back to no selection for a malformed or absent item', () => {
    expect(boardSearchFromRaw({ item: 'not-an-item-ref' }).item).toBeNull()
    expect(boardSearchFromRaw({}).item).toBeNull()
  })

  it('defaults group to phase, accepts repo', () => {
    expect(boardSearchFromRaw({}).group).toBe('phase')
    expect(boardSearchFromRaw({ group: 'repo' }).group).toBe('repo')
    expect(boardSearchFromRaw({ group: 'nonsense' }).group).toBe('phase')
  })

  it('reads a repo filter, null when absent or empty', () => {
    expect(boardSearchFromRaw({ repo: 'repo-a' }).repo).toBe('repo-a')
    expect(boardSearchFromRaw({}).repo).toBeNull()
    expect(boardSearchFromRaw({ repo: '' }).repo).toBeNull()
  })
})

describe('repoSearchFromRaw', () => {
  it('defaults to overview, accepts worktrees and denials', () => {
    expect(repoSearchFromRaw({}).tab).toBe('overview')
    expect(repoSearchFromRaw({ tab: 'worktrees' }).tab).toBe('worktrees')
    expect(repoSearchFromRaw({ tab: 'denials' }).tab).toBe('denials')
    expect(repoSearchFromRaw({ tab: 'nonsense' }).tab).toBe('overview')
  })
})
