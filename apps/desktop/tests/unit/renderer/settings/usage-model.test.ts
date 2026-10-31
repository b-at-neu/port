import { describe, expect, it } from 'vitest'
import { formatBytes, sizeText, usageCell, usageFootnote } from '@/renderer/settings/usage-model'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [38 * 1024 ** 2, '38.0 MB'],
    [Math.round(1.2 * 1024 ** 3), '1.2 GB'],
  ])('formats %d as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

describe('sizeText', () => {
  it('prefixes a truncated walk with over, never presenting an undercount as exact', () => {
    expect(sizeText({ ok: true, bytes: 4.1 * 1024 ** 3, truncated: true })).toBe('over 4.1 GB')
  })

  it('reads a failed read as Couldn’t read, never 0', () => {
    expect(sizeText({ ok: false, message: 'EACCES' })).toBe("Couldn't read")
  })
})

describe('usageCell', () => {
  it('joins cost and tokens', () => {
    expect(usageCell({ costUsd: 1.23, totalTokens: 450_000, sessions: 3 })).toBe('$1.23 · 450k tokens')
  })

  it('reads an all-null period as a dash, never $0.00', () => {
    expect(usageCell({ costUsd: null, totalTokens: null, sessions: 0 })).toBe('—')
  })
})

describe('usageFootnote', () => {
  it('names the date the ledger starts counting from', () => {
    expect(usageFootnote(new Date(2026, 9, 24, 12).toISOString())).toBe('Counts sessions port hosted, from Oct 24. Kept for 30 days.')
  })

  it('omits the date with no records', () => {
    expect(usageFootnote(null)).toBe('Counts sessions port hosted. Kept for 30 days.')
  })
})
