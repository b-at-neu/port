import { describe, expect, it } from 'vitest'
import { boardSearchFromRaw, historySearchFromRaw, repoSearchFromRaw, searchSearchFromRaw, sessionSearchFromRaw, transcriptSearchFromRaw } from './routes'

describe('transcriptSearchFromRaw', () => {
  it('reads an invalid focusIndex as null', () => {
    expect(transcriptSearchFromRaw({ focusIndex: 'three' }).focusIndex).toBeNull()
    expect(transcriptSearchFromRaw({ focusIndex: Number.NaN }).focusIndex).toBeNull()
    expect(transcriptSearchFromRaw({}).focusIndex).toBeNull()
  })

  it('keeps a valid focusIndex', () => {
    expect(transcriptSearchFromRaw({ focusIndex: 7 }).focusIndex).toBe(7)
  })

  it('reads an invalid from as history', () => {
    expect(transcriptSearchFromRaw({ from: 'nowhere' }).from).toBe('history')
    expect(transcriptSearchFromRaw({ from: 'search' }).from).toBe('search')
  })

  it('reads a non-string agentId/title as null/empty', () => {
    expect(transcriptSearchFromRaw({ agentId: 42 }).agentId).toBeNull()
    expect(transcriptSearchFromRaw({ title: 42 }).title).toBe('')
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

describe('historySearchFromRaw', () => {
  it('reads a repo filter, null when absent or empty', () => {
    expect(historySearchFromRaw({ repo: 'repo-a' }).repo).toBe('repo-a')
    expect(historySearchFromRaw({}).repo).toBeNull()
    expect(historySearchFromRaw({ repo: '' }).repo).toBeNull()
  })
})

describe('searchSearchFromRaw', () => {
  it('reads a repo filter, null when absent or empty', () => {
    expect(searchSearchFromRaw({ repo: 'repo-a' }).repo).toBe('repo-a')
    expect(searchSearchFromRaw({}).repo).toBeNull()
  })
})

describe('sessionSearchFromRaw', () => {
  it('reads a key, null when absent or empty', () => {
    expect(sessionSearchFromRaw({ key: 'hosted-1' }).key).toBe('hosted-1')
    expect(sessionSearchFromRaw({}).key).toBeNull()
    expect(sessionSearchFromRaw({ key: '' }).key).toBeNull()
  })
})
