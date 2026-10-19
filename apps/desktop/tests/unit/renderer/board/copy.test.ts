// `freshnessIndicator` — the Board header's single indicator, replacing the old `FreshnessStrip` plus stale label.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PipelineState, RepositoryState } from '@/types/state'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS, initialHealth } from '@/types/board'
import type { BoardSnapshot, RepositoryHealth } from '@/types/board'
import { decisionRefusalNote, freshnessIndicator } from '@/renderer/board/copy'

const NOW = new Date('2026-01-01T01:00:00.000Z')

function readyRepo(overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    displayName: 'o/a',
    items: [],
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4812, resetAt: '2026-01-01T14:05:00Z' },
    freshness: {
      github: { at: NOW.toISOString() },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
    ...overrides,
  }
}

function health(overrides: Partial<RepositoryHealth> = {}): RepositoryHealth {
  return { repoId: 'repo-a' as RepoId, github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials'), ...overrides }
}

function snapshotOf(healths: readonly RepositoryHealth[], repositories: readonly RepositoryState[] = [readyRepo()]): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return {
    state,
    health: healths,
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
  }
}

describe('freshnessIndicator', () => {
  it('is null when there is no health yet', () => {
    expect(freshnessIndicator(snapshotOf([]), NOW)).toBeNull()
  })

  it('is null when every source is healthy', () => {
    const snapshot = snapshotOf([health({ github: { ...initialHealth('github'), lastSuccessAt: NOW.toISOString() } })])
    expect(freshnessIndicator(snapshot, NOW)).toBeNull()
  })

  it('shows "Updated Nm ago" once GitHub is older than twice its interval', () => {
    const staleAt = new Date(NOW.getTime() - SOURCE_BASE_INTERVAL_MS.github * 3).toISOString()
    const snapshot = snapshotOf([health({ github: { ...initialHealth('github'), lastSuccessAt: staleAt } })])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.label).toBe('Updated 3m ago')
  })

  it('shows the indicator, aged from sessions, when sessions is failing while GitHub is fresh', () => {
    const sessionsAt = new Date(NOW.getTime() - 5 * 60_000).toISOString()
    const snapshot = snapshotOf([
      health({
        github: { ...initialHealth('github'), lastSuccessAt: NOW.toISOString() },
        sessions: { ...initialHealth('sessions'), lastSuccessAt: sessionsAt, consecutiveFailures: 2 },
      }),
    ])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.label).toBe('Updated 5m ago')
  })

  it('shows "Not updated yet" for a failing source that has never read', () => {
    const snapshot = snapshotOf([health({ worktrees: { ...initialHealth('worktrees'), consecutiveFailures: 1, lastSuccessAt: null } })])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.label).toBe('Not updated yet')
  })

  it('lists the tooltip lines in SOURCE_KINDS order, with the rate-limit line last only when known', () => {
    const staleAt = new Date(NOW.getTime() - SOURCE_BASE_INTERVAL_MS.github * 3).toISOString()
    const snapshot = snapshotOf([health({ github: { ...initialHealth('github'), lastSuccessAt: staleAt } })])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.lines).toHaveLength(5)
    expect(result?.lines[0]).toMatch(/^GitHub/)
    expect(result?.lines[1]).toMatch(/^Sessions/)
    expect(result?.lines[2]).toMatch(/^Worktrees/)
    expect(result?.lines[3]).toMatch(/^Denials/)
    expect(result?.lines[4]).toMatch(/^4,812 API points left, resets /)
  })

  it('omits the rate-limit line when it is unknown', () => {
    const staleAt = new Date(NOW.getTime() - SOURCE_BASE_INTERVAL_MS.github * 3).toISOString()
    const snapshot = snapshotOf([health({ github: { ...initialHealth('github'), lastSuccessAt: staleAt } })], [])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.lines).toHaveLength(4)
  })
})

describe('decisionRefusalNote', () => {
  it('says unreadable decisions go to the cockpit, never that port cannot record them at all', () => {
    const note = decisionRefusalNote('unblock', 'rebase-decisions', 37)
    expect(note).toContain("couldn't read")
    expect(note).toContain('unblock #37')
    expect(note).not.toContain("can't record")
  })
})
