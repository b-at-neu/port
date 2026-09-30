// Runs the ported `zeroDiffGate`/`cycleCapExceeded` over the tick engine's
// own shared case table (`scripts/port-tick/cases/gates.cases.json`) —
// filtered to the two functions this app ports, the same idiom
// `contention.test.ts` already uses. The table's own review shape nests
// `commit.oid`; this app's `ReviewNode` flattens it to `commitOid`
// (`main/github/map.ts`'s own `reviewNodesOf`) — adapted at the edge here,
// never inside `gates.ts` itself.
import { describe, expect, it } from 'vitest'
import { codeReviewCount, cycleCapExceeded, zeroDiffGate } from './gates'
import type { ReviewNode } from './gates'
import cases from '../../../../../scripts/port-tick/cases/gates.cases.json'

interface RawReview {
  readonly body: string
  readonly submittedAt?: string
  readonly commit?: { readonly oid: string }
}

function toReviewNode(raw: RawReview): ReviewNode {
  return { body: raw.body, submittedAt: raw.submittedAt, commitOid: raw.commit?.oid ?? null }
}

interface ZeroDiffCase {
  readonly function: 'zeroDiffGate'
  readonly name: string
  readonly input: { readonly reviews: readonly RawReview[]; readonly comments: readonly { readonly body: string; readonly createdAt: string }[]; readonly headRefOid: string }
  readonly expected: { readonly action: string }
}

interface CycleCapCase {
  readonly function: 'cycleCapExceeded'
  readonly name: string
  readonly input: readonly [readonly RawReview[], number]
  readonly expected: boolean
}

type Case = ZeroDiffCase | CycleCapCase | { readonly function: string; readonly name: string }

const table = (cases.cases as readonly Case[]).filter((c): c is ZeroDiffCase | CycleCapCase => c.function === 'zeroDiffGate' || c.function === 'cycleCapExceeded')

describe('gates — shared case table', () => {
  it('the table covers both ported functions', () => {
    expect(table.some((c) => c.function === 'zeroDiffGate')).toBe(true)
    expect(table.some((c) => c.function === 'cycleCapExceeded')).toBe(true)
  })

  for (const row of table) {
    it(`${row.function} — ${row.name}`, () => {
      if (row.function === 'zeroDiffGate') {
        const { reviews, comments, headRefOid } = row.input
        expect(zeroDiffGate({ reviews: reviews.map(toReviewNode), comments, headRefOid })).toEqual(row.expected)
        return
      }
      const [reviews, cap] = row.input
      expect(cycleCapExceeded(reviews.map(toReviewNode), cap)).toBe(row.expected)
    })
  }
})

describe('codeReviewCount', () => {
  it('counts reviews whose body starts with the literal ## Code Review prefix', () => {
    const reviews: ReviewNode[] = [
      { body: '## Code Review — Cycle 1 · needs revision' },
      { body: '## Code Review — Cycle 2 · approved' },
      { body: 'an unrelated comment that is not a review' },
    ]
    expect(codeReviewCount(reviews)).toBe(2)
  })

  it('is 0 for undefined — never throws on a missing connection', () => {
    expect(codeReviewCount(undefined)).toBe(0)
  })
})
