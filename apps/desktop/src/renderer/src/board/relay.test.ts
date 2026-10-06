// Covers the board header's own relay line — the banner, compose form and
// per-entry copy moved to the Needs you screen (#315).
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RelayPending, RelayScan } from '../../../shared/relay/types'
import { relayLineCopy } from './relay'

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

  it('writes out the zero-checked case too, never silence, for a repository with no dispatched agents at all', () => {
    const scan: RelayScan = { ok: true, pending: [], checked: 0, unreached: 0, scannedAt: NOW.toISOString() }
    expect(relayLineCopy(scan)).toBe('Relay: nothing waiting (0 agents checked).')
  })
})
