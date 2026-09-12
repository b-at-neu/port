import { describe, expect, it } from 'vitest'
import { capPayload, deriveEntries, headlineFor, sanitize } from './transcript-entries'

function toolUseRecord(uuid: string, id: string, name: string, input: unknown): unknown {
  return {
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  }
}

function toolResultRecord(uuid: string, toolUseId: string, content: unknown, isError: boolean, toolUseResult?: unknown): unknown {
  return {
    uuid,
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  }
}

describe('deriveEntries', () => {
  it('pairs a tool_use with its later tool_result by id', () => {
    const records = [toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'echo hi' }), toolResultRecord('u2', 'toolu_1', 'hi', false)]
    const entries = deriveEntries(records)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (entry?.type !== 'tool-call') throw new Error('unreachable')
    expect(entry.name).toBe('Bash')
    expect(entry.headline).toBe('echo hi')
    expect(entry.result).toEqual({ isError: false, payload: { text: 'hi', omittedChars: 0 } })
    expect(entry.diff).toBeNull()
  })

  it('keeps an unpaired tool_use as result: null rather than dropping it', () => {
    const records = [toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'echo hi' })]
    const entries = deriveEntries(records)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (entry?.type !== 'tool-call') throw new Error('unreachable')
    expect(entry.result).toBeNull()
  })

  it('carries is_error: true through to the paired result', () => {
    const records = [toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'false' }), toolResultRecord('u2', 'toolu_1', 'boom', true)]
    const entries = deriveEntries(records)
    const entry = entries[0]
    if (entry?.type !== 'tool-call') throw new Error('unreachable')
    expect(entry.result?.isError).toBe(true)
  })

  it('joins array-form tool_result content, replacing an image block with a placeholder', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image', source: { data: 'AAAA' } },
    ]
    const records = [toolUseRecord('u1', 'toolu_1', 'Read', { file_path: '/a.txt' }), toolResultRecord('u2', 'toolu_1', content, false)]
    const entries = deriveEntries(records)
    const entry = entries[0]
    if (entry?.type !== 'tool-call') throw new Error('unreachable')
    expect(entry.result?.payload.text).toContain('first')
    expect(entry.result?.payload.text).toContain('not shown')
  })

  it('derives a FileDiff from an Edit patch, keeping structuredPatch lines verbatim', () => {
    const toolUseResult = {
      filePath: '/a.ts',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' context', '+added', '-removed'] }],
    }
    const records = [
      toolUseRecord('u1', 'toolu_1', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      toolResultRecord('u2', 'toolu_1', 'ok', false, toolUseResult),
    ]
    const entries = deriveEntries(records)
    const entry = entries[0]
    if (entry?.type !== 'tool-call') throw new Error('unreachable')
    expect(entry.diff).toEqual({
      path: '/a.ts',
      isNewFile: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { sign: 'context', text: ' context' },
            { sign: 'add', text: '+added' },
            { sign: 'del', text: '-removed' },
          ],
        },
      ],
    })
  })

  it('synthesizes an all-additions hunk for a Write create with an empty structuredPatch', () => {
    const toolUseResult = { type: 'create', filePath: '/new.ts', structuredPatch: [] }
    const records = [
      toolUseRecord('u1', 'toolu_1', 'Write', { file_path: '/new.ts', content: 'line one\nline two' }),
      toolResultRecord('u2', 'toolu_1', 'File created', false, toolUseResult),
    ]
    const entries = deriveEntries(records)
    const entry = entries[0]
    if (entry?.type !== 'tool-call') throw new Error('unreachable')
    expect(entry.diff?.isNewFile).toBe(true)
    expect(entry.diff?.additions).toBe(2)
    expect(entry.diff?.deletions).toBe(0)
    expect(entry.diff?.hunks[0]?.lines).toEqual([
      { sign: 'add', text: '+line one' },
      { sign: 'add', text: '+line two' },
    ])
  })

  it('renders a thinking block as its own entry', () => {
    const records = [
      {
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
      },
    ]
    const entries = deriveEntries(records)
    expect(entries).toEqual([{ type: 'thinking', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', text: { text: 'pondering', omittedChars: 0 } }])
  })

  it('renders an attachment record as a meta entry, never dropping it', () => {
    const records = [{ uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', type: 'attachment', attachment: { type: 'skill_listing', skillCount: 40 } }]
    const entries = deriveEntries(records)
    expect(entries).toEqual([{ type: 'meta', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', label: 'skill listing (40 skills)' }])
  })

  it('caps an oversized payload and reports the omitted character count', () => {
    const big = 'x'.repeat(40_000)
    const result = capPayload(big, 100)
    expect(result.text).toHaveLength(100)
    expect(result.omittedChars).toBe(big.length - 100)
  })

  it('still fills the cap when sanitizing strips more than the slack out of the prefix', () => {
    // #83: the bounded-prefix optimization read only `cap + CAP_SLACK`
    // characters, so control-heavy output -- exactly what the sanitizer
    // exists to defend against -- came back short of `cap` while unread
    // content still followed. Nine stripped bytes per kept character puts
    // the ratio far past the slack.
    const esc = String.fromCharCode(27)
    const noisy = `x${esc.repeat(9)}`.repeat(500)
    const result = capPayload(noisy, 100)
    expect(result.text).toBe('x'.repeat(100))
    expect(result.omittedChars).toBeGreaterThan(0)
  })

  it('skips a record with no recognizable shape rather than throwing', () => {
    const entries = deriveEntries([null, 42, 'a string', {}, { uuid: 'u1' }])
    expect(entries).toEqual([])
  })
})

describe('sanitize', () => {
  it('strips the ESC control byte out of an ANSI escape run, leaving the inert bracket text', () => {
    // Sanitizing removes only the control byte, never a parsed escape
    // sequence — the remaining "[31m"/"[0m" text is inert once the ESC
    // byte is gone, rather than rendering as colour.
    const esc = String.fromCharCode(27)
    const withEscape = `before${esc}[31mred${esc}[0mafter`
    expect(sanitize(withEscape)).toBe('before[31mred[0mafter')
    expect(sanitize(withEscape)).not.toContain(esc)
  })

  it('strips a bidi override character', () => {
    const override = String.fromCodePoint(8238)
    const withOverride = `path${override}desrever`
    expect(sanitize(withOverride)).toBe('pathdesrever')
  })

  it('keeps newlines and tabs', () => {
    expect(sanitize('a\nb\tc')).toBe('a\nb\tc')
  })
})

describe('headlineFor', () => {
  it('takes the first line of a Bash command', () => {
    expect(headlineFor('Bash', { command: 'echo one\necho two' }, null)).toBe('echo one')
  })

  it('shows a file path relative to cwd when it sits under it', () => {
    expect(headlineFor('Edit', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('src/a.ts')
  })

  it('falls back to the absolute path when it does not sit under cwd', () => {
    expect(headlineFor('Edit', { file_path: '/elsewhere/a.ts' }, '/repo')).toBe('/elsewhere/a.ts')
  })

  it('joins pattern and path for Grep', () => {
    expect(headlineFor('Grep', { pattern: 'foo', path: 'src' }, null)).toBe('foo src')
  })

  it('counts todos for TodoWrite', () => {
    expect(headlineFor('TodoWrite', { todos: [1, 2, 3] }, null)).toBe('3 todos')
  })

  it('falls back to the first string field for an unknown tool', () => {
    expect(headlineFor('SomeNewTool', { foo: 42, bar: 'value' }, null)).toBe('value')
  })

  it('falls back to the tool name when no string field exists', () => {
    expect(headlineFor('SomeNewTool', { foo: 42 }, null)).toBe('SomeNewTool')
  })

  it('strips a bidi override from the extracted headline (R4-M1)', () => {
    expect(headlineFor('Bash', { command: '‮evil' }, null)).toBe('evil')
  })
})
