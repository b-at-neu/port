import { describe, expect, it } from 'vitest'
import { CHANGES_REQUESTED_HEADING, CYCLE_GRANT_LINE, GATE_CLEARED_HEADING, REBASE_DECISIONS_LINE, changesRequestedBody, gateClearedBody } from '@/utils/actions/bodies'

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

  it('appends a Rebase decisions block with one line per decision', () => {
    const body = gateClearedBody('revision', {
      rebaseDecisions: [
        { id: 'D1', path: 'src/money.ts', letter: 'B', label: 'take theirs' },
        { id: 'D2', path: 'src/format.ts', letter: 'C', label: 'keep both rounding modes' },
      ],
    })
    expect(body).toBe(
      `${GATE_CLEARED_HEADING}\nCleared by the operator in port: back to revision.\n\n${REBASE_DECISIONS_LINE}\n- D1 \`src/money.ts\` — **B take theirs**\n- D2 \`src/format.ts\` — **C keep both rounding modes**`,
    )
  })

  it('adds no block for an empty decision list', () => {
    expect(gateClearedBody('revision', { rebaseDecisions: [] })).not.toContain(REBASE_DECISIONS_LINE)
  })

  it('refuses a cycle grant together with rebase decisions', () => {
    expect(() => gateClearedBody('revision', { cycleGrant: true, rebaseDecisions: [{ id: 'D1', path: 'a.ts', letter: 'A', label: 'x' }] })).toThrow()
  })
})

describe('changesRequestedBody', () => {
  it('renders FORMATS.md\'s exact shape, with the note trimmed', () => {
    const body = changesRequestedBody('a'.repeat(40), '  rename the --limit flag to --max  ')
    expect(body).toBe(`${CHANGES_REQUESTED_HEADING}\nRequested by the operator on \`${'a'.repeat(40)}\`, after approval:\n\nrename the --limit flag to --max`)
  })
})
