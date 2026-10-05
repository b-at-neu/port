// Runs `parseOverrides`/`applyOverrides` over the tick engine's own shared
// case table (`scripts/port-tick/cases/overrides.cases.json`, #246/#300) —
// the same idiom the app's other ported-function tests already use, and the
// same projection `scripts/checks/tick.ts`'s `runCase` applies to the
// engine's own exports. #348 made these functions themselves the engine's
// own (`apps/desktop` imports them directly, no local copy), so this is now
// a direct import rather than a wrapper-shape comparison.
import { describe, expect, it } from 'vitest'
import { applyOverrides, parseOverrides } from '../../../../../scripts/port-tick/overrides'
import type { EffectiveConfigShape, OverrideEntry } from '../../../../../scripts/port-tick/overrides'
import cases from '../../../../../scripts/port-tick/cases/overrides.cases.json'

interface ParseCase {
  readonly function: 'parseOverrides'
  readonly name: string
  readonly input: string
  readonly expected: { readonly paths: readonly string[]; readonly problemReasons: readonly string[] }
}

interface ApplyCase {
  readonly function: 'applyOverrides'
  readonly name: string
  readonly input: { readonly cfg: EffectiveConfigShape; readonly entries: readonly OverrideEntry[]; readonly labelKeys: readonly string[] }
  readonly expected: { readonly appliedPaths: readonly string[]; readonly refusedPaths: readonly (string | null)[] }
}

type Case = ParseCase | ApplyCase

const PORTED_FUNCTIONS = new Set(['parseOverrides', 'applyOverrides'])
const table = (cases.cases as readonly Case[]).filter((c): c is ParseCase | ApplyCase => PORTED_FUNCTIONS.has(c.function))

describe('overrides — shared case table', () => {
  it('the table covers both ported functions', () => {
    for (const fn of PORTED_FUNCTIONS) expect(table.some((c) => c.function === fn)).toBe(true)
  })

  for (const row of table) {
    it(`${row.function} — ${row.name}`, () => {
      if (row.function === 'parseOverrides') {
        const result = parseOverrides(row.input)
        const got = { paths: result.entries.map((e) => `${e.path} ${e.op} ${e.rawValue}`), problemReasons: result.problems.map((p) => p.reason) }
        expect(got).toEqual(row.expected)
        return
      }
      const result = applyOverrides(row.input.cfg, { entries: row.input.entries, problems: [] }, { labelKeys: row.input.labelKeys })
      const got = { appliedPaths: result.applied.map((a) => a.path), refusedPaths: result.refused.map((r) => r.path) }
      expect(got).toEqual(row.expected)
    })
  }
})

// The cockpit's own self-test trio (`scripts/checks/overrides.ts`), reused
// here so the app's use of the engine is held to the same bar: a good block,
// a missing reason, and the permission surface's own refusal.
describe('overrides — self-test trio', () => {
  const baseCfg: EffectiveConfigShape = {
    integration: 'dev',
    production: 'main',
    labels: {},
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 5,
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
  }

  it('a well-formed block is accepted', () => {
    const text = '<!-- port-overrides:begin -->\n```port-overrides\nreviewCycleCap = 3  # we converge in three or it needs a human\n```\n<!-- port-overrides:end -->\n'
    const parsed = parseOverrides(text)
    expect(parsed.problems).toEqual([])
    expect(parsed.entries).toHaveLength(1)
  })

  it('a line with no required reason is refused', () => {
    const text = '<!-- port-overrides:begin -->\n```port-overrides\nreviewCycleCap = 3\n```\n<!-- port-overrides:end -->\n'
    const parsed = parseOverrides(text)
    expect(parsed.problems.length).toBeGreaterThan(0)
  })

  it('commands.checks is never overridable — the permission surface', () => {
    const result = applyOverrides(
      baseCfg,
      { entries: [{ path: 'commands.checks', op: '=', rawValue: 'node x.ts', reason: 'refused', line: '' }], problems: [] },
      { labelKeys: [] },
    )
    expect(result.applied).toEqual([])
    expect(result.refused).toHaveLength(1)
  })
})
