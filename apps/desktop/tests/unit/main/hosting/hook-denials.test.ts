import { describe, expect, it } from 'vitest'
import { GUARD_ALLOWLIST_MISS_MARKER } from '@/main/hosting/guard-marker'
import { createHookDenialTracker } from '@/main/hosting/hook-denials'
import { STAGE_DENY_MESSAGE } from '@/main/hosting/stage-policy'

function call(id: string, command: string): unknown {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }
}

function result(id: string, content: unknown, isError = true): unknown {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } }
}

const MISS = `${GUARD_ALLOWLIST_MISS_MARKER}, so it is denied for dispatched agents.`

describe('createHookDenialTracker', () => {
  it('pairs an allowlist-miss string result with its tool_use', () => {
    const tracker = createHookDenialTracker()
    expect(tracker.observe(call('a', 'cp x y'))).toEqual([])
    expect(tracker.observe(result('a', MISS))).toEqual([{ toolName: 'Bash', input: { command: 'cp x y' } }])
  })

  it('reads a block-array result by joining its text blocks', () => {
    const tracker = createHookDenialTracker()
    tracker.observe(call('a', 'cp x y'))
    const hits = tracker.observe(result('a', [{ type: 'text', text: 'PreToolUse hook:' }, { type: 'text', text: MISS }]))
    expect(hits).toHaveLength(1)
  })

  it('ignores a result that is not an error', () => {
    const tracker = createHookDenialTracker()
    tracker.observe(call('a', 'cp x y'))
    expect(tracker.observe(result('a', MISS, false))).toEqual([])
  })

  it.each([
    ['the stage policy message', STAGE_DENY_MESSAGE],
    ['a sessionRequiredPaths reason', 'port: .claude/settings.json matches sessionRequiredPaths — a dispatched agent cannot edit it by any route.'],
  ])('ignores an error with another reason: %s', (_name, text) => {
    const tracker = createHookDenialTracker()
    tracker.observe(call('a', 'cp x y'))
    expect(tracker.observe(result('a', text))).toEqual([])
  })

  it('returns nothing for a result with no paired call', () => {
    expect(createHookDenialTracker().observe(result('missing', MISS))).toEqual([])
  })

  it('reports a call once and never again', () => {
    const tracker = createHookDenialTracker()
    tracker.observe(call('a', 'cp x y'))
    expect(tracker.observe(result('a', MISS))).toHaveLength(1)
    expect(tracker.observe(result('a', MISS))).toEqual([])
  })

  it('returns nothing for malformed messages', () => {
    const tracker = createHookDenialTracker()
    expect(tracker.observe(null)).toEqual([])
    expect(tracker.observe('text')).toEqual([])
    expect(tracker.observe({ type: 'user', message: 3 })).toEqual([])
    expect(tracker.observe({ type: 'user', message: { content: [null, { type: 'tool_result' }] } })).toEqual([])
  })
})
