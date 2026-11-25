import { describe, expect, it } from 'vitest'
import { accept, applyDelta, applyPoll, CATCH_UP_MS, drainBuffered, pollDelay, pollFailed, setFollowing, TAIL_INTERVAL_MS } from '@/renderer/data/transcript-model'
import type { FileReady, SessionReady, TranscriptData } from '@/renderer/data/transcript-model'
import type { SessionEntriesDelta, SessionKey } from '@/types/hosting'
import type { EntryPatch, ToolCallEntry, TranscriptEntry, TranscriptSource } from '@/utils/sessions/transcript'

const meta = (uuid: string): TranscriptEntry => ({ type: 'meta', uuid, timestamp: '2026-01-01T00:00:00Z', label: uuid })
const tool = (uuid: string, done: boolean): ToolCallEntry => ({
  type: 'tool-call',
  uuid,
  timestamp: '2026-01-01T00:00:00Z',
  name: 'Bash',
  headline: uuid,
  input: { text: '', omittedChars: 0 },
  result: done ? { isError: false, payload: { text: 'ok', omittedChars: 0 } } : null,
  diff: null,
})
const patch = (index: number, uuid: string): EntryPatch => ({ index, entry: tool(uuid, true) })

const session = (over: Partial<SessionReady> = {}): SessionReady => ({ kind: 'session', status: 'ready', entries: [meta('a'), tool('t', false)], firstIndex: 0, live: null, history: { kind: 'none' }, revision: 3, ...over })
const delta = (over: Partial<SessionEntriesDelta> = {}): SessionEntriesDelta => ({ sessionKey: 'k' as SessionKey, revision: 4, appended: [], patched: [], partial: null, pendingSends: null, ...over })

