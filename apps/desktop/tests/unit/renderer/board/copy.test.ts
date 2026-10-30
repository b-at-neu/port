// `freshnessIndicator` — the Board header's always-on GitHub timing label.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PipelineState, RepositoryState } from '@/types/state'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS, initialHealth } from '@/types/board'
import type { BoardSnapshot, RepositoryHealth, SourceHealth } from '@/types/board'
import { decisionRefusalNote, dispatchedTagLabel, dispatchedTagTitle, freshnessIndicator, stageAgentPhaseName } from '@/renderer/board/copy'

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
    rateLimit: { cost: 1, remaining: 4812, resetAt: '2026-01-01T14:05:00Z', limit: 5000 },
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
    autoPlan: [],
  }
}

function githubRead(agoMs: number): SourceHealth {
  return { ...initialHealth('github'), lastSuccessAt: new Date(NOW.getTime() - agoMs).toISOString() }
}

function withWakeup(snapshot: BoardSnapshot, inMs: number): BoardSnapshot {
  return { ...snapshot, nextWakeupAt: new Date(NOW.getTime() + inMs).toISOString() }
}

describe('freshnessIndicator', () => {
  it('is null when there is no health yet', () => {
    expect(freshnessIndicator(snapshotOf([]), NOW)).toBeNull()
  })

  it('says GitHub is being checked before the first read', () => {
    const result = freshnessIndicator(snapshotOf([health()]), NOW)
    expect(result?.label).toBe('Checking GitHub…')
    expect(result?.tone).toBe('muted')
  })

  it('shows the age and a countdown while healthy', () => {
    const snapshot = withWakeup(snapshotOf([health({ github: githubRead(40_000) })]), 80_000)
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.label).toBe('Checked GitHub 40s ago · next check in 1:20')
    expect(result?.tone).toBe('muted')
  })

  it('says no check is scheduled when there is no wakeup', () => {
    const result = freshnessIndicator(snapshotOf([health({ github: githubRead(40_000) })]), NOW)
    expect(result?.label).toBe('Checked GitHub 40s ago · no check scheduled')
  })

  it('says the next check is now once the wakeup is due', () => {
    const snapshot = withWakeup(snapshotOf([health({ github: githubRead(40_000) })]), -1)
    expect(freshnessIndicator(snapshot, NOW)?.label).toBe('Checked GitHub 40s ago · next check now')
  })

  it('names the rate-limit reset instead of failing, even though a limited read counts as a failure', () => {
    const until = new Date(NOW.getTime() + 3_600_000)
    const github = { ...githubRead(6 * 60_000), consecutiveFailures: 1, deferredUntil: until.toISOString() }
    const result = freshnessIndicator(snapshotOf([health({ github })]), NOW)
    const clock = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(result?.label).toBe(`Checked GitHub 6m ago · waiting for GitHub's rate limit until ${clock}`)
    expect(result?.tone).toBe('muted')
  })

  it('reads as failing, in attention, with the last good read', () => {
    const github = { ...githubRead(6 * 60_000), consecutiveFailures: 2 }
    const result = freshnessIndicator(snapshotOf([health({ github })]), NOW)
    expect(result?.label).toBe('GitHub check failing — last good 6m ago')
    expect(result?.tone).toBe('attention')
  })

  it('reads as failing when GitHub has never been read', () => {
    const github = { ...initialHealth('github'), consecutiveFailures: 1 }
    expect(freshnessIndicator(snapshotOf([health({ github })]), NOW)?.label).toBe('GitHub check failing — never read')
  })

  it('turns attention once the last read is older than twice the interval', () => {
    const snapshot = withWakeup(snapshotOf([health({ github: githubRead(SOURCE_BASE_INTERVAL_MS.github * 3) })]), 40_000)
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.label).toBe('Checked GitHub 3m ago · next check in 0:40')
    expect(result?.tone).toBe('attention')
  })

  it('appends the failing sources and turns attention while GitHub is fresh', () => {
    const snapshot = snapshotOf([health({ github: githubRead(40_000), sessions: { ...initialHealth('sessions'), consecutiveFailures: 2 } })])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.label).toBe('Checked GitHub 40s ago · no check scheduled · Sessions failing')
    expect(result?.tone).toBe('attention')
  })

  it('counts hours for an old read', () => {
    const github = { ...githubRead(2 * 3_600_000), consecutiveFailures: 1 }
    expect(freshnessIndicator(snapshotOf([health({ github })]), NOW)?.label).toBe('GitHub check failing — last good 2h ago')
  })

  it('lists the tooltip lines in SOURCE_KINDS order, with the rate-limit line last only when known', () => {
    const snapshot = snapshotOf([health({ github: githubRead(SOURCE_BASE_INTERVAL_MS.github * 3) })])
    const result = freshnessIndicator(snapshot, NOW)
    expect(result?.lines).toHaveLength(5)
    expect(result?.lines[0]).toMatch(/^GitHub/)
    expect(result?.lines[1]).toMatch(/^Sessions/)
    expect(result?.lines[2]).toMatch(/^Worktrees/)
    expect(result?.lines[3]).toMatch(/^Denials/)
    expect(result?.lines[4]).toMatch(/^4,812 API points left, resets /)
  })

  it('omits the rate-limit line when it is unknown', () => {
    const snapshot = snapshotOf([health({ github: githubRead(SOURCE_BASE_INTERVAL_MS.github * 3) })], [])
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

  it('tells the operator to answer a live agent in its session', () => {
    expect(decisionRefusalNote('unblock', 'agent-live', 51)).toBe("#51's agent is still waiting in its session. Answer it there and it clears the block itself.")
  })

  it('stays silent for an ordinary refusal', () => {
    expect(decisionRefusalNote('unblock', 'not-applicable', 51)).toBeNull()
  })
})

describe('dispatched tag and stage phase names', () => {
  it('explains the tag', () => {
    expect(dispatchedTagLabel()).toBe('Dispatched')
    expect(dispatchedTagTitle()).toBe('port started this stage. The label updates when the agent claims it.')
  })

  it.each([
    ['plan', 'Planning'],
    ['impl', 'Implementing'],
    ['review', 'Reviewing'],
    ['revise', 'Revising'],
  ] as const)('names the %s stage %s', (agent, name) => {
    expect(stageAgentPhaseName(agent)).toBe(name)
  })
})
