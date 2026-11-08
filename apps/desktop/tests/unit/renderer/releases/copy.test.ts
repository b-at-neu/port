import { describe, expect, it } from 'vitest'
import { mergedSinceCopy, noMergedPrsCopy, versionOptionLabel } from '@/renderer/releases/copy'

describe('mergedSinceCopy', () => {
  it('counts PRs since the last tag, singular and plural', () => {
    expect(mergedSinceCopy(5, 'v0.2.0')).toBe('5 PRs merged since v0.2.0')
    expect(mergedSinceCopy(1, 'v0.2.0')).toBe('1 PR merged since v0.2.0')
  })

  it('says there is no release yet when there is no tag', () => {
    expect(mergedSinceCopy(12, null)).toBe('12 PRs merged, no release yet')
    expect(mergedSinceCopy(1, null)).toBe('1 PR merged, no release yet')
  })
})

describe('noMergedPrsCopy', () => {
  it('names the integration branch and the tag', () => {
    expect(noMergedPrsCopy('dev', 'v0.2.0')).toBe('No PRs merged into dev since v0.2.0.')
  })

  it('has its own copy when there is no release', () => {
    expect(noMergedPrsCopy('dev', null)).toBe('No PRs merged into dev yet.')
  })
})

describe('versionOptionLabel', () => {
  it('shows the version and its bump kind, with no recommendation', () => {
    expect(versionOptionLabel({ kind: 'patch', version: '0.14.1' })).toBe('0.14.1 — patch')
  })
})
