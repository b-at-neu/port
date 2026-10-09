import { describe, expect, it } from 'vitest'
import { buildRow, defaultOpen, diffSummary, groupEntries, hunkHeader, toolSummary } from './conversation-model'
import type { RowView } from './conversation-model'
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

function toolCall(uuid: string, overrides: Partial<Extract<TranscriptEntry, { type: 'tool-call' }>> = {}): TranscriptEntry {
  return { type: 'tool-call', uuid, timestamp: 't', name: 'Task', headline: 'x', input: PAYLOAD, result: null, diff: null, ...overrides }
}

describe('groupEntries', () => {
  it('nests a child under its parent toolUseId', () => {
    const parent = toolCall('p', { toolUseId: 'tu1' })
    const child: TranscriptEntry = { type: 'user-text', uuid: 'c', timestamp: 't', text: PAYLOAD, parentToolUseId: 'tu1' }
    const grouped = groupEntries([parent, child])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.children).toHaveLength(1)
    expect(grouped[0]?.children[0]?.entry.uuid).toBe('c')
  })

  it('flags an orphan whose parent is not in the window, keeping it top-level', () => {
    const child: TranscriptEntry = { type: 'user-text', uuid: 'c', timestamp: 't', text: PAYLOAD, parentToolUseId: 'missing' }
    const grouped = groupEntries([child])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.orphanSubagent).toBe(true)
  })

  it('nests grandchildren recursively', () => {
    const grandparent = toolCall('gp', { toolUseId: 'tu-gp' })
    const parent: TranscriptEntry = { ...toolCall('p', { toolUseId: 'tu-p' }), parentToolUseId: 'tu-gp' }
    const child: TranscriptEntry = { type: 'user-text', uuid: 'c', timestamp: 't', text: PAYLOAD, parentToolUseId: 'tu-p' }
    const grouped = groupEntries([grandparent, parent, child])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.children[0]?.children[0]?.entry.uuid).toBe('c')
  })
})

function rowFor(entry: TranscriptEntry): Extract<RowView, { readonly kind: 'tool-call' }> {
  const row = buildRow(entry)
  if (row.kind !== 'tool-call') throw new Error('expected a tool-call row')
  return row
}

describe('toolSummary', () => {
  it('reports a known Bash exit code', () => {
    const entry = toolCall('b1', { name: 'Bash', detail: { kind: 'bash', command: 'ls', exitCode: 0, interrupted: false } })
    expect(toolSummary(rowFor(entry))).toBe('exit 0')
  })

  it('reports Read as a line count', () => {
    const entry = toolCall('r1', { name: 'Read', detail: { kind: 'lookup', count: 120 } })
    expect(toolSummary(rowFor(entry))).toBe('120 lines')
  })

  it('reports Grep with No matches', () => {
    const entry = toolCall('g1', { name: 'Grep', detail: { kind: 'lookup', count: 0 } })
    expect(toolSummary(rowFor(entry))).toBe('No matches')
  })

  it('reports TodoWrite progress', () => {
    const entry = toolCall('t1', {
      name: 'TodoWrite',
      detail: { kind: 'todos', items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }], droppedCount: 0 },
    })
    expect(toolSummary(rowFor(entry))).toBe('1 of 2 done')
  })

  it('reports a running subagent', () => {
    const entry = toolCall('s1', { name: 'Task', detail: { kind: 'task', description: 'x', subagentType: null } })
    expect(toolSummary(rowFor(entry))).toBe('running')
  })
})

describe('defaultOpen', () => {
  it('opens a diff by default', () => {
    const entry = toolCall('d1', { name: 'Edit', diff: { path: 'a.ts', isNewFile: false, additions: 1, deletions: 0, hunks: [] } })
    expect(defaultOpen(rowFor(entry))).toBe(true)
  })

  it('opens a failed Bash by default', () => {
    const entry = toolCall('b2', { name: 'Bash', result: { isError: true, payload: PAYLOAD }, detail: { kind: 'bash', command: 'false', exitCode: 1, interrupted: false } })
    expect(defaultOpen(rowFor(entry))).toBe(true)
  })

  it('leaves a successful Read closed by default', () => {
    const entry = toolCall('r2', { name: 'Read', result: { isError: false, payload: PAYLOAD }, detail: { kind: 'lookup', count: 10 } })
    expect(defaultOpen(rowFor(entry))).toBe(false)
  })
})
