import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PipelineState, ReconciledItem, RepositoryState } from '@/types/state'
import type { DispatchRecord, RepoDispatchStatus } from '@/types/dispatch'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS, type BoardSnapshot } from '@/types/board'
import { needsYouItems } from '@/renderer/board/needs-you'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const REPO = 'repo-a' as RepoId

function readyTicket(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO,
    repo: 'o/a',
    kind: 'issue',
    number: 585,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/585',
    assignees: ['op'],
    stage: 'trigger',
    stages: [{ key: 'ready', name: 'ready', role: 'trigger' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'waiting',
    statusEvidence: null,
    waitingOn: 'cockpit',
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    workSessions: [],
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    stageHistory: [],
    matchedKeys: ['ready'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    blockers: null,
    blockerComments: null,
    ...overrides,
  }
}

function repoWith(items: readonly ReconciledItem[]): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: REPO,
    repo: 'o/a',
    displayName: 'o/a',
    items,
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z', limit: 5000 },
    freshness: { github: { at: NOW.toISOString() }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: NOW.toISOString() }, worktrees: { at: NOW.toISOString() }, denials: { at: NOW.toISOString() } },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
  }
}

function failedRecord(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return { agent: 'plan', number: 585, kind: 'issue', trigger: 'ready', state: 'failed', at: '2026-01-01T00:30:00.000Z', detail: 'no section', outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null, ...overrides }
}

function snapshotWith(items: readonly ReconciledItem[], dispatch: Partial<RepoDispatchStatus>): BoardSnapshot {
  const state: PipelineState = { repositories: [repoWith(items)], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  const status: RepoDispatchStatus = { repoId: REPO, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...dispatch }
  return {
    state,
    health: [],
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [status],
    autoPlan: [],
  }
}

function failedItems(snapshot: BoardSnapshot) {
  return needsYouItems(snapshot, NOW).filter((entry) => entry.kind === 'dispatch-failed')
}

describe('needsYouItems — dispatch-failed', () => {
  it('surfaces a failed launch for a ticket still waiting on the trigger that failed', () => {
    const items = failedItems(snapshotWith([readyTicket()], { state: { kind: 'active', recent: [failedRecord({ at: '2026-01-01T00:20:00.000Z' }), failedRecord()] } }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'dispatch-failed', number: 585, at: '2026-01-01T00:30:00.000Z', attempts: 2, record: { detail: 'no section' } })
  })

  it('drops off once the ticket carries a different stage label than the failed trigger', () => {
    const moved = readyTicket({ stage: 'in-flight', stages: [{ key: 'planning', name: 'planning', role: 'in-flight' }], matchedKeys: ['planning'] })
    expect(failedItems(snapshotWith([moved], { state: { kind: 'active', recent: [failedRecord()] } }))).toEqual([])
  })

  it('drops off when a later launch started', () => {
    const recent = [failedRecord(), failedRecord({ state: 'started', at: '2026-01-01T00:40:00.000Z' })]
    expect(failedItems(snapshotWith([readyTicket()], { state: { kind: 'active', recent } }))).toEqual([])
  })

  it('ignores a ticket with no board row', () => {
    expect(failedItems(snapshotWith([], { state: { kind: 'active', recent: [failedRecord()] } }))).toEqual([])
  })

  it('shows nothing when another owner runs the repository or the dispatcher is not active', () => {
    expect(failedItems(snapshotWith([readyTicket()], { owner: 'terminal', state: { kind: 'active', recent: [failedRecord()] } }))).toEqual([])
    expect(failedItems(snapshotWith([readyTicket()], { state: { kind: 'idle' } }))).toEqual([])
  })
})
