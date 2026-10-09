// Runs over the shared case table also run against the reclaimer's own `correlate` export, so the two ladders can never silently disagree.
import { describe, expect, it } from 'vitest'
import { correlate } from './correlate'
import type { CorrelationInput } from './correlate'
import cases from './correlation.cases.json'

interface Case {
  readonly name: string
  readonly input: CorrelationInput
  readonly expect: { readonly number: number; readonly rung: string } | null
}

const table = cases as readonly Case[]

describe('correlate — shared case table', () => {
  it('the table covers all four rung names, a #0 case, and a null case', () => {
    const rungs = new Set(table.map((c) => c.expect?.rung).filter((r): r is string => r !== undefined))
    for (const rung of ['upstream-branch', 'branch-name', 'directory-basename', 'head-subject']) {
      expect(rungs.has(rung)).toBe(true)
    }
    expect(table.some((c) => c.name.includes('#0'))).toBe(true)
    expect(table.some((c) => c.expect === null)).toBe(true)
  })

  for (const row of table) {
    it(row.name, () => {
      expect(correlate(row.input)).toEqual(row.expect)
    })
  }
})
