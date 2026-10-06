import { describe, expect, it } from 'vitest'
import { ROUTE_IDS, containerFor, isReactScreen, routeForView, transcriptSearchFromRaw, viewFromMatch } from './legacy-view'
import type { View } from './legacy-view'
import type { RepoId } from '../../../shared/repos'

const REPO_ID = 'repo-1' as RepoId

const VIEWS: readonly View[] = [
  { screen: 'board' },
  { screen: 'repos' },
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
    expect(containerFor({ screen: 'board' })).toBe('board')
    expect(containerFor({ screen: 'repos' })).toBe('repositories')
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
    expect(isReactScreen({ screen: 'board' })).toBe(false)
    expect(isReactScreen({ screen: 'session' })).toBe(false)
  })
})
