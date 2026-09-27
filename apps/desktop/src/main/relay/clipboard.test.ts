import { describe, expect, it } from 'vitest'
import { MAX_REPLY_CHARS, copyRelayReply } from './clipboard'

describe('copyRelayReply', () => {
  it('writes a valid string and reports ok', () => {
    let written: string | null = null
    const result = copyRelayReply({ text: 'hello' }, (text) => {
      written = text
    })
    expect(result).toEqual({ ok: true })
    expect(written).toBe('hello')
  })

  it('rejects a non-string payload before touching the writer', () => {
    let called = false
    const result = copyRelayReply({ text: 42 }, () => {
      called = true
    })
    expect(result).toEqual({ ok: false })
    expect(called).toBe(false)
  })

  it('rejects an empty string', () => {
    let called = false
    const result = copyRelayReply({ text: '' }, () => {
      called = true
    })
    expect(result).toEqual({ ok: false })
    expect(called).toBe(false)
  })

  it('rejects a payload over MAX_REPLY_CHARS', () => {
    let called = false
    const result = copyRelayReply({ text: 'x'.repeat(MAX_REPLY_CHARS + 1) }, () => {
      called = true
    })
    expect(result).toEqual({ ok: false })
    expect(called).toBe(false)
  })
})
