// Runs `classifyEnd` over the shared case table (`classify.cases.json`) —
// the same file `scripts/checks/desktop-hosting.ts` resolves every case
// against, so an edit here or there that drifts the two apart fails loudly.
import { describe, expect, it } from 'vitest'
import { classifyEnd } from './classify'
import type { ClassifyEndInput, ClassifyEndResult } from './classify'
import cases from './classify.cases.json'
import type { SessionEndReason } from '../../shared/hosting/types'

interface Case {
  readonly name: string
  readonly input: ClassifyEndInput
  readonly expect: ClassifyEndResult
}

const table = cases as readonly Case[]

describe('classifyEnd — shared case table', () => {
  it('the table covers every SessionEndReason at least once', () => {
    const reasons = new Set(table.map((c) => c.expect.reason))
    const all: readonly SessionEndReason[] = ['completed', 'closed', 'exit-nonzero', 'signal', 'process-error', 'stream-error', 'resume-rejected']
    // 'completed' is never classifyEnd's own output — a clean generator finish
    // is decided in handle.ts before classifyEnd is ever called — so it is
    // excluded from this table's own coverage requirement.
    for (const reason of all.filter((r) => r !== 'completed')) {
      expect(reasons.has(reason)).toBe(true)
    }
  })

  for (const row of table) {
    it(row.name, () => {
      expect(classifyEnd(row.input)).toEqual(row.expect)
    })
  }
})
