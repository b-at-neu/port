// Runs `parseFilesBlock`/`gateCandidates` over the tick engine's own shared
// case table — the same file `scripts/checks/tick.ts` runs these same
// exports over. #348 made this module itself the engine's own
// (`apps/desktop` imports it directly, no local copy).
import { describe, expect, it } from 'vitest'
import { gateCandidates, parseFilesBlock } from '../../../../../scripts/port-tick/contention'
import type { ClaimedItem, OccupiedEntry } from '../../../../../scripts/port-tick/contention'
import cases from '../../../../../scripts/port-tick/cases/contention.cases.json'

interface ParseFilesBlockCase {
  readonly function: 'parseFilesBlock'
  readonly name: string
  readonly input: string
  readonly expected: readonly string[] | null
}

interface GateCandidatesCase {
  readonly function: 'gateCandidates'
  readonly name: string
  readonly input: {
    readonly candidates: readonly ClaimedItem[]
    readonly occupiedSet: readonly OccupiedEntry[]
    readonly sharedFiles: readonly string[]
    readonly threshold: number
  }
  readonly expected: { readonly dispatch: readonly number[]; readonly heldItems: readonly number[] }
}

type Case = ParseFilesBlockCase | GateCandidatesCase

const table = cases.cases as readonly Case[]

describe('contention — shared case table', () => {
  it('the table covers the fail-open row, the threshold boundary, the sharedFiles excusal, and fewest-conflicts-first', () => {
    expect(table.some((c) => c.name.includes('unstructured'))).toBe(true)
    expect(table.some((c) => c.name.includes('at threshold'))).toBe(true)
    expect(table.some((c) => c.name.includes('sharedFiles'))).toBe(true)
    expect(table.some((c) => c.name.includes('fewest-conflicts-first'))).toBe(true)
  })

  for (const row of table) {
    it(`${row.function} — ${row.name}`, () => {
      if (row.function === 'parseFilesBlock') {
        expect(parseFilesBlock(row.input)).toEqual(row.expected)
        return
      }
      const { candidates, occupiedSet, sharedFiles, threshold } = row.input
      const result = gateCandidates(candidates, occupiedSet, sharedFiles, threshold)
      expect({ dispatch: result.dispatch, heldItems: result.held.map((h) => h.item) }).toEqual(row.expected)
    })
  }
})
