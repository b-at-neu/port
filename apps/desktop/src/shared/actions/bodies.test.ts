import { describe, expect, it } from 'vitest'
import { CHANGES_REQUESTED_HEADING, GATE_CLEARED_HEADING, changesRequestedBody, gateClearedBody } from './bodies'

describe('gateClearedBody', () => {
  it('names revision for the revision route', () => {
    expect(gateClearedBody('revision')).toBe(`${GATE_CLEARED_HEADING}\nCleared by the operator in port: back to revision.`)
  })

  it('names review for the review route', () => {
    expect(gateClearedBody('review')).toBe(`${GATE_CLEARED_HEADING}\nCleared by the operator in port: back to review.`)
  })
})

describe('changesRequestedBody', () => {
  it('renders FORMATS.md\'s exact shape, with the note trimmed', () => {
    const body = changesRequestedBody('a'.repeat(40), '  rename the --limit flag to --max  ')
    expect(body).toBe(`${CHANGES_REQUESTED_HEADING}\nRequested by the operator on \`${'a'.repeat(40)}\`, after approval:\n\nrename the --limit flag to --max`)
  })
})
