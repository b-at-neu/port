import { describe, expect, it } from 'vitest'
import type { RepoId } from '../repos'
import type { PipelineState, ReconciledItem, RepositoryState } from '../state/types'
import type { RelayPending } from '../relay/types'
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

function snapshotOf(repositories: readonly RepositoryState[], relay: BoardSnapshot['relay'] = { ok: true, pending: [], checked: 0, unreached: 0, scannedAt: NOW.toISOString() }): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return {
    state,
    health: [],
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    relay,
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
  }
}

function pending(overrides: Partial<RelayPending> = {}): RelayPending {
  return {
    repoId: 'repo-a' as RepoId,
    number: 7,
    stage: 'impl-agent',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    parentSessionLabel: 'cockpit',
    agentLabel: 'impl-agent',
    lastActivityAt: NOW.toISOString(),
    kind: 'questions',
    questions: [{ index: 0, text: 'Which approach?' }],
    ...overrides,
  } as RelayPending
}

describe('needsYouItems', () => {
  it('each stage reason surfaces for its own key', () => {
    const cases: readonly [ReconciledItem['stage'], string, string][] = [
      ['gate', 'planReview', 'plan-review'],
      ['terminal', 'approved', 'ready-to-merge'],
      ['gate', 'needsHuman', 'needs-human'],
      ['gate', 'blocked', 'blocked'],
    ]
    for (const [role, key, reason] of cases) {
      const repo = readyRepo({ items: [item({ stage: role, stages: [{ key: key as never, name: key, role: role as never }] })] })
      const items = needsYouItems(snapshotOf([repo]))
      expect(items).toHaveLength(1)
      expect(items[0]?.reasons).toEqual([reason])
    }
  })

  it('a stage key with no mapped reason is excluded', () => {
    const repo = readyRepo({ items: [item({ stage: 'trigger', stages: [{ key: 'ready', name: 'ready', role: 'trigger' }] })] })
    expect(needsYouItems(snapshotOf([repo]))).toEqual([])
  })

  it('excludes an item not assigned to a known viewer', () => {
    const repo = readyRepo({ viewer: 'op', items: [item({ assignees: ['someone-else'] })] })
    expect(needsYouItems(snapshotOf([repo]))).toEqual([])
  })

  it('includes an item regardless of assignees when the viewer is null', () => {
    const repo = readyRepo({ viewer: null, items: [item({ assignees: ['someone-else'] })] })
    expect(needsYouItems(snapshotOf([repo]))).toHaveLength(1)
  })

  it('adds a question reason to an existing row matched by repoId and number', () => {
    const repo = readyRepo({ items: [item({ repoId: 'repo-a' as RepoId, number: 7 })] })
    const relay: BoardSnapshot['relay'] = { ok: true, pending: [pending({ repoId: 'repo-a' as RepoId, number: 7 })], checked: 1, unreached: 0, scannedAt: NOW.toISOString() }
    const items = needsYouItems(snapshotOf([repo], relay))
    expect(items).toHaveLength(1)
    expect(items[0]?.reasons).toEqual(['plan-review', 'question'])
  })

  it('a question with no matching row still appears, title and url null', () => {
    const relay: BoardSnapshot['relay'] = { ok: true, pending: [pending({ repoId: 'repo-b' as RepoId, number: 99 })], checked: 1, unreached: 0, scannedAt: NOW.toISOString() }
    const items = needsYouItems(snapshotOf([], relay))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ repoId: 'repo-b', number: 99, title: null, url: null, reasons: ['question'] })
  })
})

describe('needsYouCount / repoNeedsYou', () => {
  it('counts the full list and one repository\'s own slice', () => {
    const repoA = readyRepo({ repoId: 'repo-a' as RepoId, items: [item({ repoId: 'repo-a' as RepoId, number: 1 })] })
    const repoB = readyRepo({ repoId: 'repo-b' as RepoId, repo: 'o/b', items: [item({ repoId: 'repo-b' as RepoId, number: 2 })] })
    const items = needsYouItems(snapshotOf([repoA, repoB]))
    expect(needsYouCount(items)).toBe(2)
    expect(repoNeedsYou(items, 'repo-a' as RepoId)).toBe(1)
    expect(repoNeedsYou(items, 'repo-b' as RepoId)).toBe(1)
  })
})
