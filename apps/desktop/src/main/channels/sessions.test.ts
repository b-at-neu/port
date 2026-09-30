// Relocated verbatim from `main/ipc.test.ts` (#92) alongside the resolvers
// they cover — no behaviour change in this move.
import { describe, expect, it } from 'vitest'
import type { TranscriptRead, TranscriptTailOpen, TranscriptTailPoll } from '../../shared/sessions/transcript'
import { resolveTranscriptRead, resolveTranscriptTailClose, resolveTranscriptTailOpen, resolveTranscriptTailPoll } from './sessions'
import type { TranscriptReadDeps, TranscriptTailDeps } from './sessions'

function transcriptReadDepsWith(overrides: Partial<TranscriptReadDeps>): TranscriptReadDeps {
  return {
    openTranscript: () => {
      throw new Error('openTranscript should not be invoked in this case')
    },
    ...overrides,
  }
}

function tailDepsWith(overrides: Partial<TranscriptTailDeps>): TranscriptTailDeps {
  return {
    openTail: () => {
      throw new Error('openTail should not be invoked in this case')
    },
    pollTail: () => {
      throw new Error('pollTail should not be invoked in this case')
    },
    closeTail: () => {
      throw new Error('closeTail should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveTranscriptRead', () => {
  it('rejects a missing sessionId', async () => {
    await expect(resolveTranscriptRead({ sessionId: undefined as unknown as string, agentId: null }, transcriptReadDepsWith({}))).rejects.toThrow(
      "'transcript:read' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an empty sessionId', async () => {
    await expect(resolveTranscriptRead({ sessionId: '', agentId: null }, transcriptReadDepsWith({}))).rejects.toThrow(
      "'transcript:read' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an agentId that is neither a string nor null', async () => {
    await expect(resolveTranscriptRead({ sessionId: 's1', agentId: 42 as unknown as string }, transcriptReadDepsWith({}))).rejects.toThrow(
      "'transcript:read' requires 'agentId' to be a string or null",
    )
  })

  it('opens a cursor through openTranscript, returns its read, and discards the cursor', async () => {
    const read: TranscriptRead = { ok: true, source: {} as never, entries: [] }
    let received: unknown
    const deps = transcriptReadDepsWith({
      openTranscript: (params) => {
        received = params
        return Promise.resolve({ read, cursor: { path: '/t', sessionId: 's1', agentId: null, offset: 10, nextIndex: 0, recordCount: 0, malformedLines: 0, deriver: {} as never } })
      },
    })
    const result = await resolveTranscriptRead({ sessionId: 's1', agentId: null }, deps)
    expect(result).toBe(read)
    expect(received).toEqual({ sessionId: 's1', agentId: null })
  })

  it('surfaces a failed read as-is, with no cursor to discard', async () => {
    const read: TranscriptRead = { ok: false, kind: 'not-found', message: 'No transcript file at /t.', path: '/t' }
    const deps = transcriptReadDepsWith({
      openTranscript: () => Promise.resolve({ read, cursor: null }),
    })
    const result = await resolveTranscriptRead({ sessionId: 's1', agentId: null }, deps)
    expect(result).toBe(read)
  })
})

describe('resolveTranscriptTailOpen', () => {
  it('rejects a missing sessionId', async () => {
    await expect(resolveTranscriptTailOpen({ sessionId: undefined as unknown as string, agentId: null }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:open' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an empty sessionId', async () => {
    await expect(resolveTranscriptTailOpen({ sessionId: '', agentId: null }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:open' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an agentId that is neither a string nor null', async () => {
    await expect(resolveTranscriptTailOpen({ sessionId: 's1', agentId: 42 as unknown as string }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:open' requires 'agentId' to be a string or null",
    )
  })

  it('passes a valid request through to openTail', async () => {
    const response: TranscriptTailOpen = { ok: true, tailId: 'tail-1', source: {} as never, entries: [] }
    let received: unknown
    const deps = tailDepsWith({
      openTail: (params) => {
        received = params
        return Promise.resolve(response)
      },
    })
    const result = await resolveTranscriptTailOpen({ sessionId: 's1', agentId: null }, deps)
    expect(result).toBe(response)
    expect(received).toEqual({ sessionId: 's1', agentId: null })
  })
})

describe('resolveTranscriptTailPoll', () => {
  it('rejects a missing tailId', async () => {
    await expect(resolveTranscriptTailPoll({ tailId: undefined as unknown as string }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:poll' requires a non-empty 'tailId'",
    )
  })

  it('rejects an empty tailId', async () => {
    await expect(resolveTranscriptTailPoll({ tailId: '' }, tailDepsWith({}))).rejects.toThrow("'transcript:tail:poll' requires a non-empty 'tailId'")
  })

  it('passes a valid request through to pollTail', async () => {
    const response: TranscriptTailPoll = { ok: true, source: {} as never, appended: [], patched: [], hasMore: false }
    let received: unknown
    const deps = tailDepsWith({
      pollTail: (params) => {
        received = params
        return Promise.resolve(response)
      },
    })
    const result = await resolveTranscriptTailPoll({ tailId: 'tail-1' }, deps)
    expect(result).toBe(response)
    expect(received).toEqual({ tailId: 'tail-1' })
  })
})

describe('resolveTranscriptTailClose', () => {
  it('rejects a missing tailId', () => {
    expect(() => resolveTranscriptTailClose({ tailId: undefined as unknown as string }, tailDepsWith({}))).toThrow(
      "'transcript:tail:close' requires a non-empty 'tailId'",
    )
  })

  it('passes a valid request through to closeTail', () => {
    let received: unknown
    const deps = tailDepsWith({
      closeTail: (params) => {
        received = params
      },
    })
    resolveTranscriptTailClose({ tailId: 'tail-1' }, deps)
    expect(received).toEqual({ tailId: 'tail-1' })
  })
})
