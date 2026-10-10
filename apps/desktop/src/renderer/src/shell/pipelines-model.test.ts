import { describe, expect, it } from 'vitest'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { AttachedAgent, PipelineState, ReconciledItem, RepositoryState } from '../../../shared/state/types'
import type { BoardSnapshot } from '../../../shared/board/types'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '../../../shared/board/types'
import type { PipelineRow, ReadyPipelineRow } from './pipelines-model'
import { pipelinesModel } from './pipelines-model'

function assertReady(row: PipelineRow | undefined): ReadyPipelineRow {
  if (row === undefined || !row.ready) throw new Error('expected a ready row')
  return row
}

const NOW = new Date('2026-01-01T01:00:00.000Z')
const REPO_ID = 'repo-a' as RepoId

function agent(overrides: Partial<AttachedAgent> = {}): AttachedAgent {
  return { agentId: 'a1', agentType: 'impl-agent', stage: 'impl-agent', model: 'sonnet', activity: 'active', idleMs: 0, lastActivityAt: NOW.toISOString(), match: 'direct', ...overrides }
}

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: 'o/a',
    kind: 'issue',
    number: 42,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/42',
    assignees: ['op'],
    stage: 'in-flight',
    stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'in-flight',
    statusEvidence: 'agent-active',
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['inProgress'],
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

function readyRepoState(overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: REPO_ID,
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

function snapshotOf(repositories: readonly RepositoryState[]): BoardSnapshot {
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
  }
}

function notReadyEntry(): RepositoryEntry {
  return { id: 'repo-b' as RepoId, path: '/repo-b', displayName: 'o/b', problem: { kind: 'directory-missing' }, diagnostics: [] }
}

function readyEntry(): RepositoryEntry {
  return {
    id: REPO_ID,
    path: '/repo-a',
    displayName: 'o/a',
    status: 'ready',
    diagnostics: [],
    config: {
      repo: 'o/a',
      owner: 'o',
      name: 'a',
      branches: { integration: 'dev', production: 'main' },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: { labels: [], disabled: [], problems: [] },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
    },
  }
}

describe('pipelinesModel', () => {
  it('renders a bare not-ready row with no sessions', () => {
    const rows = pipelinesModel([notReadyEntry()], undefined)
    expect(rows).toEqual([{ ready: false, repoId: 'repo-b', name: 'o/b' }])
  })

  it('reads a ready repository as paused with no snapshot yet', () => {
    const row = assertReady(pipelinesModel([readyEntry()], undefined)[0])
    expect(row).toMatchObject({ ready: true, pill: { status: 'idle', label: 'Paused' }, inFlight: 0, needsYou: false, sessions: [] })
  })

  it('lists a live session row, never a dormant one', () => {
    const live = item({ agents: [agent({ activity: 'active' })] })
    const dormant = item({ number: 43, agents: [agent({ activity: 'dormant' })] })
    const snapshot = snapshotOf([readyRepoState({ items: [live, dormant] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions).toEqual([{ key: `${REPO_ID}-42`, number: 42, label: '#42 Implementing', dot: 'working', sessionKey: null }])
  })

  it('marks a session attention when its item needs the operator', () => {
    const waiting = item({ stage: 'gate', stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], waitingOn: 'cockpit', agents: [agent()] })
    const snapshot = snapshotOf([readyRepoState({ items: [waiting] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions[0]?.dot).toBe('attention')
    expect(row.needsYou).toBe(true)
  })

  it('a stage session row replaces an item-derived row for the same number', () => {
    const live = item({ agents: [agent({ activity: 'active' })] })
    const snapshot = snapshotOf([readyRepoState({ items: [live] })])
    const stageSnapshot: HostedSessionSnapshot = {
      sessionKey: 'hosted-1' as HostedSessionSnapshot['sessionKey'],
      claudeSessionId: 's1',
      repoId: REPO_ID,
      workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
      phase: 'streaming',
      origin: { kind: 'fresh' },
      startedAt: NOW.toISOString(),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities: { kind: 'pending', request: { source: 'installed' } },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default', model: null, effort: null },
      models: { kind: 'pending' },
      usage: null,
      stage: { agent: 'impl', number: 42, kind: 'issue', trigger: 'planApproved' },
      lastResult: null,
    }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [stageSnapshot])[0])
    expect(row.sessions).toHaveLength(1)
    expect(row.sessions[0]).toMatchObject({ number: 42, sessionKey: 'hosted-1' })
  })

  it('reads the persisted run state into the pill', () => {
    const snapshot = { ...snapshotOf([readyRepoState()]), runStates: { store: { kind: 'loaded' as const }, repositories: [{ repoId: REPO_ID, state: 'draining' as const, since: null }] } }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.pill).toEqual({ status: 'attention', label: 'Draining' })
  })
})
