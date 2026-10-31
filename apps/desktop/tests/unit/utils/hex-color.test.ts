import { describe, expect, it } from 'vitest'
import { isHexColor } from '@/utils/hex-color'

describe('isHexColor', () => {
  it.each(['d73a4a', 'D73A4A', '000000'])('accepts %s', (value) => {
    expect(isHexColor(value)).toBe(true)
  })

  it.each(['', 'nothex', '#d73a4a', 'd73a4', 'd73a4a0'])('rejects %j', (value) => {
    expect(isHexColor(value)).toBe(false)
  })
})
