import { describe, expect, it } from 'vitest'
import { buildRow, diffSummary, hunkHeader } from './conversation-model'
import type { TranscriptEntry } from '../../../shared/sessions/transcript'

const PAYLOAD = { text: 'hello', omittedChars: 0 } as const

describe('buildRow', () => {
  it('maps user-text', () => {
    const entry: TranscriptEntry = { type: 'user-text', uuid: 'u1', timestamp: 't', text: PAYLOAD }
    expect(buildRow(entry)).toEqual({ kind: 'user-text', uuid: 'u1', text: { text: 'hello', omittedChars: 0 } })
  })

  it('maps assistant-text', () => {
    const entry: TranscriptEntry = { type: 'assistant-text', uuid: 'u2', timestamp: 't', text: PAYLOAD }
    expect(buildRow(entry)).toEqual({ kind: 'assistant-text', uuid: 'u2', text: { text: 'hello', omittedChars: 0 } })
  })

  it('maps thinking with a word count', () => {
    const entry: TranscriptEntry = { type: 'thinking', uuid: 'u3', timestamp: 't', text: { text: 'one two three', omittedChars: 0 } }
    expect(buildRow(entry)).toMatchObject({ kind: 'thinking', wordCount: 3 })
  })

  it('maps a tool call with no result', () => {
    const entry: TranscriptEntry = { type: 'tool-call', uuid: 'u4', timestamp: 't', name: 'Read', headline: 'file.ts', input: PAYLOAD, result: null, diff: null }
    expect(buildRow(entry)).toMatchObject({ kind: 'tool-call', result: { kind: 'none' } })
  })

  it('maps a tool call with an error result', () => {
    const entry: TranscriptEntry = { type: 'tool-call', uuid: 'u5', timestamp: 't', name: 'Bash', headline: 'ls', input: PAYLOAD, result: { isError: true, payload: PAYLOAD }, diff: null }
    expect(buildRow(entry)).toMatchObject({ kind: 'tool-call', result: { kind: 'error' } })
  })

  it('maps meta', () => {
    const entry: TranscriptEntry = { type: 'meta', uuid: 'u6', timestamp: 't', label: 'Attachment' }
    expect(buildRow(entry)).toEqual({ kind: 'meta', uuid: 'u6', label: 'Attachment' })
  })
})

describe('diffSummary / hunkHeader', () => {
  it('formats a new file and a hunk header', () => {
    const diff = { path: 'a.ts', isNewFile: true, additions: 3, deletions: 1, hunks: [] }
    expect(diffSummary(diff)).toBe('(new file) a.ts  +3 -1')
    expect(hunkHeader({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [] })).toBe('@@ -1,2 +1,3 @@')
  })
})
