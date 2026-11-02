import { describe, expect, it } from 'vitest'
import {
  allowLine,
  ceilingSecondsFrom,
  closeRows,
  exceededLine,
  formatDuration,
  holdLine,
  issueFromPrBody,
  parseDescriptionList,
  parseLedger,
  parseSessionLog,
  renderLedger,
  renderSessionLog,
  renderTickClause,
  reportLedger,
  sessionLogName,
  sessionTotals,
  verdict,
} from '@/main/dispatch/budget-ledger'
import type { LedgerRow, SessionRow } from '@/types/budget'

const ROW: LedgerRow = { stage: 'impl', model: 'sonnet', startedAt: '2026-09-05T14:00:00.000Z', seconds: 120, outcome: 'completed' }

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return { issue: 52, dispatchNumber: 52, stage: 'impl', model: 'sonnet', startedAt: '2026-09-05T14:00:00.000Z', state: 'open', seconds: 0, outcome: '', ...overrides }
}

describe('formatDuration', () => {
  it.each([
    [0, '0m 00s'],
    [59, '0m 59s'],
    [3599, '59m 59s'],
    [3600, '1h 00m'],
    [7322, '2h 02m'],
  ])('%i seconds is %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})

describe('renderLedger', () => {
  it('renders a singular dispatch against a ceiling, rounding the percentage', () => {
    expect(renderLedger([ROW], 7200)).toBe(
      [
        '## Pipeline Cost',
        '',
        '| Stage | Model | Started (UTC) | Seconds | Outcome |',
        '| --- | --- | --- | --- | --- |',
        '| impl | sonnet | 2026-09-05T14:00:00.000Z | 120 | completed |',
        '',
        '**Total:** 1 dispatch · 120s (2m 00s) of 7200s (120m) — 2%',
      ].join('\n'),
    )
  })

  it('renders plural dispatches with no ceiling', () => {
    expect(renderLedger([ROW, ROW], null).endsWith('**Total:** 2 dispatches · 240s (4m 00s) — no ceiling configured')).toBe(true)
  })

  it('renders an empty ledger', () => {
    expect(renderLedger([], null).endsWith('**Total:** 0 dispatches · 0s (0m 00s) — no ceiling configured')).toBe(true)
  })
})

describe('parseLedger', () => {
  it('round-trips renderLedger', () => {
    expect(parseLedger(renderLedger([ROW, { ...ROW, seconds: 5 }], 3600))).toEqual({ rows: [ROW, { ...ROW, seconds: 5 }] })
  })

  it.each([
    ['no heading', '| Stage | Model | Started (UTC) | Seconds | Outcome |\n| --- | --- | --- | --- | --- |'],
    ['no header', '## Pipeline Cost\n\nnothing here'],
    ['bad separator', '## Pipeline Cost\n\n| Stage | Model | Started (UTC) | Seconds | Outcome |\nnot a separator'],
    ['fewer than five cells', '## Pipeline Cost\n\n| Stage | Model | Started (UTC) | Seconds | Outcome |\n| --- | --- | --- | --- | --- |\n| impl | sonnet | x |'],
    ['non-integer seconds', '## Pipeline Cost\n\n| Stage | Model | Started (UTC) | Seconds | Outcome |\n| --- | --- | --- | --- | --- |\n| impl | sonnet | x | 1.5 | ok |'],
    ['negative seconds', '## Pipeline Cost\n\n| Stage | Model | Started (UTC) | Seconds | Outcome |\n| --- | --- | --- | --- | --- |\n| impl | sonnet | x | -1 | ok |'],
  ])('rejects %s', (_name, markdown) => {
    expect(parseLedger(markdown)).toBeNull()
  })
})

describe('verdict', () => {
  it('allows with no ceiling, and below it', () => {
    expect(verdict({ secondsUsed: 10_000, ceilingSeconds: null })).toBe('allow')
    expect(verdict({ secondsUsed: 99, ceilingSeconds: 100 })).toBe('allow')
  })

  it('is exceeded at the ceiling', () => {
    expect(verdict({ secondsUsed: 100, ceilingSeconds: 100 })).toBe('exceeded')
  })
})

describe('parseDescriptionList', () => {
  it('splits well-formed entries from invalid ones', () => {
    expect(parseDescriptionList('impl #52, bogus ,review #9,')).toEqual({ descriptions: ['impl #52', 'review #9'], invalid: ['bogus'] })
  })
})

describe('closeRows', () => {
  const NOW = Date.parse('2026-09-05T14:02:00.000Z')

  it('keeps a live row open and closes the rest as lost', () => {
    const result = closeRows([session(), session({ issue: 7, dispatchNumber: 7, stage: 'plan' })], ['impl #52'], NOW)
    expect(result.stillOpen).toHaveLength(1)
    expect(result.closed).toEqual([session({ issue: 7, dispatchNumber: 7, stage: 'plan', state: 'pending', seconds: 120, outcome: 'lost' })])
  })

  it('closes a row named completed as completed', () => {
    const result = closeRows([session()], [], NOW, ['impl #52'])
    expect(result.closed[0]).toMatchObject({ outcome: 'completed', state: 'pending', seconds: 120 })
  })

  it('times an unparseable start as zero but still closes it', () => {
    expect(closeRows([session({ startedAt: 'nope' })], [], NOW).closed[0]).toMatchObject({ seconds: 0, outcome: 'lost' })
  })
})

describe('session log', () => {
  it('round-trips through render and parse', () => {
    const rows = [session({ outcome: 'lost' }), session({ state: 'closed', seconds: 30, outcome: 'completed', dispatchNumber: 213 })]
    expect(parseSessionLog(renderSessionLog(rows))).toEqual(rows)
  })

  it('reads an unknown state as open, bad seconds as zero, and a missing dispatch as the issue', () => {
    expect(parseSessionLog('52\timpl\tsonnet\t2026-09-05T14:00:00.000Z\tweird\tabc\t\t')).toEqual([session({ outcome: 'lost' })])
  })

  it('renders an empty log as an empty string', () => {
    expect(renderSessionLog([])).toBe('')
  })
})

describe('sessionTotals / renderTickClause', () => {
  const NOW = Date.parse('2026-09-05T14:01:00.000Z')

  it('counts an open row by its elapsed time and a closed row by its seconds', () => {
    expect(sessionTotals([session(), session({ state: 'closed', seconds: 30 })], NOW)).toEqual({ dispatches: 2, seconds: 90 })
  })

  it('prints only the session half without tickets', () => {
    expect(renderTickClause({ dispatches: 1, seconds: 125 }, [])).toBe('**Budget:** session 1 dispatch · 2m 05s agent wall-clock')
  })

  it('appends a per-ticket half, with and without a ceiling', () => {
    const clause = renderTickClause({ dispatches: 2, seconds: 0 }, [
      { issue: 52, secondsUsed: 60, ceilingSeconds: 120 },
      { issue: 7, secondsUsed: 60, ceilingSeconds: null },
    ])
    expect(clause).toBe('**Budget:** session 2 dispatches · 0m 00s agent wall-clock · #52 at 1m 00s of its 2m ceiling (50%) · #7 at 1m 00s, no ceiling configured')
  })
})

describe('ceilingSecondsFrom', () => {
  it.each([[undefined], [{}], [{ budget: {} }], [{ budget: { wallClockMinutes: null } }]])('reads %j as unbounded', (cfg) => {
    expect(ceilingSecondsFrom(cfg)).toEqual({ ok: true, ceilingSeconds: null })
  })

  it('converts minutes to seconds', () => {
    expect(ceilingSecondsFrom({ budget: { wallClockMinutes: 120 } })).toEqual({ ok: true, ceilingSeconds: 7200 })
  })

  it.each([['120'], [0], [-1], [1.5]])('refuses malformed %j', (minutes) => {
    expect(ceilingSecondsFrom({ budget: { wallClockMinutes: minutes } })).toEqual({ ok: false, offending: JSON.stringify(minutes) })
  })
})

describe('issueFromPrBody / sessionLogName', () => {
  it('reads Closes #N from the first line only', () => {
    expect(issueFromPrBody('Closes #52\n\nbody')).toBe(52)
    expect(issueFromPrBody('intro\nCloses #52')).toBeNull()
  })

  it('names the session log, and refuses a malformed session', () => {
    expect(sessionLogName(undefined)).toBe('budget-session.tsv')
    expect(sessionLogName('desktop')).toBe('budget-session-desktop.tsv')
    expect(sessionLogName('Bad Name')).toBeNull()
  })
})

describe('verdict lines', () => {
  it('holdLine', () => {
    expect(holdLine(52, 'boom')).toBe("⏳ Couldn't read #52's cost ledger (boom) — holding its dispatch one tick rather than dispatching blind.")
  })

  it('exceededLine', () => {
    expect(exceededLine(52, 7200, 7200, 'impl')).toBe('⛔ #52 has consumed 2h 00m of agent wall-clock against a 120m ceiling — escalate instead of dispatching impl #52.')
  })

  it('allowLine, with and without a ceiling', () => {
    expect(allowLine(52, 180, 7200)).toBe('✅ #52 dispatch allowed — 3m 00s of its 120m ceiling used.')
    expect(allowLine(52, 180, null)).toBe('✅ #52 dispatch allowed — 3m 00s of agent wall-clock so far, no ceiling configured.')
  })
})

describe('reportLedger', () => {
  it('pairs the rendered ledger with its verdict', () => {
    expect(reportLedger([ROW], 120)).toEqual({ markdown: renderLedger([ROW], 120), verdict: 'exceeded' })
  })
})
