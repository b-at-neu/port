import { describe, expect, it } from 'vitest'
import { folderLabel } from './label'

describe('folderLabel', () => {
  it('returns the last posix segment', () => {
    expect(folderLabel('/home/you/src/widgets')).toBe('widgets')
  })

  it('returns the last windows segment', () => {
    expect(folderLabel('C:\\Users\\you\\src\\widgets')).toBe('widgets')
  })

  it('ignores a trailing separator', () => {
    expect(folderLabel('/home/you/src/widgets/')).toBe('widgets')
  })

  it('returns a drive root itself', () => {
    expect(folderLabel('C:\\')).toBe('C:')
  })
})
