import { describe, expect, it } from 'vitest'
import { createSessionProjector, ENTRY_RETAIN_LIMIT } from './project'

const NOW = '2026-01-01T00:00:00.000Z'

describe('createSessionProjector', () => {
  it('streams text: appends, then clears on the final assistant-text entry', () => {
    const projector = createSessionProjector({ cwd: '/repo' })

    const start = projector.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } }, NOW)
    expect(start).toBeNull()

    const blockStart = projector.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }, NOW)
    expect(blockStart?.partial).toEqual({ op: 'append', blockId: 'msg-1:0', kind: 'text', text: '' })

    const delta = projector.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } }, NOW)
    expect(delta?.partial).toEqual({ op: 'append', blockId: 'msg-1:0', kind: 'text', text: 'Hi' })

    projector.push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }, NOW)
    expect(projector.window().partial).toEqual({ blockId: 'msg-1:0', kind: 'text', text: 'Hi', omittedChars: 0 })

    const assistant = projector.push({ type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }, NOW)
    expect(assistant?.appended).toHaveLength(1)
    expect(assistant?.appended[0]).toMatchObject({ type: 'assistant-text' })
    expect(assistant?.partial).toEqual({ op: 'clear' })
    expect(projector.window().partial).toBeNull()
  })

  it('streams thinking the same way, keyed to its own blockId', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    projector.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-2' } } }, NOW)
    const started = projector.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }, NOW)
    expect(started?.partial).toEqual({ op: 'append', blockId: 'msg-2:0', kind: 'thinking', text: '' })
    const delta = projector.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } }, NOW)
    expect(delta?.partial).toEqual({ op: 'append', blockId: 'msg-2:0', kind: 'thinking', text: 'pondering' })
  })

  it('pairs an Edit tool call with its user result, deriving a diff', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const call = projector.push(
      { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: '/repo/a.ts' } }] } },
      NOW,
    )
    expect(call?.appended[0]).toMatchObject({ type: 'tool-call', name: 'Edit', result: null, diff: null })

    const structuredPatch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
    const result = projector.push(
      {
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        tool_use_result: { filePath: '/repo/a.ts', structuredPatch },
      },
      NOW,
    )
    expect(result?.patched).toHaveLength(1)
    expect(result?.patched[0]?.entry.diff).not.toBeNull()
    expect(result?.patched[0]?.entry.result).toEqual({ isError: false, payload: { text: 'ok', omittedChars: 0 } })
  })

  it('nests a subagent frame (a non-null parent_tool_use_id) rather than dropping it, stamped with parentToolUseId', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const delta = projector.push({ type: 'assistant', uuid: 'a-1', parent_tool_use_id: 'tool-1', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }, NOW)
    expect(delta?.appended).toHaveLength(1)
    expect(delta?.appended[0]).toMatchObject({ type: 'assistant-text', parentToolUseId: 'tool-1', text: { text: 'subagent chatter' } })
  })

  it('skips a subagent stream_event — never a live partial for a subagent', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const delta = projector.push({ type: 'stream_event', parent_tool_use_id: 'tool-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }, NOW)
    expect(delta).toBeNull()
  })

  it('nests a subagent child under the parent tool call, then deletes the child deriver once the parent pairs', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    projector.push({ type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: { description: 'd' } }] } }, NOW)
    const child = projector.push({ type: 'assistant', uuid: 'a-2', parent_tool_use_id: 'tool-1', message: { role: 'assistant', content: [{ type: 'text', text: 'child text' }] } }, NOW)
    expect(child?.appended[0]).toMatchObject({ parentToolUseId: 'tool-1' })

    const result = projector.push(
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } },
      NOW,
    )
    expect(result?.patched).toHaveLength(1)
    expect(result?.patched[0]?.entry).toMatchObject({ type: 'tool-call', result: { isError: false } })
  })

  it('renders a permission_denied frame as a meta row', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const delta = projector.push({ type: 'system', subtype: 'permission_denied', uuid: 'd-1', tool_name: 'Edit', message: 'not allowed' }, NOW)
    expect(delta?.appended[0]).toMatchObject({ type: 'meta', label: 'Denied Edit: not allowed' })
  })

  it('result meta rows: success names duration, error names the subtype and first error', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const success = projector.push({ type: 'result', uuid: 'r-1', subtype: 'success', duration_ms: 4200 }, NOW)
    expect(success?.appended[0]).toMatchObject({ label: 'Turn complete · 4.2 s' })

    const failure = projector.push({ type: 'result', uuid: 'r-2', subtype: 'error_max_turns', errors: ['too many turns'] }, NOW)
    expect(failure?.appended[0]).toMatchObject({ label: 'Turn ended early · error_max_turns: too many turns' })
  })

  it('recordSend, then acknowledges by user_message_uuids on the first assistant frame', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const sent = projector.recordSend('send-1', 'hello', NOW)
    expect(sent.pendingSends).toEqual(['send-1'])
    expect(sent.appended[0]).toMatchObject({ type: 'user-text' })

    const ack = projector.push({ type: 'assistant', uuid: 'a-1', user_message_uuids: ['send-1'], message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }, NOW)
    expect(ack?.pendingSends).toEqual([])
  })

  it('the fallback clears every pending send on a result with no positive queued_turn_count', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    projector.recordSend('send-1', 'hello', NOW)
    const result = projector.push({ type: 'result', uuid: 'r-1', subtype: 'success' }, NOW)
    expect(result?.pendingSends).toEqual([])
  })

  it('a result with a positive queued_turn_count leaves pending sends alone', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    projector.recordSend('send-1', 'hello', NOW)
    const result = projector.push({ type: 'result', uuid: 'r-1', subtype: 'success', queued_turn_count: 1 }, NOW)
    expect(result?.pendingSends).toBeNull()
    expect(projector.window().pendingSends).toEqual(['send-1'])
  })

  it('strips a bidi override and an ANSI run from a streamed partial chunk', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    projector.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-3' } } }, NOW)
    projector.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }, NOW)
    const delta = projector.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '‮reversed\u001b[31m' } } }, NOW)
    expect(delta?.partial && 'text' in delta.partial ? delta.partial.text : null).toBe('reversed\u001b[31m'.replace('\u001b', ''))
  })

  it('caps partial text at MAX_PAYLOAD_CHARS, still emitting the entries window bounded', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    projector.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-4' } } }, NOW)
    projector.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }, NOW)
    const bigChunk = 'x'.repeat(40_000)
    projector.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: bigChunk } } }, NOW)
    const window = projector.window()
    expect(window.partial?.text.length).toBeLessThanOrEqual(32_000)
    expect(window.partial?.omittedChars).toBeGreaterThan(0)
  })

  it('evicts the oldest ring entries past ENTRY_RETAIN_LIMIT, still patching a later result live', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    for (let i = 0; i < ENTRY_RETAIN_LIMIT + 10; i += 1) {
      projector.push({ type: 'assistant', uuid: `a-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `msg ${i}` }] } }, NOW)
    }
    const window = projector.window()
    expect(window.entries).toHaveLength(ENTRY_RETAIN_LIMIT)
    expect(window.firstIndex).toBe(10)
  })

  it('narrows a non-object message to no delta at all', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    expect(projector.push('not an object', NOW)).toBeNull()
    expect(projector.push(null, NOW)).toBeNull()
    expect(projector.push(42, NOW)).toBeNull()
  })

  it('an api_retry frame renders as a meta row naming the attempt', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const delta = projector.push({ type: 'system', subtype: 'api_retry', uuid: 'r-1', attempt: 2, max_retries: 5 }, NOW)
    expect(delta?.appended[0]).toMatchObject({ label: 'Retrying the API request (attempt 2 of 5)' })
  })

  it('a compact_boundary frame renders as Context compacted', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const delta = projector.push({ type: 'system', subtype: 'compact_boundary', uuid: 'c-1' }, NOW)
    expect(delta?.appended[0]).toMatchObject({ label: 'Context compacted' })
  })

  it('a user frame with isReplay: true is skipped -- recordSend already recorded it', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    const delta = projector.push({ type: 'user', uuid: 'u-1', isReplay: true, message: { role: 'user', content: 'echoed' } }, NOW)
    expect(delta).toBeNull()
  })

  it('revision increments once per non-null delta, and window() reports it', () => {
    const projector = createSessionProjector({ cwd: '/repo' })
    expect(projector.window().revision).toBe(0)
    const first = projector.push({ type: 'system', subtype: 'compact_boundary', uuid: 'c-1' }, NOW)
    expect(first?.revision).toBe(1)
    expect(projector.window().revision).toBe(1)
  })
})
