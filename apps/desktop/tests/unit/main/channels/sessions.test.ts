import { describe, expect, it } from 'vitest'
import { resolveTranscriptTailClose, resolveTranscriptTailOpen, resolveTranscriptTailPoll } from '@/main/channels/sessions'
import type { TranscriptTailDeps } from '@/main/channels/sessions'

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
})

describe('resolveTranscriptTailClose', () => {
  it('rejects a missing tailId', () => {
    expect(() => resolveTranscriptTailClose({ tailId: undefined as unknown as string }, tailDepsWith({}))).toThrow(
      "'transcript:tail:close' requires a non-empty 'tailId'",
    )
  })
})
