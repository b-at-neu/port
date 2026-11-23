import { describe, expect, it } from 'vitest'
import { CASES, isParentImport } from '../../../eslint/no-parent-import.mjs'
import { COLOUR_PATTERNS, CSS_COLOUR_PATTERNS } from '../../../eslint/no-raw-colour.mjs'

describe('port/no-parent-import', () => {
  it.each(CASES)('isParentImport($file, $spec) is $flagged', ({ file, spec, flagged }) => {
    expect(isParentImport(file, spec)).toBe(flagged)
  })
})

describe('port/no-raw-colour patterns', () => {
  it.each([...COLOUR_PATTERNS, ...CSS_COLOUR_PATTERNS])('$id rejects its bad example and accepts its good one', ({ source, flags, good, bad }) => {
    const re = new RegExp(source, flags)
    expect(re.test(bad)).toBe(true)
    expect(re.test(good)).toBe(false)
  })
})
