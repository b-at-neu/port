import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { markPaths } from './port-mark'

const SVG_PATH = fileURLToPath(new URL('../../../../../../docs/design/port-mark.svg', import.meta.url))

describe('markPaths', () => {
  it('extracts every path d value from the real mark, in order', () => {
    const svg = readFileSync(SVG_PATH, 'utf8')
    const paths = markPaths(svg)
    expect(paths).toHaveLength(3)
    expect(paths[0]).toContain('M12 3c3.6 2.7 5.5 6 5.9 9.2H12z')
  })

  it('returns no paths for a mark with none', () => {
    expect(markPaths('<svg></svg>')).toEqual([])
  })
})
