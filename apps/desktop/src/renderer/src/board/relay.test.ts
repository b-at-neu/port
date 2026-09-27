// Covers the relay module's pure copy functions — the banner and the
// compose form need a DOM, which this workspace's vitest config does not
// provide (`environment: 'node'`, no jsdom/happy-dom installed), the same
// gap `board/tick.test.ts` already documents for its own strip.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RelayPending, RelayScan } from '../../../shared/relay/types'
import { entryLineCopy, relayLineCopy } from './relay'

const NOW = new Date('2026-01-01T00:30:00.000Z')

function pendingOf(overrides: Partial<RelayPending> = {}): RelayPending {
  return {
    repoId: 'repo-a' as RepoId,
    number: 107,
    stage: 'plan-agent',
    sessionId: 's1',
    agentId: null,
    parentSessionLabel: 'cockpit session',
    agentLabel: 'plan-agent #107',
    lastActivityAt: '2026-01-01T00:18:00.000Z',
    kind: 'questions',
    questions: [{ index: 0, text: 'Which branch is base?' }],
    ...overrides,
  } as RelayPending
}

describe('relayLineCopy', () => {
  it('reports nothing waiting, with the checked count, when nothing is pending', () => {
    const scan: RelayScan = { ok: true, pending: [], checked: 6, unreached: 0, scannedAt: NOW.toISOString() }
    expect(relayLineCopy(scan)).toBe('Relay: nothing waiting (6 agents checked).')
  })

  it('names how many are waiting when something is pending', () => {
    const scan: RelayScan = { ok: true, pending: [pendingOf()], checked: 1, unreached: 0, scannedAt: NOW.toISOString() }
    expect(relayLineCopy(scan)).toBe('Relay: 1 waiting on you.')
  })

  it('names an unreadable transcript rather than a false all-clear', () => {
    const scan: RelayScan = { ok: true, pending: [], checked: 6, unreached: 1, scannedAt: NOW.toISOString() }
    expect(relayLineCopy(scan)).toBe("Relay: nothing waiting (6 checked, 1 transcript unreadable — can't tell whether it's waiting).")
  })

  it('reports the scan itself failing, never a reassuring zero', () => {
    const scan: RelayScan = { ok: false, kind: 'claude-home-missing', message: 'no home', scannedAt: NOW.toISOString() }
    expect(relayLineCopy(scan)).toBe("Relay: can't read agent transcripts, so a waiting agent would be invisible here.")
  })

  it('renders no line at all before the first candidate exists', () => {
    const scan: RelayScan = { ok: true, pending: [], checked: 0, unreached: 0, scannedAt: NOW.toISOString() }
    expect(relayLineCopy(scan)).toBe('')
  })
})

describe('entryLineCopy', () => {
  it('names the question count and the waiting time', () => {
    expect(entryLineCopy(pendingOf(), 'port', NOW)).toBe('plan #107 · port — 1 question, waiting 12m')
  })

  it('names blocked, with the waiting time', () => {
    const pending = pendingOf({ kind: 'blocked', request: 'need a ci token' })
    expect(entryLineCopy(pending, 'port', NOW)).toBe('plan #107 · port — blocked, waiting 12m')
  })

  it('names the usage-limit class with no compose form implied', () => {
    const pending = pendingOf({ kind: 'usage-limit' })
    expect(entryLineCopy(pending, 'port', NOW)).toBe('plan #107 · port — hit the session limit, 12m ago. Nothing moves until the window resets.')
  })

  it('falls back to "this item" when the number could not be resolved', () => {
    expect(entryLineCopy(pendingOf({ number: null }), 'port', NOW)).toBe('plan this item · port — 1 question, waiting 12m')
  })
})
