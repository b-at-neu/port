import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import { createDispatchLedger } from './ledger'
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
