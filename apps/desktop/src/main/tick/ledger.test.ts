import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from './ledger'
import { classifyUnmatched } from './liveness'

const REPO = 'repo-1' as RepoId
const OTHER = 'repo-2' as RepoId

describe('createDispatchLedger', () => {
  it('a never-recorded item reads no-record forever', () => {
    const ledger = createDispatchLedger()
    expect(ledger.rowFor(REPO, 1)).toBeUndefined()
    expect(classifyUnmatched(ledger.rowFor(REPO, 1))).toEqual({ class: 'no-record' })
  })

  it('record then advance walks dispatched -> suspect -> reset, one row per repo', () => {
    const ledger = createDispatchLedger()
    ledger.record(REPO, 105)
    expect(ledger.rowFor(REPO, 105)).toEqual({ state: 'dispatched', resets: 0 })
    expect(ledger.rowFor(OTHER, 105)).toBeUndefined()

    const suspect = classifyUnmatched(ledger.rowFor(REPO, 105))
    ledger.advance(REPO, 105, suspect)
    expect(ledger.rowFor(REPO, 105)).toEqual({ state: 'suspect', resets: 0 })

    const reset = classifyUnmatched(ledger.rowFor(REPO, 105))
    expect(reset.class).toBe('reset')
    ledger.advance(REPO, 105, reset)
    expect(ledger.rowFor(REPO, 105)).toEqual({ state: 'reset', resets: 1 })
  })

  it('capped and no-record results never write — advance is a no-op without nextState', () => {
    const ledger = createDispatchLedger()
    ledger.record(REPO, 7)
    ledger.advance(REPO, 7, { class: 'no-record' })
    expect(ledger.rowFor(REPO, 7)).toEqual({ state: 'dispatched', resets: 0 })

    ledger.advance(REPO, 7, { class: 'capped' })
    expect(ledger.rowFor(REPO, 7)).toEqual({ state: 'dispatched', resets: 0 })
  })

  it('a redispatch after a confirmed reset carries the resets count forward, never back to zero', () => {
    const ledger = createDispatchLedger()
    ledger.record(REPO, 9)
    ledger.advance(REPO, 9, { class: 'reset', nextState: 'reset', nextResets: 1 })
    expect(ledger.rowFor(REPO, 9)).toEqual({ state: 'reset', resets: 1 })

    ledger.record(REPO, 9)
    expect(ledger.rowFor(REPO, 9)).toEqual({ state: 'dispatched', resets: 1 })
  })
})

describe('observeUnmatched', () => {
  it('advances at most once per distinct readAt, memoizing a repeated snapshot', () => {
    const ledger = createDispatchLedger()
    ledger.record(REPO, 105)
    const first = ledger.observeUnmatched(REPO, 105, '2026-01-01T00:00:00Z')
    expect(first.class).toBe('suspect')
    expect(ledger.rowFor(REPO, 105)).toEqual({ state: 'suspect', resets: 0 })

    // Same read — never advances again, even though the row would now
    // classify as 'reset' if re-run.
    const repeated = ledger.observeUnmatched(REPO, 105, '2026-01-01T00:00:00Z')
    expect(repeated).toEqual(first)
    expect(ledger.rowFor(REPO, 105)).toEqual({ state: 'suspect', resets: 0 })

    // A genuinely new read advances again.
    const second = ledger.observeUnmatched(REPO, 105, '2026-01-02T00:00:00Z')
    expect(second.class).toBe('reset')
    expect(ledger.rowFor(REPO, 105)).toEqual({ state: 'reset', resets: 1 })
  })

  it('a null readAt classifies without ever advancing or memoizing', () => {
    const ledger = createDispatchLedger()
    ledger.record(REPO, 7)
    expect(ledger.observeUnmatched(REPO, 7, null)).toEqual({ class: 'suspect', nextState: 'suspect', nextResets: 0 })
    expect(ledger.rowFor(REPO, 7)).toEqual({ state: 'dispatched', resets: 0 })
    expect(ledger.observeUnmatched(REPO, 7, null)).toEqual({ class: 'suspect', nextState: 'suspect', nextResets: 0 })
  })
})

describe('createRefreshMemo', () => {
  it('a never-set entry reads undefined', () => {
    const memo = createRefreshMemo()
    expect(memo.get(REPO, 1)).toBeUndefined()
  })

  it('set then get round-trips, scoped per repo', () => {
    const memo = createRefreshMemo()
    memo.set(REPO, 42, { sha: 'abc123', count: 1 })
    expect(memo.get(REPO, 42)).toEqual({ sha: 'abc123', count: 1 })
    expect(memo.get(OTHER, 42)).toBeUndefined()
  })

  it('clear removes the entry', () => {
    const memo = createRefreshMemo()
    memo.set(REPO, 42, { sha: 'abc123', count: 1 })
    memo.clear(REPO, 42)
    expect(memo.get(REPO, 42)).toBeUndefined()
  })
})

describe('createUnknownStreaks', () => {
  it('a never-recorded item reads 0', () => {
    const streaks = createUnknownStreaks()
    expect(streaks.get(REPO, 1)).toBe(0)
  })

  it('set then get round-trips, scoped per repo', () => {
    const streaks = createUnknownStreaks()
    streaks.set(REPO, 42, 1)
    expect(streaks.get(REPO, 42)).toBe(1)
    expect(streaks.get(OTHER, 42)).toBe(0)
  })

  it('clear resets back to 0', () => {
    const streaks = createUnknownStreaks()
    streaks.set(REPO, 42, 1)
    streaks.clear(REPO, 42)
    expect(streaks.get(REPO, 42)).toBe(0)
  })
})
