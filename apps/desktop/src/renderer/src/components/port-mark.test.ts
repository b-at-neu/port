import { describe, expect, it } from 'vitest'
import portMarkSvg from '../../../../../../docs/design/port-mark.svg?raw'
import { markPaths } from './port-mark'

describe('markPaths', () => {
  it('extracts every path d value from the real mark, in order', () => {
    const paths = markPaths(portMarkSvg)
    expect(paths).toHaveLength(3)
    expect(paths[0]).toContain('M12 3c3.6 2.7 5.5 6 5.9 9.2H12z')
  })

  it('returns no paths for a mark with none', () => {
    expect(markPaths('<svg></svg>')).toEqual([])
  })
})
