// A GitHub label's colour is repository data, so this is the one place a hex becomes a style.
const HEX_COLOR = /^[0-9a-f]{6}$/i

function channel(hex: string, start: number): number {
  const value = parseInt(hex.slice(start, start + 2), 16) / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 2) + 0.0722 * channel(hex, 4)
}

// Whichever of black and white contrasts more is always at least 4.5:1.
export function labelChipColors(color: string | null): { readonly background: string; readonly text: 'black' | 'white' } | null {
  if (color === null || !HEX_COLOR.test(color)) return null
  const fill = luminance(color)
  const againstBlack = (fill + 0.05) / 0.05
  const againstWhite = 1.05 / (fill + 0.05)
  return { background: `#${color}`, text: againstBlack >= againstWhite ? 'black' : 'white' }
}
