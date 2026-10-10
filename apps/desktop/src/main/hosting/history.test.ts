import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, readHistory } from './history'
import type { ReadHistoryDeps } from './history'
import type { TranscriptEntry } from '../../shared/sessions/transcript'

function entry(uuid: string): TranscriptEntry {
  return { type: 'meta', uuid, timestamp: '2024-01-01T00:00:00.000Z', label: uuid }
}

function depsReturning(entries: readonly TranscriptEntry[]): ReadHistoryDeps {
  return { openTranscript: () => Promise.resolve({ read: { ok: true, source: { sessionId: 's', agentId: null, path: '/p', sizeBytes: 0, modifiedAt: '', recordCount: entries.length, malformedLines: 0 }, entries }, cursor: null }) }
}

describe('readHistory', () => {
  it('reads nothing for a fresh session', async () => {
    const result = await readHistory({ kind: 'fresh' }, depsReturning([]))
    expect(result).toEqual({ kind: 'none' })
  })

  it('loads the whole transcript for resume', async () => {
    const entries = [entry('a'), entry('b')]
    const result = await readHistory({ kind: 'resume', sessionId: 's1' }, depsReturning(entries))
    expect(result).toEqual({ kind: 'loaded', entries, omittedBefore: 0, sourceSessionId: 's1' })
  })

  it('cuts after the resume point for resume-at', async () => {
    const entries = [entry('a'), entry('b'), entry('c')]
    const result = await readHistory({ kind: 'resume-at', sessionId: 's1', messageUuid: 'b', resumeDropsTurn: null }, depsReturning(entries))
    expect(result).toEqual({ kind: 'loaded', entries: [entry('a'), entry('b')], omittedBefore: 0, sourceSessionId: 's1' })
  })

  it('fails when the resume point is not in the transcript', async () => {
    const result = await readHistory({ kind: 'resume-at', sessionId: 's1', messageUuid: 'missing', resumeDropsTurn: null }, depsReturning([entry('a')]))
    expect(result).toEqual({ kind: 'failed', message: "The resume point isn't in the transcript." })
  })

  it('reports a failed read rather than throwing', async () => {
    const deps: ReadHistoryDeps = { openTranscript: () => Promise.resolve({ read: { ok: false, kind: 'not-found', message: 'gone', path: null }, cursor: null }) }
    const result = await readHistory({ kind: 'fork', sessionId: 's1' }, deps)
    expect(result).toEqual({ kind: 'failed', message: 'gone' })
  })

  it('keeps only the last HISTORY_LIMIT entries, counting the rest as omittedBefore', async () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => entry(`e${String(i)}`))
    const result = await readHistory({ kind: 'resume', sessionId: 's1' }, depsReturning(entries))
    if (result.kind !== 'loaded') throw new Error('expected loaded')
    expect(result.omittedBefore).toBe(10)
    expect(result.entries).toHaveLength(HISTORY_LIMIT)
    expect(result.entries[0]).toEqual(entry('e10'))
  })
})
