import { describe, expect, it } from 'vitest'
import { emptyCopy, errorCopy, footnotes, kindChip, summaryLine, TOO_SHORT_COPY } from './copy'
import type { SearchHit, SearchResult } from '../../../shared/search/types'

function hit(overrides: Partial<SearchHit>): SearchHit {
  return { entryIndex: 0, kind: 'user-text', toolName: null, field: 'text', timestamp: 't', snippet: { text: 'hi', matchStart: 0, matchLength: 2 }, ...overrides }
}

describe('kindChip', () => {
  it('prefers the tool name when present', () => {
    expect(kindChip(hit({ toolName: 'Bash' }))).toBe('Bash')
  })

  it('falls back to the entry kind label', () => {
    expect(kindChip(hit({ kind: 'thinking' }))).toBe('Thinking')
    expect(kindChip(hit({ kind: 'meta' }))).toBe('System')
  })
})

describe('errorCopy', () => {
  it('is the fixed too-short copy for invalid-query', () => {
    expect(errorCopy('invalid-query', null)).toBe(TOO_SHORT_COPY)
  })

  it('names the message for sessions-unavailable', () => {
    expect(errorCopy('sessions-unavailable', 'boom')).toContain('boom')
  })
})

function result(overrides: Partial<Extract<SearchResult, { ok: true }>>): Extract<SearchResult, { ok: true }> {
  return { ok: true, groups: [], inScope: 10, skippedByIndex: 0, read: 10, unreached: 0, complete: true, hitsTruncated: false, indexPersisted: true, tookMs: 5, ...overrides }
}

describe('emptyCopy', () => {
  it('names the scope when complete', () => {
    expect(emptyCopy(result({}))).toBe('No matches in 10 transcripts.')
  })

  it('names the partial read when not complete', () => {
    expect(emptyCopy(result({ complete: false, read: 3 }))).toContain('No matches yet in 3 of 10')
  })
})

describe('summaryLine', () => {
  it('sums hits across groups', () => {
    const r = result({ groups: [{ sessionId: 's', agentId: null, repoId: null, label: 'x', itemNumber: null, idleMs: 0, hitCount: 2, hits: [] }] })
    expect(summaryLine(r)).toContain('2 matches in 1 transcripts')
  })
})

describe('footnotes', () => {
  it('is empty when every honesty field is clean', () => {
    expect(footnotes(result({}))).toEqual([])
  })

  it('names unreached, truncation and an unsaved index', () => {
    const notes = footnotes(result({ unreached: 2, hitsTruncated: true, indexPersisted: false }))
    expect(notes).toHaveLength(3)
  })
})
