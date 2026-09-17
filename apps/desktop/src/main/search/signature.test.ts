import { describe, expect, it } from 'vitest'
import { TRIGRAM_SIZE } from '../../shared/search/types'
import { buildSignature, decodeSignature, encodeSignature, mightContain } from './signature'
import { foldCase } from './terms'

function randomText(length: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 '
  let out = ''
  let state = seed
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    out += alphabet[state % alphabet.length]
  }
  return out
}

describe('buildSignature / mightContain', () => {
  it('never produces a false negative: every substring of length >= TRIGRAM_SIZE tests as present', () => {
    for (let seed = 0; seed < 20; seed++) {
      const text = randomText(400, seed)
      const signature = buildSignature(text)
      const folded = foldCase(text)
      for (let start = 0; start < folded.length - TRIGRAM_SIZE; start += 7) {
        const term = folded.slice(start, start + TRIGRAM_SIZE + (start % 5))
        expect(mightContain(signature, term)).toBe(true)
      }
    }
  })

  it('reports false positives only as a rate, never an absolute -- a clearly absent term usually reads absent', () => {
    const signature = buildSignature(randomText(400, 1))
    let falsePositives = 0
    const trials = 200
    for (let i = 0; i < trials; i++) {
      const term = randomText(6, 10_000 + i)
      if (mightContain(signature, term)) falsePositives += 1
    }
    // Not a tight bound -- just enough to catch a signature that always
    // returns true (a Bloom filter that never filters anything).
    expect(falsePositives).toBeLessThan(trials)
  })

  it('a term shorter than TRIGRAM_SIZE has no windows to fail, and always reads as present', () => {
    const signature = buildSignature(randomText(100, 2))
    expect(mightContain(signature, 'zz')).toBe(true)
  })

  it('a term that is genuinely absent from a small, known text reads as absent', () => {
    const signature = buildSignature('the quick brown fox jumps over the lazy dog')
    expect(mightContain(signature, foldCase('zzzqqqxxx'))).toBe(false)
  })
})

describe('encodeSignature / decodeSignature', () => {
  it('round-trips a signature through base64', () => {
    const signature = buildSignature('some searchable text with a needle in it')
    const encoded = encodeSignature(signature)
    const decoded = decodeSignature(signature.bits, encoded)
    expect(decoded.bits).toBe(signature.bits)
    expect(Array.from(decoded.data)).toEqual(Array.from(signature.data))
    expect(mightContain(decoded, foldCase('needle'))).toBe(true)
  })
})
