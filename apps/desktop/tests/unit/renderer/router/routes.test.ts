import { describe, expect, it } from 'vitest'
import { boardSearchFromRaw, historySearchFromRaw, needsYouSearchFromRaw, repoSearchFromRaw, searchSearchFromRaw, sessionSearchFromRaw, settingsSearchFromRaw, transcriptSearchFromRaw } from '@/renderer/router/routes'

describe('settingsSearchFromRaw', () => {
  it.each(['general', 'repositories', 'connections', 'pipeline', 'usage', 'about'])('keeps the %s section', (section) => {
    expect(settingsSearchFromRaw({ section })).toEqual({ section })
  })

  it.each([undefined, '', 'nope', 3, null])('reads %j as general', (section) => {
    expect(settingsSearchFromRaw({ section })).toEqual({ section: 'general' })
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

  it('reads an invalid from as history', () => {
    expect(transcriptSearchFromRaw({ from: 'nowhere' }).from).toBe('history')
    expect(transcriptSearchFromRaw({ from: 'search' }).from).toBe('search')
    expect(transcriptSearchFromRaw({ from: 'pipeline' }).from).toBe('pipeline')
  })

  it('reads a non-string agentId/title as null/empty', () => {
    expect(transcriptSearchFromRaw({ agentId: 42 }).agentId).toBeNull()
    expect(transcriptSearchFromRaw({ title: 42 }).title).toBe('')
  })

  it('parses a valid item ref, null when malformed or absent', () => {
    expect(transcriptSearchFromRaw({ item: 'repo-a:41' }).item).toEqual({ repoId: 'repo-a', number: 41 })
    expect(transcriptSearchFromRaw({ item: 'not-an-item-ref' }).item).toBeNull()
    expect(transcriptSearchFromRaw({}).item).toBeNull()
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

  it('defaults the Denials tab grouping to command, accepts actor', () => {
    expect(repoSearchFromRaw({}).denialsGroup).toBe('command')
    expect(repoSearchFromRaw({ denialsGroup: 'actor' }).denialsGroup).toBe('actor')
    expect(repoSearchFromRaw({ denialsGroup: 'nonsense' }).denialsGroup).toBe('command')
  })
})

describe('historySearchFromRaw', () => {
  it('reads a repo filter, null when absent or empty', () => {
    expect(historySearchFromRaw({ repo: 'repo-a' }).repo).toBe('repo-a')
    expect(historySearchFromRaw({}).repo).toBeNull()
    expect(historySearchFromRaw({ repo: '' }).repo).toBeNull()
  })

  it('reads archived=true only, anything else as false', () => {
    expect(historySearchFromRaw({ archived: true }).archived).toBe(true)
    expect(historySearchFromRaw({}).archived).toBe(false)
    expect(historySearchFromRaw({ archived: 'true' }).archived).toBe(false)
    expect(historySearchFromRaw({ archived: false }).archived).toBe(false)
  })
})

describe('needsYouSearchFromRaw', () => {
  it('keeps a non-empty focus key', () => {
    expect(needsYouSearchFromRaw({ focus: 'plan-review:repo-a:552:2026-01-01T00:00:00Z' }).focus).toBe('plan-review:repo-a:552:2026-01-01T00:00:00Z')
  })

  it('reads an absent, empty or non-string focus as null', () => {
    expect(needsYouSearchFromRaw({}).focus).toBeNull()
    expect(needsYouSearchFromRaw({ focus: '' }).focus).toBeNull()
    expect(needsYouSearchFromRaw({ focus: 7 }).focus).toBeNull()
    expect(needsYouSearchFromRaw({ focus: { key: 'x' } }).focus).toBeNull()
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

  it('reads pane=changes, null for anything else', () => {
    expect(sessionSearchFromRaw({ pane: 'changes' }).pane).toBe('changes')
    expect(sessionSearchFromRaw({}).pane).toBeNull()
    expect(sessionSearchFromRaw({ pane: '' }).pane).toBeNull()
    expect(sessionSearchFromRaw({ pane: 'CHANGES' }).pane).toBeNull()
    expect(sessionSearchFromRaw({ pane: 'diff' }).pane).toBeNull()
    expect(sessionSearchFromRaw({ pane: 42 }).pane).toBeNull()
    expect(sessionSearchFromRaw({ pane: { kind: 'changes' } }).pane).toBeNull()
  })
})
