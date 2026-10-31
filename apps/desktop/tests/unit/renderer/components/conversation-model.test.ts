import { describe, expect, it } from 'vitest'
import { buildRow, defaultOpen, diffSummary, groupEntries, hunkHeader, stageCardTitle, toolSummary } from '@/renderer/components/conversation-model'
import type { RowView } from '@/types/components'
import type { TranscriptEntry } from '@/utils/sessions/transcript'

const PAYLOAD = { text: 'hello', omittedChars: 0 } as const

describe('buildRow', () => {
  it('maps user-text', () => {
    const entry: TranscriptEntry = { type: 'user-text', uuid: 'u1', timestamp: 't', text: PAYLOAD }
    expect(buildRow(entry)).toEqual({ kind: 'user-text', uuid: 'u1', text: { text: 'hello', omittedChars: 0 } })
  })

  it('maps a stage prompt to a stage-prompt row, carrying the payload cap', () => {
    const header = 'Implementation stage for issue #467. Run your pipeline stage for #467. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
    const text = `${header}\n\n<port-stage-context>\nstage: impl\n</port-stage-context>\n\n<port-stage-instructions source="/plugins/port">\nYou are the Impl agent.\n</port-stage-instructions>`
    const entry: TranscriptEntry = { type: 'user-text', uuid: 'u7', timestamp: 't', text: { text, omittedChars: 1200 } }
    const row = buildRow(entry)
    expect(row).toEqual({ kind: 'stage-prompt', uuid: 'u7', stage: 'impl', itemKind: 'issue', number: 467, instructions: { text: 'You are the Impl agent.', omittedChars: 1200 }, source: '/plugins/port' })
    if (row.kind === 'stage-prompt') expect(stageCardTitle(row)).toBe('Implementation stage · ticket #467')
  })

  it('maps a legacy dispatch one-liner to a header-only stage-prompt row', () => {
    const text = 'Review stage for pull request #537. Run your pipeline stage for #537. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
    const row = buildRow({ type: 'user-text', uuid: 'u8', timestamp: 't', text: { text, omittedChars: 0 } })
    expect(row).toMatchObject({ kind: 'stage-prompt', stage: 'review', itemKind: 'pull-request', number: 537, instructions: null, source: null })
    if (row.kind === 'stage-prompt') expect(stageCardTitle(row)).toBe('Review stage · PR#537')
  })

  it('titles revision and refresh cards by their pull request', () => {
    const revise = buildRow({ type: 'user-text', uuid: 'u9', timestamp: 't', text: { text: 'Revision stage for pull request #537. Run your pipeline stage for #537.', omittedChars: 0 } })
    const refresh = buildRow({ type: 'user-text', uuid: 'u10', timestamp: 't', text: { text: 'Refresh stage for pull request #540. Run your pipeline stage for pull request #540 in refresh mode.', omittedChars: 0 } })
    if (revise.kind === 'stage-prompt') expect(stageCardTitle(revise)).toBe('Revision stage · PR#537')
    if (refresh.kind === 'stage-prompt') expect(stageCardTitle(refresh)).toBe('Refresh stage · PR#540')
    expect([revise.kind, refresh.kind]).toEqual(['stage-prompt', 'stage-prompt'])
  })

  it('keeps an ordinary prompt that mentions a stage as user-text', () => {
    const entry: TranscriptEntry = { type: 'user-text', uuid: 'u11', timestamp: 't', text: { text: 'What does the Plan stage for issue #5 do?', omittedChars: 0 } }
    expect(buildRow(entry).kind).toBe('user-text')
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

  it('reports a running subagent with its step count', () => {
    const entry = toolCall('s1', { name: 'Task', detail: { kind: 'task', description: 'x', subagentType: null } })
    expect(toolSummary(rowFor(entry), 4)).toBe('4 steps · running')
  })

  it('reports a done subagent with its step count', () => {
    const entry = toolCall('s2', { name: 'Task', detail: { kind: 'task', description: 'x', subagentType: null }, result: { isError: false, payload: PAYLOAD } })
    expect(toolSummary(rowFor(entry), 1)).toBe('1 step · done')
  })

  it('reports a failed subagent without a step count', () => {
    const entry = toolCall('s3', { name: 'Task', detail: { kind: 'task', description: 'x', subagentType: null }, result: { isError: true, payload: PAYLOAD } })
    expect(toolSummary(rowFor(entry), 4)).toBe('error')
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
