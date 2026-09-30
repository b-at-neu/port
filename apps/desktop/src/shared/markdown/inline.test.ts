import { describe, expect, it } from 'vitest'
import { parseInline } from './inline'

describe('parseInline', () => {
  it('parses a plain literal run as one text node', () => {
    expect(parseInline('hello world')).toEqual([{ kind: 'text', value: 'hello world' }])
  })

  it('parses a code span, trimmed, with no inline parsing inside', () => {
    expect(parseInline('see `**not bold**` here')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'code', value: '**not bold**' },
      { kind: 'text', value: ' here' },
    ])
  })

  it('parses a code span delimited by a longer backtick run, embedding a literal backtick', () => {
    expect(parseInline('``a ` b``')).toEqual([{ kind: 'code', value: 'a ` b' }])
  })

  it('parses strong text, recursing into its own children', () => {
    expect(parseInline('**bold *and* italic**')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', value: 'bold ' }, { kind: 'emphasis', children: [{ kind: 'text', value: 'and' }] }, { kind: 'text', value: ' italic' }] },
    ])
  })

  it('parses emphasis text', () => {
    expect(parseInline('*em*')).toEqual([{ kind: 'emphasis', children: [{ kind: 'text', value: 'em' }] }])
  })

  it('parses a link with an allowed https href', () => {
    expect(parseInline('see [the plan](https://example.com/92)')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', text: 'the plan', href: 'https://example.com/92' },
    ])
  })

  it('parses a link with an allowed http href', () => {
    expect(parseInline('[x](http://example.com)')).toEqual([{ kind: 'link', text: 'x', href: 'http://example.com' }])
  })

  it.each(['javascript:alert(1)', 'mailto:a@b.com', '/relative/path', 'ftp://example.com'])(
    'renders a link with a rejected scheme (%s) as literal text, never a link node',
    (href) => {
      const result = parseInline(`[x](${href})`)
      expect(result).toEqual([{ kind: 'text', value: `[x](${href})` }])
    },
  )

  it('never emits a link node for image syntax — the leading ! suppresses it', () => {
    const result = parseInline('![alt text](https://example.com/x.png)')
    expect(result).toEqual([{ kind: 'text', value: '![alt text](https://example.com/x.png)' }])
  })

  it('never emits a link for a bare relative GitHub path', () => {
    const result = parseInline('[#79](../79)')
    expect(result.every((node) => node.kind !== 'link')).toBe(true)
  })

  it('coalesces literal runs around a span rather than emitting one node per character', () => {
    const result = parseInline('a b c `code` d e f')
    expect(result).toEqual([{ kind: 'text', value: 'a b c ' }, { kind: 'code', value: 'code' }, { kind: 'text', value: ' d e f' }])
  })

  it('treats an unclosed strong delimiter as literal text', () => {
    expect(parseInline('**no close')).toEqual([{ kind: 'text', value: '**no close' }])
  })

  it('treats an unclosed code span delimiter as literal text', () => {
    expect(parseInline('`no close')).toEqual([{ kind: 'text', value: '`no close' }])
  })
})