const SOURCE: TranscriptSource = { sessionId: 's', agentId: null, path: '/p', sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z', recordCount: 1, malformedLines: 0 }
const file = (over: Partial<FileReady> = {}): FileReady => ({ kind: 'file', status: 'ready', tailId: 'tail', source: SOURCE, entries: [meta('a'), tool('t', false)], following: true, failure: null, truncatedNote: false, hasMore: false, ...over })

describe('accept', () => {
  it.each([
    [3, 4, 'apply'],
    [3, 3, 'stale'],
    [3, 1, 'stale'],
    [3, 6, 'gap'],
  ] as const)('after revision %i, revision %i is %s', (last, next, outcome) => {
    expect(accept(last, { revision: next })).toBe(outcome)
  })
})

describe('drainBuffered', () => {
  it.each([
    ['applies what follows the attach in order, dropping the covered ones', 2, [2, 4, 3, 1], { kind: 'apply', revisions: [3, 4] }],
    ['reports a gap when a revision was missed', 2, [5], { kind: 'gap' }],
    ['applies nothing when nothing was buffered', 2, [], { kind: 'apply', revisions: [] }],
    ['keeps the first of a duplicated next revision', 2, [3, 3], { kind: 'apply', revisions: [3] }],
  ] as const)('%s', (_name, attach, buffered, expected) => {
    const result = drainBuffered(attach, buffered.map((revision) => ({ revision })))
    expect(result.kind).toBe(expected.kind)
    if (result.kind === 'apply' && expected.kind === 'apply') expect(result.deltas.map((entry) => entry.revision)).toEqual(expected.revisions)
  })
})

describe('applyDelta', () => {
  it.each([
    ['appends', delta({ appended: [meta('b')] }), ['a', 't', 'b']],
    ['patches inside the window', delta({ patched: [patch(1, 't')] }), ['a', 't']],
    ['ignores a patch outside the window', delta({ patched: [patch(9, 'x'), patch(-1, 'y')] }), ['a', 't']],
    ['patches an entry appended in the same delta', delta({ appended: [tool('n', false)], patched: [patch(2, 'n')] }), ['a', 't', 'n']],
  ] as const)('%s', (_name, input, uuids) => {
    expect(applyDelta(session(), input).entries.map((entry) => entry.uuid)).toEqual(uuids)
  })

  it('offsets a patch by the window start', () => {
    const next = applyDelta(session({ firstIndex: 10 }), delta({ patched: [patch(11, 't')] }))
    expect(next.entries[1]).toMatchObject({ type: 'tool-call', result: { isError: false } })
  })

  it('records the delta revision', () => {
    expect(applyDelta(session(), delta({ revision: 4 })).revision).toBe(4)
  })

  it.each([
    ['opens a block', null, { op: 'append', blockId: 'm:0', kind: 'text', text: 'hi' }, { blockId: 'm:0', kind: 'text', text: 'hi', omittedChars: 0 }],
    ['grows the same block', { blockId: 'm:0', kind: 'text', text: 'hi', omittedChars: 0 }, { op: 'append', blockId: 'm:0', kind: 'text', text: ' there' }, { blockId: 'm:0', kind: 'text', text: 'hi there', omittedChars: 0 }],
    ['replaces a different block', { blockId: 'm:0', kind: 'text', text: 'hi', omittedChars: 0 }, { op: 'append', blockId: 'm:1', kind: 'thinking', text: 'hm' }, { blockId: 'm:1', kind: 'thinking', text: 'hm', omittedChars: 0 }],
    ['clears the block', { blockId: 'm:0', kind: 'text', text: 'hi', omittedChars: 0 }, { op: 'clear' }, null],
    ['leaves it alone without a partial', { blockId: 'm:0', kind: 'text', text: 'hi', omittedChars: 0 }, null, { blockId: 'm:0', kind: 'text', text: 'hi', omittedChars: 0 }],
  ] as const)('the live block %s', (_name, live, partial, expected) => {
    expect(applyDelta(session({ live }), delta({ partial })).live).toEqual(expected)
  })
})

describe('applyPoll', () => {
  const polled = (over: { appended?: readonly TranscriptEntry[]; patched?: readonly EntryPatch[]; hasMore?: boolean } = {}) => ({ ok: true as const, source: SOURCE, appended: [], patched: [], hasMore: false, ...over })

  it.each([
    ['appends', polled({ appended: [meta('b')] }), ['a', 't', 'b']],
    ['patches in range', polled({ patched: [patch(1, 't')] }), ['a', 't']],
    ['skips a patch out of range', polled({ patched: [patch(5, 'x')] }), ['a', 't']],
  ] as const)('%s', (_name, input, uuids) => {
    expect(applyPoll(file(), input).entries.map((entry) => entry.uuid)).toEqual(uuids)
  })

  it('clears a failure and a truncation note, and carries hasMore', () => {
    const next = applyPoll(file({ truncatedNote: true, failure: { kind: 'unreadable', message: 'x', path: null } }), polled({ hasMore: true }))
    expect(next).toMatchObject({ failure: null, truncatedNote: false, hasMore: true })
  })
})

describe('pollFailed and setFollowing', () => {
  const failure = { kind: 'unreachable', message: 'x', path: null } as const

  it('a failed poll pauses and keeps the entries', () => {
    const next = pollFailed(file(), failure)
    expect(next).toMatchObject({ following: false, failure })
    expect(next.entries).toHaveLength(2)
  })

  it.each([
    ['resuming clears the failure', file({ following: false, failure }), true, { following: true, failure: null }],
    ['pausing keeps the failure', file({ following: true, failure }), false, { following: false, failure }],
  ] as const)('%s', (_name, input, on, expected) => {
    expect(setFollowing(input, on)).toMatchObject(expected)
  })
})

describe('pollDelay', () => {
  const states: readonly (readonly [string, TranscriptData | undefined, number | false])[] = [
    ['no data', undefined, false],
    ['a session', session(), false],
    ['a failed open', { kind: 'file', status: 'open-failed', failure: { kind: 'not-found', message: '', path: null } }, false],
    ['a paused tail', file({ following: false }), false],
    ['a following tail', file(), TAIL_INTERVAL_MS],
    ['a following tail with more to read', file({ hasMore: true }), CATCH_UP_MS],
  ]

  it.each(states)('%s', (_name, data, expected) => {
    expect(pollDelay(data)).toBe(expected)
  })
})
