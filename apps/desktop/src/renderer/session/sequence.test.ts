import { describe, expect, it } from 'vitest'
import { accept, drainBuffered } from './sequence'

describe('accept', () => {
  it('applies exactly the next revision', () => {
    expect(accept(3, { revision: 4 })).toBe('apply')
  })

  it('treats a revision at or below the last as stale', () => {
    expect(accept(3, { revision: 3 })).toBe('stale')
    expect(accept(3, { revision: 1 })).toBe('stale')
  })

  it('treats anything past the next revision as a gap', () => {
    expect(accept(3, { revision: 6 })).toBe('gap')
  })
})

describe('drainBuffered', () => {
  it('drops deltas at or below attachRevision and applies the rest in order', () => {
    const buffered = [{ revision: 2, v: 'b' }, { revision: 4, v: 'd' }, { revision: 3, v: 'c' }, { revision: 1, v: 'a' }]
    const result = drainBuffered(2, buffered)
    expect(result).toEqual({ kind: 'apply', deltas: [{ revision: 3, v: 'c' }, { revision: 4, v: 'd' }] })
  })

  it('reports a gap when a revision was missed entirely', () => {
    const buffered = [{ revision: 5, v: 'e' }]
    expect(drainBuffered(2, buffered)).toEqual({ kind: 'gap' })
  })

  it('applies an empty list when nothing was buffered', () => {
    expect(drainBuffered(2, [])).toEqual({ kind: 'apply', deltas: [] })
  })

  it('ignores an exact duplicate of the next-expected revision reaching it twice', () => {
    const buffered = [{ revision: 3, v: 'first' }, { revision: 3, v: 'duplicate' }]
    const result = drainBuffered(2, buffered)
    expect(result).toEqual({ kind: 'apply', deltas: [{ revision: 3, v: 'first' }] })
  })
})
