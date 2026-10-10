import { describe, expect, it } from 'vitest'
import { readResult } from './result'
import type { SDKMessage } from './sdk'

const AT = '2026-01-01T00:00:00.000Z'

describe('readResult', () => {
  it('returns null for a non-result message', () => {
    expect(readResult({ type: 'system', subtype: 'init' } as unknown as SDKMessage, AT)).toBeNull()
  })

  it('reads a success result, carrying its text verbatim', () => {
    const message = { type: 'result', subtype: 'success', is_error: false, result: 'all done' } as unknown as SDKMessage
    expect(readResult(message, AT)).toEqual({ subtype: 'success', isError: false, text: 'all done', at: AT })
  })

  it('reads an error result with no string result as text: null, never coerced', () => {
    const message = { type: 'result', subtype: 'error_max_turns', is_error: true } as unknown as SDKMessage
    expect(readResult(message, AT)).toEqual({ subtype: 'error_max_turns', isError: true, text: null, at: AT })
  })

  it('caps text at the tail, since a hand-back prefix sits at the end', () => {
    const long = 'x'.repeat(9000) + 'BLOCKED: at the tail'
    const message = { type: 'result', subtype: 'success', is_error: false, result: long } as unknown as SDKMessage
    const read = readResult(message, AT)
    expect(read?.text?.length).toBe(8000)
    expect(read?.text?.endsWith('BLOCKED: at the tail')).toBe(true)
  })
})
