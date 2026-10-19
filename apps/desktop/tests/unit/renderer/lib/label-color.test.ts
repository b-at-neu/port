import { describe, expect, it } from 'vitest'
import { labelChipColors } from '@/renderer/lib/label-color'

function linear(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  return 0.2126 * linear(parseInt(h.slice(0, 2), 16)) + 0.7152 * linear(parseInt(h.slice(2, 4), 16)) + 0.0722 * linear(parseInt(h.slice(4, 6), 16))
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [Math.max(luminance(a), luminance(b)), Math.min(luminance(a), luminance(b))]
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT_HEX = { black: '000000', white: 'ffffff' }

// GitHub's default label colours plus the extremes and the mid-grey that is hardest to read.
const COLORS = ['000000', 'ffffff', '777777', 'd73a4a', '0075ca', 'cfd3d7', 'a2eeef', 'd876e3', 'e4e669', '7057ff', '008672', 'b60205', 'd93f0b', 'fbca04', '0e8a16', '006b75', '1d76db', '0052cc', '5319e7', 'e99695', 'f9d0c4', 'fef2c0', 'c2e0c6', 'bfdadc', 'c5def5', 'bfd4f2', 'd4c5f9']

describe('labelChipColors', () => {
  it('is null for a null or malformed colour', () => {
    expect(labelChipColors(null)).toBeNull()
    expect(labelChipColors('nothex')).toBeNull()
  })

  it.each(COLORS)('reads at least 4.5:1 on %s', (color) => {
    const colors = labelChipColors(color)
    expect(colors).not.toBeNull()
    expect(ratio(TEXT_HEX[colors!.text], colors!.background)).toBeGreaterThanOrEqual(4.5)
  })

  it('uses black on a light fill and white on a dark one', () => {
    expect(labelChipColors(TEXT_HEX.white)).toEqual({ background: `#${TEXT_HEX.white}`, text: 'black' })
    expect(labelChipColors(TEXT_HEX.black)).toEqual({ background: `#${TEXT_HEX.black}`, text: 'white' })
  })
})
