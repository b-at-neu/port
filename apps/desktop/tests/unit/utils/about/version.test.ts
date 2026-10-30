import { describe, expect, it } from 'vitest'
import { formatAppVersion } from '@/utils/about/version'

describe('formatAppVersion', () => {
  it('appends the commit to a prerelease version', () => {
    expect(formatAppVersion('0.4.1-dev', '3eaf312')).toBe('0.4.1-dev · 3eaf312')
  })

  it('appends a dirty commit to a prerelease version', () => {
    expect(formatAppVersion('0.4.1-dev', '3eaf312+dirty')).toBe('0.4.1-dev · 3eaf312+dirty')
  })

  it('drops the suffix when a prerelease has no commit', () => {
    expect(formatAppVersion('0.4.1-dev', null)).toBe('0.4.1-dev')
  })

  it('never appends a commit to a clean version', () => {
    expect(formatAppVersion('0.4.1', '3eaf312')).toBe('0.4.1')
  })

  it('treats an empty-string commit like no commit', () => {
    expect(formatAppVersion('0.4.1-dev', '')).toBe('0.4.1-dev')
  })
})
