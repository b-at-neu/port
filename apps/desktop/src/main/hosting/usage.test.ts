import { describe, expect, it } from 'vitest'
import { readUsage } from './usage'

const OBSERVED_AT = '2026-01-05T12:00:00.000Z'

describe('readUsage', () => {
  it('returns previous unchanged for a non-object message', () => {
    expect(readUsage('nope', null, OBSERVED_AT)).toBeNull()
  })

  it('returns previous unchanged for an unrelated message type', () => {
    const previous = { model: 'claude', usage: { costUsd: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextTokens: null, contextWindow: null, observedAt: OBSERVED_AT } }
    expect(readUsage({ type: 'system' }, previous, OBSERVED_AT)).toBe(previous)
  })

  it('ignores a subagent assistant turn (non-null parent_tool_use_id)', () => {
    const message = { type: 'assistant', parent_tool_use_id: 'tool_1', message: { model: 'claude-x', usage: { input_tokens: 10 } } }
    expect(readUsage(message, null, OBSERVED_AT)).toBeNull()
  })

  it('reads contextTokens and model from an assistant message with usage', () => {
    const message = { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2 } } }
    const result = readUsage(message, null, OBSERVED_AT)
    expect(result?.model).toBe('claude-x')
    expect(result?.usage.contextTokens).toBe(17)
  })

  it('leaves a malformed assistant usage unchanged', () => {
    const previous = { model: 'claude-x', usage: { costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextTokens: 17, contextWindow: null, observedAt: OBSERVED_AT } }
    const message = { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-x', usage: { input_tokens: 'nope' } } }
    expect(readUsage(message, previous, OBSERVED_AT)).toBe(previous)
  })

  it('reads cost and summed token fields from a result message', () => {
    const message = {
      type: 'result',
      total_cost_usd: 0.42,
      modelUsage: {
        'claude-x': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, contextWindow: 200_000 },
      },
    }
    const previous = { model: 'claude-x', usage: { costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextTokens: 42, contextWindow: null, observedAt: OBSERVED_AT } }
    const result = readUsage(message, previous, OBSERVED_AT)
    expect(result?.usage.costUsd).toBe(0.42)
    expect(result?.usage.inputTokens).toBe(100)
    expect(result?.usage.outputTokens).toBe(50)
    expect(result?.usage.cacheReadTokens).toBe(10)
    expect(result?.usage.cacheWriteTokens).toBe(5)
    expect(result?.usage.contextWindow).toBe(200_000)
    // contextTokens carries over from the previous assistant reading, never reset by a result.
    expect(result?.usage.contextTokens).toBe(42)
  })

  it('sums modelUsage across multiple models', () => {
    const message = {
      type: 'result',
      total_cost_usd: 1,
      modelUsage: {
        a: { inputTokens: 10, outputTokens: 5 },
        b: { inputTokens: 20, outputTokens: 15 },
      },
    }
    const result = readUsage(message, null, OBSERVED_AT)
    expect(result?.usage.inputTokens).toBe(30)
    expect(result?.usage.outputTokens).toBe(20)
  })

  it('returns previous unchanged for a result with neither cost nor modelUsage', () => {
    const previous = { model: null, usage: { costUsd: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, contextTokens: null, contextWindow: null, observedAt: OBSERVED_AT } }
    expect(readUsage({ type: 'result' }, previous, OBSERVED_AT)).toBe(previous)
  })
})
