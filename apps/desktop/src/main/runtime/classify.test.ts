// Runs both exported classifiers over the shared case table, so a case naming a function this module no longer exports fails loudly.
import { describe, expect, it } from 'vitest'
import { classifyPreflight, classifyProbeFailure } from '@/main/runtime/classify'
import type { ClassifyPreflightInput, ClassifyProbeFailureInput } from '@/main/runtime/classify'
import cases from '@/main/runtime/classify.cases.json'
import type { RuntimeDiagnosis } from '@/shared/runtime/types'

type Case =
  | { readonly fn: 'classifyPreflight'; readonly name: string; readonly input: ClassifyPreflightInput; readonly expect: RuntimeDiagnosis }
  | { readonly fn: 'classifyProbeFailure'; readonly name: string; readonly input: ClassifyProbeFailureInput; readonly expect: RuntimeDiagnosis }

const table = cases as readonly Case[]

describe('classify — shared case table', () => {
  it('the table covers every RuntimeDiagnosis at least once', () => {
    const diagnoses = new Set(table.map((c) => c.expect))
    const all: readonly RuntimeDiagnosis[] = ['cli-missing', 'bundled-fallback', 'cli-unusable', 'unverified', 'token-stale', 'unauthenticated', 'policy-refused', 'probe-failed']
    for (const diagnosis of all) {
      expect(diagnoses.has(diagnosis)).toBe(true)
    }
  })

  it('the table covers both functions', () => {
    expect(table.some((c) => c.fn === 'classifyPreflight')).toBe(true)
    expect(table.some((c) => c.fn === 'classifyProbeFailure')).toBe(true)
  })

  for (const row of table) {
    it(`${row.fn}: ${row.name}`, () => {
      const actual = row.fn === 'classifyPreflight' ? classifyPreflight(row.input) : classifyProbeFailure(row.input)
      expect(actual).toBe(row.expect)
    })
  }
})
