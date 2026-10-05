// Runs `classifyUnmatched` over the tick engine's own shared case table —
// the same file `scripts/checks/tick.ts` runs this same export over. #348
// made this module itself the engine's own (`apps/desktop` imports it
// directly, no local copy).
import { describe, expect, it } from 'vitest'
import { classifyUnmatched } from '../../../../../scripts/port-tick/liveness'
import type { LedgerRow, UnmatchedResult } from '../../../../../scripts/port-tick/liveness'
import cases from '../../../../../scripts/port-tick/cases/liveness.cases.json'

interface Case {
  readonly name: string
  readonly input: LedgerRow | null
  readonly expected: UnmatchedResult
}

const table = cases.cases as readonly Case[]

describe('classifyUnmatched — shared case table', () => {
  it('the table covers all four classes', () => {
    const classes = new Set(table.map((c) => c.expected.class))
    for (const cls of ['no-record', 'suspect', 'reset', 'capped'] as const) {
      expect(classes.has(cls)).toBe(true)
    }
  })

  for (const row of table) {
    it(row.name, () => {
      expect(classifyUnmatched(row.input ?? undefined)).toEqual(row.expected)
    })
  }
})
