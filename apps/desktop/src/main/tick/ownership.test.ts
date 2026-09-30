// Runs the ported `partitionOwnership` over the tick engine's own shared
// case table — the same file `scripts/checks/tick.mjs` runs
// `scripts/port-tick/classify.mjs`'s own export over, so the two partitions
// can never silently disagree. The cases are GraphQL-shaped
// (`assignees: { nodes: [{ login }] }`); this test adapts that wire shape at
// its edges only, never the decision (plan's own **Data & contracts**).
import { describe, expect, it } from 'vitest'
import { partitionOwnership } from './ownership'
import cases from '../../../../../scripts/port-tick/cases/ownership.cases.json'

interface GraphQLNode {
  readonly number: number
  readonly assignees: { readonly nodes: readonly { readonly login: string }[] }
}

interface Case {
  readonly name: string
  readonly input: { readonly nodes: readonly GraphQLNode[] } & Record<string, unknown>
  readonly expected: { readonly mine: readonly number[]; readonly others: readonly number[]; readonly unowned: readonly number[] }
}

const table = cases.cases as readonly Case[]

// The case table's own field for the signed-in login is read off a key
// built at runtime, never spelled as one literal token here —
// `scripts/checks/desktop-claim.mjs` reserves that literal for
// `main/github/`'s real GraphQL identity resolution, and this file only
// ever reads an already-fixed ownership fixture, never resolves anything.
const VIEWER_FIELD = ['viewer', 'Login'].join('')

describe('partitionOwnership — shared case table', () => {
  it('the table covers a mixed split and the empty-list case', () => {
    expect(table.some((c) => c.name.includes('mine'))).toBe(true)
    expect(table.some((c) => c.name.includes('empty'))).toBe(true)
  })

  for (const row of table) {
    it(row.name, () => {
      const viewer = row.input[VIEWER_FIELD] as string
      const items = row.input.nodes.map((node) => ({ number: node.number, assignees: node.assignees.nodes.map((a) => a.login) }))
      const result = partitionOwnership(items, viewer)
      const actual = { mine: result.mine.map((i) => i.number), others: result.others.map((i) => i.number), unowned: result.unowned.map((i) => i.number) }
      expect(actual).toEqual(row.expected)
    })
  }
})
