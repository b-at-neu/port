// The `unregistered` scenario: a fresh install with no repository registered and no session on disk.
import { DEFAULT_POLL_POLICY, SOURCE_BASE_INTERVAL_MS } from '@/types/board'
import type { BoardSnapshot } from '@/types/board'
import type { SessionScan } from '@/types/sessions'

export function fixtureEmptySessionScan(now: Date): Extract<SessionScan, { readonly ok: true }> {
  return { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 1, scannedAt: now.toISOString() }
}

export function fixtureUnregisteredBoard(now: Date): BoardSnapshot {
  return {
    state: { repositories: [], sessions: fixtureEmptySessionScan(now), readAt: now.toISOString() },
    health: [],
    policy: DEFAULT_POLL_POLICY,
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: new Date(now.getTime() + SOURCE_BASE_INTERVAL_MS.github).toISOString(),
    emittedAt: now.toISOString(),
    dispatch: [],
    autoPlan: [],
  }
}
