// Runs the ported `reduceRollup`/`isConcluded`/`rollupVerdict` over the tick
// engine's own shared case table (`scripts/port-tick/cases/checks.cases.json`,
// #292) — the same idiom `gates.test.ts` already uses for its own four
// ported functions. `reduceRollup`'s own cockpit implementation spreads an
// internal `t` memo field onto its result for its own `rollupVerdict` to
// read; this app's port never materializes that field, so the one
// `reduceRollup` case strips it before comparing.
import { describe, expect, it } from 'vitest'
import { conclusionOf, isConcluded, reduceRollup, rollupVerdict } from './checks'
import type { Disposition } from './checks'
import type { CheckContext } from '../../shared/github/types'
import cases from '../../../../../scripts/port-tick/cases/checks.cases.json'

interface RawContext {
  readonly __typename?: 'CheckRun' | 'StatusContext'
  readonly name?: string
  readonly context?: string
  readonly conclusion?: string
  readonly status?: string
  readonly state?: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly createdAt?: string
}

function toCheckContext(raw: RawContext): CheckContext {
  return {
    __typename: raw.__typename ?? null,
    name: raw.name ?? raw.context ?? null,
    conclusion: raw.conclusion ?? null,
    status: raw.status ?? null,
    state: raw.state ?? null,
    startedAt: raw.startedAt ?? null,
    completedAt: raw.completedAt ?? null,
    createdAt: raw.createdAt ?? null,
    url: null,
  }
}

interface ReduceRollupCase {
  readonly function: 'reduceRollup'
  readonly name: string
  readonly input: readonly RawContext[]
  readonly expected: readonly RawContext[]
}

interface IsConcludedCase {
  readonly function: 'isConcluded'
  readonly name: string
  readonly input: RawContext
  readonly expected: boolean
}

interface RollupVerdictCase {
  readonly function: 'rollupVerdict'
  readonly name: string
  readonly input: readonly [{ readonly contexts: { readonly nodes: readonly RawContext[] } }, Readonly<Record<string, Disposition>>]
  readonly expected: unknown
}

type Case = ReduceRollupCase | IsConcludedCase | RollupVerdictCase | { readonly function: string; readonly name: string }

const PORTED_FUNCTIONS = new Set(['reduceRollup', 'isConcluded', 'rollupVerdict'])
const table = (cases.cases as readonly Case[]).filter((c): c is ReduceRollupCase | IsConcludedCase | RollupVerdictCase => PORTED_FUNCTIONS.has(c.function))

describe('checks — shared case table', () => {
  it('the table covers all three ported functions', () => {
    for (const fn of PORTED_FUNCTIONS) expect(table.some((c) => c.function === fn)).toBe(true)
  })

  for (const row of table) {
    it(`${row.function} — ${row.name}`, () => {
      if (row.function === 'reduceRollup') {
        const got = reduceRollup(row.input.map(toCheckContext))
        const expected = row.expected.map((e) => toCheckContext(e))
        expect(got).toEqual(expected)
        return
      }
      if (row.function === 'isConcluded') {
        expect(isConcluded(toCheckContext(row.input))).toBe(row.expected)
        return
      }
      const [rollup, dispositions] = row.input
      expect(rollupVerdict(rollup.contexts.nodes.map(toCheckContext), dispositions)).toEqual(row.expected)
    })
  }
})

describe('conclusionOf', () => {
  it('reads a CheckRun conclusion', () => {
    expect(conclusionOf(toCheckContext({ __typename: 'CheckRun', conclusion: 'SUCCESS' }))).toBe('SUCCESS')
  })

  it('falls back to a StatusContext state', () => {
    expect(conclusionOf(toCheckContext({ __typename: 'StatusContext', state: 'SUCCESS' }))).toBe('SUCCESS')
  })
})
