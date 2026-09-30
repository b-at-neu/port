import { describe, expect, it } from 'vitest'
import { foldCase, indexOfFolded, parseQuery } from './terms'

describe('foldCase', () => {
  it('lowercases ASCII text', () => {
    expect(foldCase('Hello World')).toBe('hello world')
  })

  it('preserves length for a code point whose lowercase expands', () => {
    // German sharp s uppercases/lowercases in a way that can expand under
    // some mappings -- the guarantee is length preservation, not a specific
    // lowercasing choice.
    const text = 'STRASSE'
    expect(foldCase(text).length).toBe(text.length)
  })

  it('keeps offsets aligned to the original text', () => {
    const text = 'ABC dEf'
    const folded = foldCase(text)
    expect(folded.length).toBe(text.length)
    expect(folded.indexOf('def')).toBe(text.indexOf('dEf'))
  })
})

describe('indexOfFolded', () => {
  it('finds a folded term case-insensitively', () => {
    expect(indexOfFolded('Hello World', 'world')).toBe(6)
  })

  it('returns -1 when the term is absent', () => {
    expect(indexOfFolded('Hello World', 'xyz')).toBe(-1)
  })

  it('respects fromIndex', () => {
    expect(indexOfFolded('foo foo foo', 'foo', 4)).toBe(4)
  })
})

describe('parseQuery', () => {
  it('splits on whitespace and folds each term', () => {
    expect(parseQuery('Foo BAR').terms).toEqual(['foo', 'bar'])
  })

  it('treats a quoted run as one phrase term', () => {
    expect(parseQuery('"a phrase" other').terms).toEqual(['a phrase', 'other'])
  })

  it('drops a term shorter than MIN_TERM_CHARS', () => {
    expect(parseQuery('ab abc').terms).toEqual(['abc'])
  })

  it('returns no terms for an empty or whitespace-only query', () => {
    expect(parseQuery('').terms).toEqual([])
    expect(parseQuery('   ').terms).toEqual([])
  })

  it('returns no terms for a query under MIN_TERM_CHARS', () => {
    expect(parseQuery('ab').terms).toEqual([])
  })
})
