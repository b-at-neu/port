import { describe, expect, it } from 'vitest'
import { capacityLine, fallbackSelection, openCount, rowsFor, rowStatus, usageNotice } from './rail-model'
import type { HostedSessionSnapshot, SessionKey } from '../../../shared/hosting/types'
import type { RepoId } from '../../../shared/repos'

const REPO_ID = 'repo-1' as RepoId

function snapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    repoId: REPO_ID,
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00.000Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending', request: { source: 'installed' } },
    title: null,
    rateLimit: null,
    role: 'operator',
    tasks: [],
    ...overrides,
  }
}

describe('rowStatus', () => {
  it('maps each open phase', () => {
    expect(rowStatus(snapshot({ phase: 'starting' }))).toEqual({ glyph: '◌', word: 'Starting' })
    expect(rowStatus(snapshot({ phase: 'ready' }))).toEqual({ glyph: '○', word: 'Idle' })
    expect(rowStatus(snapshot({ phase: 'streaming' }))).toEqual({ glyph: '●', word: 'Working' })
    expect(rowStatus(snapshot({ phase: 'interrupting' }))).toEqual({ glyph: '◐', word: 'Stopping' })
    expect(rowStatus(snapshot({ phase: 'closing' }))).toEqual({ glyph: '◐', word: 'Closing' })
  })

  it('overrides any open phase with Needs you when a permission is pending', () => {
    const pending = [{ permissionId: 'p', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, agentId: null, requestedAt: 't', sessionGrant: null }]
    expect(rowStatus(snapshot({ phase: 'streaming', pendingPermissions: pending }))).toEqual({ glyph: '◆', word: 'Needs you' })
  })

  it('uses END_COPY for an ended session', () => {
    const end = { reason: 'closed' as const, exitCode: null, signal: null, message: null, diagnosis: null }
    expect(rowStatus(snapshot({ phase: 'ended', end }))).toEqual({ glyph: '■', word: 'Closed' })
  })
})

describe('rowsFor', () => {
  it('orders open sessions before ended ones, each by startedAt', () => {
    const rows = rowsFor([
      snapshot({ sessionKey: 'ended-old' as SessionKey, phase: 'ended', startedAt: 't1' }),
      snapshot({ sessionKey: 'open-new' as SessionKey, phase: 'ready', startedAt: 't3' }),
      snapshot({ sessionKey: 'open-old' as SessionKey, phase: 'ready', startedAt: 't2' }),
      snapshot({ sessionKey: 'ended-new' as SessionKey, phase: 'ended', startedAt: 't4' }),
    ])
    expect(rows.map((row) => row.sessionKey)).toEqual(['open-old', 'open-new', 'ended-old', 'ended-new'])
  })
})

describe('openCount', () => {
  it('counts only non-ended sessions', () => {
    expect(openCount([snapshot({ phase: 'ready' }), snapshot({ phase: 'ended' })])).toBe(1)
  })
})

describe('capacityLine', () => {
  it('reads plainly under the limit', () => {
    expect(capacityLine(2, 4)).toBe('2 of 4 open')
  })

  it('explains at the limit', () => {
    expect(capacityLine(4, 4)).toBe('4 of 4 open — close one to start another')
  })

  it('explains over the limit, after lowering it', () => {
    expect(capacityLine(5, 3)).toBe('5 of 3 open — close 2 to start another')
  })
})

describe('usageNotice', () => {
  const now = new Date('2026-01-05T12:00:00.000Z')

  it('returns null when no session carries a reading', () => {
    expect(usageNotice([snapshot()], now)).toBeNull()
  })

  it('returns null for an allowed reading', () => {
    const rateLimit = { status: 'allowed' as const, window: null, resetsAt: null, observedAt: 't1' }
    expect(usageNotice([snapshot({ rateLimit })], now)).toBeNull()
  })

  it('returns the newest reading by observedAt across sessions', () => {
    const older = { status: 'warning' as const, window: 'five-hour' as const, resetsAt: null, observedAt: '2026-01-05T10:00:00.000Z' }
    const newer = { status: 'rejected' as const, window: 'weekly' as const, resetsAt: null, observedAt: '2026-01-05T11:00:00.000Z' }
    const result = usageNotice([snapshot({ rateLimit: older }), snapshot({ sessionKey: 'hosted-2' as SessionKey, rateLimit: newer })], now)
    expect(result).toEqual({ status: 'rejected', window: 'weekly', resetsAt: null })
  })

  it('clears a notice whose resetsAt has already passed', () => {
    const rateLimit = { status: 'warning' as const, window: 'five-hour' as const, resetsAt: '2026-01-05T11:00:00.000Z', observedAt: 't1' }
    expect(usageNotice([snapshot({ rateLimit })], now)).toBeNull()
  })
})

describe('fallbackSelection', () => {
  it('returns the newest open session other than removedKey', () => {
    const snapshots = [
      snapshot({ sessionKey: 'a' as SessionKey, startedAt: 't1' }),
      snapshot({ sessionKey: 'b' as SessionKey, startedAt: 't2' }),
    ]
    expect(fallbackSelection(snapshots, null)).toBe('b')
    expect(fallbackSelection(snapshots, 'b' as SessionKey)).toBe('a')
  })

  it('returns null when nothing open remains', () => {
    expect(fallbackSelection([snapshot({ phase: 'ended' })], null)).toBeNull()
  })
})
