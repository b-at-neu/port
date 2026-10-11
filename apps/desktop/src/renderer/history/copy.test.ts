import { describe, expect, it } from 'vitest'
import { failureCopy, footnote } from './copy'

describe('failureCopy', () => {
  it('names the message for sdk-failed and projects-unreadable', () => {
    expect(failureCopy('sdk-failed', 'boom')).toContain('boom')
    expect(failureCopy('projects-unreadable', 'denied')).toContain('denied')
  })

  it('has fixed copy for the other kinds', () => {
    expect(failureCopy('sdk-unavailable', '')).toContain('Agent SDK')
    expect(failureCopy('claude-home-missing', '')).toContain('No projects directory')
  })
})

describe('footnote', () => {
  it('is null when both counts are zero', () => {
    expect(footnote(0, 0)).toBeNull()
  })

  it('pluralizes each count independently', () => {
    expect(footnote(1, 0)).toBe("1 session couldn't be located on disk.")
    expect(footnote(0, 1)).toBe('1 agent record was unreadable.')
    expect(footnote(2, 2)).toBe("2 sessions couldn't be located on disk · 2 agent records were unreadable.")
  })
})
