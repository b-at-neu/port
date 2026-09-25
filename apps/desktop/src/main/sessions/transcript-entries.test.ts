import { describe, expect, it } from 'vitest'
import { capPayload, createDeriver, deriveEntries, headlineFor, sanitize } from './transcript-entries'
import type { TranscriptEntry } from '../../shared/sessions/transcript'
import sharedCaseTable from './transcript.cases.json'

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

describe('createDeriver', () => {
  it('pairs a tool_use from one push with a tool_result from a later push', () => {
    const deriver = createDeriver()
    const first = deriver.push([toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'echo hi' })])
    expect(first.appended).toHaveLength(1)
    expect(first.patched).toHaveLength(0)
    expect(first.appended[0]).toMatchObject({ type: 'tool-call', result: null })

    const second = deriver.push([toolResultRecord('u2', 'toolu_1', 'hi', false)])
    expect(second.appended).toHaveLength(0)
    expect(second.patched).toHaveLength(1)
    expect(second.patched[0]?.index).toBe(0)
    expect(second.patched[0]?.entry).toMatchObject({ type: 'tool-call', result: { isError: false, payload: { text: 'hi', omittedChars: 0 } } })
  })

  it('reports the absolute index across pushes, not one relative to the patching chunk', () => {
    const deriver = createDeriver()
    deriver.push([
      { uuid: 'u0', timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: 'preamble' } },
      toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'echo hi' }),
    ])
    const patch = deriver.push([toolResultRecord('u2', 'toolu_1', 'hi', false)])
    expect(patch.patched[0]?.index).toBe(1)
  })

  it('pairs a tool call once -- a duplicate tool_result is a no-op, never overwriting the real diff', () => {
    const deriver = createDeriver()
    deriver.push([toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'echo hi' })])
    const first = deriver.push([toolResultRecord('u2', 'toolu_1', 'hi', false)])
    expect(first.patched).toHaveLength(1)

    const duplicate = deriver.push([toolResultRecord('u3', 'toolu_1', 'hi again', true)])
    expect(duplicate.appended).toHaveLength(0)
    expect(duplicate.patched).toHaveLength(0)
  })

  it('still pairs a tool_use and tool_result delivered in the same push, matching deriveEntries', () => {
    const records = [toolUseRecord('u1', 'toolu_1', 'Bash', { command: 'echo hi' }), toolResultRecord('u2', 'toolu_1', 'hi', false)]
    const deriver = createDeriver()
    const chunk = deriver.push(records)
    expect(chunk.appended).toHaveLength(1)
    expect(chunk.patched).toHaveLength(1)
    expect(chunk.patched[0]?.index).toBe(0)
    expect(deriveEntries(records)).toHaveLength(1)
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

interface SharedCaseEmitted {
  readonly kind: string
  readonly name?: string
  readonly text?: string
}
interface SharedCasePaired {
  readonly index: number
  readonly isError: boolean
  readonly text: string
}
interface SharedCase {
  readonly name: string
  readonly pushes: readonly (readonly unknown[])[]
  readonly expect: { readonly emitted: readonly SharedCaseEmitted[]; readonly paired: readonly SharedCasePaired[] }
}

const sharedCases = (sharedCaseTable as { readonly cases: readonly SharedCase[] }).cases

describe('shared record-classification contract (#123)', () => {
  it('the table covers pairing across a batch boundary and a duplicate result', () => {
    expect(sharedCases.some((c) => c.name.includes('batch boundary'))).toBe(true)
    expect(sharedCases.some((c) => c.name.includes('duplicate'))).toBe(true)
  })

  for (const row of sharedCases) {
    it(row.name, () => {
      const deriver = createDeriver()
      const entries: TranscriptEntry[] = []
      for (const batch of row.pushes) {
        const { appended, patched } = deriver.push(batch)
        entries.push(...appended)
        for (const patch of patched) entries[patch.index] = patch.entry
      }

      const gotEmitted = entries.map((e) =>
        e.type === 'tool-call' ? { kind: e.type, name: e.name } : e.type === 'meta' ? { kind: e.type } : { kind: e.type, text: e.text.text },
      )
      expect(gotEmitted).toEqual(row.expect.emitted)

      const gotPaired = entries
        .map((e, index) => ({ e, index }))
        .filter(({ e }) => e.type === 'tool-call' && e.result !== null)
        .map(({ e, index }) => {
          if (e.type !== 'tool-call' || e.result === null) throw new Error('unreachable')
          return { index, isError: e.result.isError, text: e.result.payload.text }
        })
      expect(gotPaired).toEqual(row.expect.paired)
    })
  }
})
