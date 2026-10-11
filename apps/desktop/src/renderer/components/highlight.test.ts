import { describe, expect, it } from 'vitest'
import { highlightTokens, MAX_HIGHLIGHT_CHARS } from './highlight'

describe('highlightTokens', () => {
  it('returns one plain-text run for a null language', () => {
    expect(highlightTokens('const x = 1', null)).toEqual([{ text: 'const x = 1', role: null }])
  })

  it('returns one plain-text run for an unsupported language', () => {
    expect(highlightTokens('x', 'brainfuck')).toEqual([{ text: 'x', role: null }])
  })

  it('returns one plain-text run for code over the character cap', () => {
    const code = 'a'.repeat(MAX_HIGHLIGHT_CHARS + 1)
    expect(highlightTokens(code, 'ts')).toEqual([{ text: code, role: null }])
  })

  it('marks a keyword with the keyword role for a supported language', () => {
    const runs = highlightTokens('const x = 1', 'ts')
    expect(runs.some((run) => run.role === 'keyword' && run.text === 'const')).toBe(true)
  })

  it('resolves the ts/tsx/js/jsx/sh/html aliases', () => {
    expect(highlightTokens('const x = 1', 'tsx').some((run) => run.role === 'keyword')).toBe(true)
    expect(highlightTokens('ls -la', 'sh').length).toBeGreaterThan(0)
    expect(highlightTokens('<div></div>', 'html').length).toBeGreaterThan(0)
  })

  it('reassembles to the original source', () => {
    const code = 'function f() {\n  return 1\n}\n'
    const runs = highlightTokens(code, 'ts')
    expect(runs.map((run) => run.text).join('')).toBe(code)
  })
})
