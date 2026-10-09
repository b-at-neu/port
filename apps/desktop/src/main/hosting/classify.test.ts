// Runs classifyEnd over the shared case table also read by scripts/checks/desktop-hosting.ts.
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
    // 'completed' is decided in handle.ts, never by classifyEnd.
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
