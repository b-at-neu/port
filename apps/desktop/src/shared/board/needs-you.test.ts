import { describe, expect, it } from 'vitest'
import type { RepoId } from '../repos'
import type { PipelineState, ReconciledItem, RepositoryState } from '../state/types'
import type { TickReport } from '../tick/types'
import type { RepoDispatchStatus } from '../dispatch/types'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from './types'
import type { BoardSnapshot } from './types'
import { needsYouCount, needsYouItems, repoNeedsYou } from './needs-you'

const NOW = new Date('2026-01-01T01:00:00.000Z')

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: 'issue',
    number: 1,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/1',
    assignees: ['op'],
    stage: 'gate',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'gated',
    statusEvidence: null,
    waitingOn: 'cockpit',
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['planReview'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    ...overrides,
  }
}

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
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z' },
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

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return {
    repoId: 'repo-a' as RepoId,
    displayName: 'o/a',
    blind: null,
    actionable: [],
    held: [],
    claims: [],
    autoApprovals: [],
    disabledStages: [],
    nextTickAt: null,
    observations: [],
    ...overrides,
  }
}

function dispatchStatus(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return {
    repoId: 'repo-a' as RepoId,
    owner: 'app',
    state: { kind: 'idle' },
    runState: 'dispatching',
    ownedSince: null,
    unreadableMessage: null,
    budget: null,
    observed: [],
    ...overrides,
  }
}

function snapshotOf(repositories: readonly RepositoryState[], overrides: Partial<Pick<BoardSnapshot, 'tick' | 'dispatch'>> = {}): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return {
    state,
    health: [],
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
    ...overrides,
  }
}

describe('needsYouItems', () => {
  it('each stage key surfaces as its own kind', () => {
    const cases: readonly [ReconciledItem['stage'], string, string][] = [
      ['gate', 'planReview', 'plan-review'],
      ['terminal', 'approved', 'ready-to-merge'],
      ['gate', 'needsHuman', 'needs-human'],
      ['gate', 'blocked', 'blocked'],
    ]
    for (const [role, key, kind] of cases) {
      const repo = readyRepo({ items: [item({ stage: role, stages: [{ key: key as never, name: key, role: role as never }] })] })
      const items = needsYouItems(snapshotOf([repo]), NOW)
      expect(items).toHaveLength(1)
      expect(items[0]?.kind).toBe(kind)
    }
  })

  it('a stage key with no mapped kind is excluded', () => {
    const repo = readyRepo({ items: [item({ stage: 'trigger', stages: [{ key: 'ready', name: 'ready', role: 'trigger' }] })] })
    expect(needsYouItems(snapshotOf([repo]), NOW)).toEqual([])
  })

  it('excludes an item not assigned to a known viewer', () => {
    const repo = readyRepo({ viewer: 'op', items: [item({ assignees: ['someone-else'] })] })
    expect(needsYouItems(snapshotOf([repo]), NOW)).toEqual([])
  })

  it('includes an item regardless of assignees when the viewer is null', () => {
    const repo = readyRepo({ viewer: null, items: [item({ assignees: ['someone-else'] })] })
    expect(needsYouItems(snapshotOf([repo]), NOW)).toHaveLength(1)
  })

  it('held items keep only conflicting, contended and cycle-cap', () => {
    const held = [
      { number: 1, kind: 'pull-request' as const, trigger: 'readyForReview' as const, reason: 'conflicting' as const, contention: null, escalation: null },
      { number: 2, kind: 'pull-request' as const, trigger: 'readyForReview' as const, reason: 'unowned' as const, contention: null, escalation: null },
    ]
    const items = needsYouItems(snapshotOf([], { tick: [tickReport({ held })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'held', number: 1 })
  })

  it('claims keep only stalled-confirmed', () => {
    const claims = [
      { number: 3, kind: 'issue' as const, inFlight: 'inProgress' as const, class: 'stalled-confirmed' as const, retryKey: 'inProgress' as const },
      { number: 4, kind: 'issue' as const, inFlight: 'inProgress' as const, class: 'matched' as const, retryKey: null },
    ]
    const items = needsYouItems(snapshotOf([], { tick: [tickReport({ claims })] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stalled', number: 3 })
  })

  it('budget notes keep only escalated and escalation-failed', () => {
    const dispatch = [
      dispatchStatus({ budget: { line: null, problem: null, notes: [{ kind: 'escalated', number: 5, needsHumanLabel: 'needs human', commentFailedMessage: null }] } }),
      dispatchStatus({ repoId: 'repo-b' as RepoId, budget: { line: null, problem: null, notes: [{ kind: 'held', number: 6, line: 'held' }] } }),
    ]
    const items = needsYouItems(snapshotOf([], { dispatch }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'budget', number: 5 })
  })

})

describe('needsYouCount / repoNeedsYou', () => {
  it("counts the full list and one repository's own slice", () => {
    const repoA = readyRepo({ repoId: 'repo-a' as RepoId, items: [item({ repoId: 'repo-a' as RepoId, number: 1 })] })
    const repoB = readyRepo({ repoId: 'repo-b' as RepoId, repo: 'o/b', items: [item({ repoId: 'repo-b' as RepoId, number: 2 })] })
    const items = needsYouItems(snapshotOf([repoA, repoB]), NOW)
    expect(needsYouCount(items)).toBe(2)
    expect(repoNeedsYou(items, 'repo-a' as RepoId)).toBe(1)
    expect(repoNeedsYou(items, 'repo-b' as RepoId)).toBe(1)
  })
})
