import { describe, expect, it } from 'vitest'
import { classifyHandback, isTransientNetworkFailure } from '@/main/pipeline/handback'
import type { ClassifyHandbackParams } from '@/main/pipeline/handback'

const BASE: ClassifyHandbackParams = { lastResult: null, end: null, rateLimit: null, usage: null, phase: 'streaming', operatorJoinedAt: null }

describe('classifyHandback', () => {
  it('returns null while still working — not ended, no result yet', () => {
    expect(classifyHandback(BASE)).toBeNull()
  })

  it('classifies completed on a success result with no QUESTIONS/BLOCKED marker', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'All done, pull request opened.', at: 'now' } })
    expect(result).toEqual({ kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: null })
  })

  it('carries a HANDBACK: line on completed, token and argument split', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'Opened it.\n\nHANDBACK: pr-opened #8', at: 'now' } })
    expect(result).toMatchObject({ kind: 'completed', handback: { token: 'pr-opened', arg: '#8' } })
  })

  it('treats a review that ends HANDBACK: checks-pending as finished, never blocked', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'BLOCKED: checks never concluded\n\nHANDBACK: checks-pending', at: 'now' } })
    expect(result).toMatchObject({ kind: 'completed', handback: { token: 'checks-pending', arg: null } })
  })

  it('lets questions win over a HANDBACK: line in an earlier paragraph', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'HANDBACK: plan-written\n\nQUESTIONS FOR HUMAN:\n- which branch?', at: 'now' } })
    expect(result?.kind).toBe('questions')
    expect(result?.handback).toBeNull()
  })

  it('classifies questions when the last paragraph starts with QUESTIONS FOR HUMAN:', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'Some context.\n\nQUESTIONS FOR HUMAN:\n- which branch?', at: 'now' } })
    expect(result?.kind).toBe('questions')
    expect(result?.worktree).toBe('kept')
  })

  it('classifies blocked when a BLOCKED: line sits at line start outside a fence', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'Tried the thing.\nBLOCKED: denied command xyz', at: 'now' } })
    expect(result).toEqual({ kind: 'blocked', detail: 'BLOCKED: denied command xyz', costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null })
  })

  it('does not count a BLOCKED: line inside a fenced code block', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'Example output:\n```\nBLOCKED: not a real one\n```\nAll clear.', at: 'now' } })
    expect(result?.kind).toBe('completed')
  })

  it('classifies usage-limit on an error result with a rejected rate limit', () => {
    const result = classifyHandback({
      ...BASE,
      lastResult: { subtype: 'error_during_execution', isError: true, text: 'hit the wall', at: 'now' },
      rateLimit: { status: 'rejected', window: 'five-hour', resetsAt: '2026-01-01T15:00:00Z', observedAt: 'now' },
    })
    expect(result).toEqual({ kind: 'usage-limit', detail: null, costUsd: null, resetsAt: '2026-01-01T15:00:00Z', worktree: 'kept', operatorJoined: false, handback: null })
  })

  it('classifies error on any other error result, naming the subtype and first line', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'error_max_turns', isError: true, text: 'ran out of turns\nmore detail', at: 'now' } })
    expect(result).toEqual({ kind: 'error', detail: 'error_max_turns: ran out of turns', costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null })
  })

  it.each(['getaddrinfo EAI_AGAIN api.anthropic.com', "API Error: Can't reach the API server (EAI_AGAIN)", 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'fetch failed', 'socket hang up', 'getaddrinfo ENOTFOUND x', 'connect ECONNREFUSED 127.0.0.1:1'])(
    'classifies a network error result (%s) as interrupted, so no label is written',
    (text) => {
      const result = classifyHandback({ ...BASE, lastResult: { subtype: 'error_during_execution', isError: true, text, at: 'now' } })
      expect(result).toMatchObject({ kind: 'interrupted', handback: null, worktree: 'kept' })
      expect(isTransientNetworkFailure(result?.detail)).toBe(true)
    },
  )

  it('matches network text case-insensitively and nothing else', () => {
    expect(isTransientNetworkFailure('Fetch Failed')).toBe(true)
    expect(isTransientNetworkFailure('ran out of turns')).toBe(false)
    expect(isTransientNetworkFailure(null)).toBe(false)
  })

  it('classifies interrupted when the phase ended with no lastResult at all', () => {
    const result = classifyHandback({ ...BASE, phase: 'ended', end: { reason: 'closed', exitCode: null, signal: null, message: null, diagnosis: null } })
    expect(result).toEqual({ kind: 'interrupted', detail: 'closed', costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null })
  })

  it('sets operatorJoined true when operatorJoinedAt is non-null', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'done', at: 'now' }, operatorJoinedAt: '2026-01-01T00:05:00.000Z' })
    expect(result?.operatorJoined).toBe(true)
  })

  it('always reads costUsd from usage, regardless of outcome', () => {
    const result = classifyHandback({
      ...BASE,
      lastResult: { subtype: 'success', isError: false, text: 'done', at: 'now' },
      usage: { costUsd: 1.84, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextTokens: null, contextWindow: null, observedAt: 'now' },
    })
    expect(result?.costUsd).toBe(1.84)
  })
})
