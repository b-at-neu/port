import { describe, expect, it } from 'vitest'
import { classifyHandback } from './handback'
import type { ClassifyHandbackParams } from './handback'

const BASE: ClassifyHandbackParams = { lastResult: null, end: null, rateLimit: null, usage: null, phase: 'streaming' }

describe('classifyHandback', () => {
  it('returns null while still working — not ended, no result yet', () => {
    expect(classifyHandback(BASE)).toBeNull()
  })

  it('classifies completed on a success result with no QUESTIONS/BLOCKED marker', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'All done, pull request opened.', at: 'now' } })
    expect(result).toEqual({ kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed' })
  })

  it('classifies questions when the last paragraph starts with QUESTIONS FOR HUMAN:', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'Some context.\n\nQUESTIONS FOR HUMAN:\n- which branch?', at: 'now' } })
    expect(result?.kind).toBe('questions')
    expect(result?.worktree).toBe('kept')
  })

  it('classifies blocked when a BLOCKED: line sits at line start outside a fence', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'success', isError: false, text: 'Tried the thing.\nBLOCKED: denied command xyz', at: 'now' } })
    expect(result).toEqual({ kind: 'blocked', detail: 'BLOCKED: denied command xyz', costUsd: null, resetsAt: null, worktree: 'kept' })
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
    expect(result).toEqual({ kind: 'usage-limit', detail: null, costUsd: null, resetsAt: '2026-01-01T15:00:00Z', worktree: 'kept' })
  })

  it('classifies error on any other error result, naming the subtype and first line', () => {
    const result = classifyHandback({ ...BASE, lastResult: { subtype: 'error_max_turns', isError: true, text: 'ran out of turns\nmore detail', at: 'now' } })
    expect(result).toEqual({ kind: 'error', detail: 'error_max_turns: ran out of turns', costUsd: null, resetsAt: null, worktree: 'kept' })
  })

  it('classifies interrupted when the phase ended with no lastResult at all', () => {
    const result = classifyHandback({ ...BASE, phase: 'ended', end: { reason: 'closed', exitCode: null, signal: null, message: null, diagnosis: null } })
    expect(result).toEqual({ kind: 'interrupted', detail: 'closed', costUsd: null, resetsAt: null, worktree: 'kept' })
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
