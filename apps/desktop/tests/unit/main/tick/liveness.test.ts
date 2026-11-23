// Runs classifyUnmatched over the case table.
import { describe, expect, it } from 'vitest'
import { classifyUnmatched } from '@/utils/pipeline/liveness'
import type { LedgerRow, UnmatchedResult } from '@/utils/pipeline/liveness'
import cases from './cases/liveness.cases.json'

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
