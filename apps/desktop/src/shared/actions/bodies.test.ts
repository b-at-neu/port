import { describe, expect, it } from 'vitest'
import { CHANGES_REQUESTED_HEADING, CYCLE_GRANT_LINE, GATE_CLEARED_HEADING, changesRequestedBody, gateClearedBody } from './bodies'

describe('gateClearedBody', () => {
  it('names revision for the revision route', () => {
    expect(gateClearedBody('revision')).toBe(`${GATE_CLEARED_HEADING}\nCleared by the operator in port: back to revision.`)
  })

  it('names review for the review route', () => {
    expect(gateClearedBody('review')).toBe(`${GATE_CLEARED_HEADING}\nCleared by the operator in port: back to review.`)
  })

  it('omits the cycle-grant block by default', () => {
    expect(gateClearedBody('revision')).not.toContain(CYCLE_GRANT_LINE)
  })

  it('appends a Cycle grant block when cycleGrant is set', () => {
    const body = gateClearedBody('revision', { cycleGrant: true })
    expect(body).toBe(
      `${GATE_CLEARED_HEADING}\nCleared by the operator in port: back to revision.\n\n${CYCLE_GRANT_LINE}\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.`,
    )
  })
})

describe('changesRequestedBody', () => {
  it('renders FORMATS.md\'s exact shape, with the note trimmed', () => {
    const body = changesRequestedBody('a'.repeat(40), '  rename the --limit flag to --max  ')
    expect(body).toBe(`${CHANGES_REQUESTED_HEADING}\nRequested by the operator on \`${'a'.repeat(40)}\`, after approval:\n\nrename the --limit flag to --max`)
  })
})
