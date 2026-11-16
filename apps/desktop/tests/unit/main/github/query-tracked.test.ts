import { describe, expect, it } from 'vitest'
import { buildTrackedItemsQuery } from '@/main/github/query'

describe('buildTrackedItemsQuery', () => {
  it('aliases each tracked item by position and selects the sweep fields by number, never by label', () => {
    const { document, aliases } = buildTrackedItemsQuery([
      { kind: 'issue', number: 7 },
      { kind: 'pull-request', number: 7 },
    ])
    expect(aliases).toEqual([
      { alias: 't0', kind: 'issue', number: 7 },
      { alias: 't1', kind: 'pull-request', number: 7 },
    ])
    const lines = document.split('\n')
    expect(lines.find((line) => line.includes('t0:'))).toContain('t0: issue(number: 7) { number title url body state updatedAt')
    expect(lines.find((line) => line.includes('t1:'))).toContain('t1: pullRequest(number: 7)')
    expect(lines.find((line) => line.includes('t1:'))).toContain('headRefOid mergeable')
    expect(document).not.toContain('labels: [')
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})
