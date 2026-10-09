// Runs zeroDiffGate/cycleCapExceeded/etc over the tick engine's own shared case table; these are
// the engine's own functions. The table's review shape nests commit.oid, so toReviewNode adapts it.
import { describe, expect, it } from 'vitest'
import { approvedReverify, capRefreshes, codeReviewCount, cycleCapExceeded, mergeabilityRoute, refreshDecision, refreshWins, zeroDiffGate } from '../../../../../scripts/port-tick/gates'
import type { ReviewNode } from '../../../../../scripts/port-tick/gates'
import { toReviewNode } from '../../../../../scripts/port-tick/wire'
import cases from '../../../../../scripts/port-tick/cases/gates.cases.json'

interface RawReview {
  readonly body: string
  readonly submittedAt?: string
  readonly commit?: { readonly oid: string }
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
  readonly input: readonly [readonly RawReview[], number] | readonly [readonly RawReview[], number, readonly { readonly body: string; readonly createdAt: string }[]]
  readonly expected: boolean
}

interface MergeabilityRouteCase {
  readonly function: 'mergeabilityRoute'
  readonly name: string
  readonly input: readonly [string, number]
  readonly expected: { readonly action: string; readonly unknownStreak: number }
}

interface RefreshWinsCase {
  readonly function: 'refreshWins'
  readonly name: string
  readonly input: { readonly number: number; readonly refreshBranch: readonly number[]; readonly refreshing: readonly number[] }
  readonly expected: { readonly action: string; readonly label?: string }
}

interface RefreshDecisionCase {
  readonly function: 'refreshDecision'
  readonly name: string
  readonly input: readonly [{ readonly sha: string; readonly count: number } | null, string]
  readonly expected: { readonly action: string; readonly reason?: string; readonly count: number }
}

interface CapRefreshesCase {
  readonly function: 'capRefreshes'
  readonly name: string
  readonly input: readonly [readonly { readonly number: number }[], number]
  readonly expected: { readonly toRefreshNumbers: readonly number[]; readonly deferredNumbers: readonly number[] }
}

interface ApprovedReverifyCase {
  readonly function: 'approvedReverify'
  readonly name: string
  readonly input: {
    readonly verdict: { readonly pending: boolean; readonly red: readonly { readonly name: string | null; readonly conclusion: string | null }[]; readonly green: readonly (string | null)[] }
    readonly mergeable: string
  }
  readonly expected: { readonly action: string }
}

type Case =
  | ZeroDiffCase
  | CycleCapCase
  | MergeabilityRouteCase
  | RefreshWinsCase
  | RefreshDecisionCase
  | CapRefreshesCase
  | ApprovedReverifyCase
  | { readonly function: string; readonly name: string }

const PORTED_FUNCTIONS = new Set(['zeroDiffGate', 'cycleCapExceeded', 'mergeabilityRoute', 'refreshWins', 'refreshDecision', 'capRefreshes', 'approvedReverify'])
const table = (cases.cases as readonly Case[]).filter(
  (c): c is ZeroDiffCase | CycleCapCase | MergeabilityRouteCase | RefreshWinsCase | RefreshDecisionCase | CapRefreshesCase | ApprovedReverifyCase => PORTED_FUNCTIONS.has(c.function),
)

describe('gates — shared case table', () => {
  it('the table covers all seven ported functions', () => {
    for (const fn of PORTED_FUNCTIONS) expect(table.some((c) => c.function === fn)).toBe(true)
  })

  for (const row of table) {
    it(`${row.function} — ${row.name}`, () => {
      if (row.function === 'zeroDiffGate') {
        const { reviews, comments, headRefOid } = row.input
        expect(zeroDiffGate({ reviews: reviews.map(toReviewNode), comments, headRefOid })).toEqual(row.expected)
        return
      }
      if (row.function === 'cycleCapExceeded') {
        const [reviews, cap, comments] = row.input
        expect(cycleCapExceeded(reviews.map(toReviewNode), cap, comments)).toBe(row.expected)
        return
      }
      if (row.function === 'mergeabilityRoute') {
        const [mergeable, priorUnknownStreak] = row.input
        expect(mergeabilityRoute(mergeable, priorUnknownStreak)).toEqual(row.expected)
        return
      }
      if (row.function === 'refreshWins') {
        expect(refreshWins(row.input)).toEqual(row.expected)
        return
      }
      if (row.function === 'refreshDecision') {
        const [memoEntry, currentSha] = row.input
        expect(refreshDecision(memoEntry ?? undefined, currentSha)).toEqual(row.expected)
        return
      }
      if (row.function === 'capRefreshes') {
        const [candidates, max] = row.input
        const result = capRefreshes(candidates, max)
        expect({ toRefreshNumbers: result.toRefresh.map((c) => c.number), deferredNumbers: result.deferred.map((c) => c.number) }).toEqual(row.expected)
        return
      }
      expect(approvedReverify(row.input)).toEqual(row.expected)
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
