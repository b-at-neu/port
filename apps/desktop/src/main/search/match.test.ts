import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../../shared/sessions/transcript'
import { hitsFor, searchableFields } from './match'
import { parseQuery } from './terms'

function payload(text: string): { text: string; omittedChars: number } {
  return { text, omittedChars: 0 }
}

function userText(text: string, uuid = 'u1'): TranscriptEntry {
  return { type: 'user-text', uuid, timestamp: '2026-01-01T00:00:00.000Z', text: payload(text) }
}

function toolCall(overrides: Partial<Extract<TranscriptEntry, { type: 'tool-call' }>> = {}, uuid = 'u1'): TranscriptEntry {
  return {
    type: 'tool-call',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    name: 'Bash',
    headline: 'echo hi',
    input: payload('echo hi'),
    result: null,
    diff: null,
    ...overrides,
  }
}

function meta(label: string, uuid = 'u1'): TranscriptEntry {
  return { type: 'meta', uuid, timestamp: '2026-01-01T00:00:00.000Z', label }
}

function terms(...words: readonly string[]): readonly string[] {
  return parseQuery(words.join(' ')).terms
}

describe('searchableFields', () => {
  it('returns one text field for user-text/assistant-text/thinking', () => {
    expect(searchableFields(userText('hello'))).toEqual([{ field: 'text', text: 'hello' }])
  })

  it('returns label for meta', () => {
    expect(searchableFields(meta('checkpoint'))).toEqual([{ field: 'label', text: 'checkpoint' }])
  })

  it('returns name/headline/input for a tool call with no result or diff', () => {
    expect(searchableFields(toolCall())).toEqual([
      { field: 'name', text: 'Bash' },
      { field: 'headline', text: 'echo hi' },
      { field: 'input', text: 'echo hi' },
    ])
  })

  it('adds result only when present', () => {
    const fields = searchableFields(toolCall({ result: { isError: false, payload: payload('ok') } }))
    expect(fields).toContainEqual({ field: 'result', text: 'ok' })
  })

  it('adds diff as the path plus every hunk line when present', () => {
    const fields = searchableFields(
      toolCall({
        diff: {
          path: 'src/a.ts',
          isNewFile: false,
          additions: 1,
          deletions: 0,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [{ sign: 'add', text: '+ new line' }] }],
        },
      }),
    )
    const diffField = fields.find((f) => f.field === 'diff')
    expect(diffField?.text).toContain('src/a.ts')
    expect(diffField?.text).toContain('+ new line')
  })
})

describe('hitsFor', () => {
  it('matches an entry containing all terms across different fields', () => {
    const entries = [toolCall({ headline: '/repo/src/a.ts', result: { isError: true, payload: payload('boom: cannot find module') } })]
    const hits = hitsFor(entries, terms('a.ts', 'boom'))
    expect(hits).toHaveLength(1)
  })

  it('does not match when terms are split across different entries', () => {
    const entries = [userText('the first word'), userText('a different second word')]
    const hits = hitsFor(entries, terms('first', 'different'))
    expect(hits).toHaveLength(0)
  })

  it('is case-insensitive', () => {
    const entries = [userText('Hello World')]
    expect(hitsFor(entries, terms('HELLO'))).toHaveLength(1)
  })

  it('anchors the snippet on the first term match with context either side', () => {
    const entries = [userText('x'.repeat(100) + 'needle' + 'y'.repeat(100))]
    const hits = hitsFor(entries, terms('needle'))
    expect(hits).toHaveLength(1)
    const hit = hits[0]
    if (hit === undefined) throw new Error('unreachable')
    expect(hit.snippet.text).toContain('needle')
    expect(hit.snippet.text.startsWith('…')).toBe(true)
    expect(hit.snippet.text.endsWith('…')).toBe(true)
    expect(hit.snippet.text.slice(hit.snippet.matchStart, hit.snippet.matchStart + hit.snippet.matchLength)).toBe('needle')
  })

  it('carries toolName only for a tool-call hit', () => {
    const entries = [toolCall({ name: 'Write', headline: 'writes a file' })]
    expect(hitsFor(entries, terms('writes'))[0]?.toolName).toBe('Write')
    expect(hitsFor([userText('writes')], terms('writes'))[0]?.toolName).toBeNull()
  })

  it('returns no hits for an empty term list', () => {
    expect(hitsFor([userText('anything')], [])).toEqual([])
  })
})
