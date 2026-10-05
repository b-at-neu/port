import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ClaimRead, WriteOutcome } from '../../shared/writes/types'
import type { ReconciledItem } from '../../shared/state/types'
import type { TickReport } from '../../shared/tick/types'
import type { ReadyEntry } from '../actions/apply'
import type { AutoApprovePlanParams } from '../actions/gate'
import type { ReposListResponse } from '../../shared/ipc'
import { createAutoPlanner } from './auto-plan'
import type { AutoPlannerDeps } from './auto-plan'

const REPO_ID = 'repo-a' as RepoId
const VOCABULARY = resolveVocabulary({})

function entry(): ReadyEntry {
  return {
    id: REPO_ID,
    path: '/repo',
    displayName: 'o/a',
    status: 'ready',
    config: {
      repo: 'o/a',
      owner: 'o',
      name: 'a',
      branches: { integration: 'dev', production: 'main' },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      checkDispositions: {},
      overrides: [],
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: VOCABULARY,
    },
    diagnostics: [],
  }
}

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: 'o/a',
    kind: 'issue',
    number: 7,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/7',
    assignees: ['op'],
    stage: 'gate',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: true,
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

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [{ number: 7 }], ...overrides }
}

function snapshotWith(tick: readonly TickReport[], items: readonly ReconciledItem[], readAt = '2026-01-01T00:00:00Z'): BoardSnapshot {
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op', items, freshness: { github: { at: readAt } } } as never],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: readAt },
      readAt,
    },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick,
    relay: { ok: true, pending: [], checked: 0, unreached: 0, scannedAt: readAt },
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: readAt,
    dispatch: [],
  } as unknown as BoardSnapshot
}

const HELD_PLAN_GATE: ClaimRead = { state: 'held', owner: 'port-desktop', scopes: ['plan-gate'], unknownScopes: [], claimedAt: '2026-01-01T00:00:00Z', path: '/repo/.agents/gate-claim.json', readAt: 'r' }
const HELD_DISPATCH_ONLY: ClaimRead = { state: 'held', owner: 'port-desktop', scopes: ['dispatch'], unknownScopes: [], claimedAt: '2026-01-01T00:00:00Z', path: '/repo/.agents/gate-claim.json', readAt: 'r' }
const ABSENT_CLAIM: ClaimRead = { state: 'absent', path: '/repo/.agents/gate-claim.json', readAt: 'r' }
const APPLIED: WriteOutcome = { kind: 'applied', argv: [] }

function deps(overrides: Partial<AutoPlannerDeps> = {}): AutoPlannerDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [entry()] } as ReposListResponse),
    registryDeps: { registryDir: '/registry', git: () => Promise.reject(new Error('git unused')), chooseDirectory: () => Promise.resolve(null) },
    readGateClaim: () => Promise.resolve(HELD_PLAN_GATE),
    runState: () => 'dispatching',
    autoApprove: () => Promise.resolve(APPLIED),
    auditDir: '/audit',
    now: () => new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  }
}

describe('createAutoPlanner', () => {
  it('writes an auto-approval while plan-gate is held and the item is autoApprovable', async () => {
    let received: AutoApprovePlanParams | undefined
    const planner = createAutoPlanner(deps({ autoApprove: (p) => { received = p; return Promise.resolve(APPLIED) } }))
    await planner.consider(snapshotWith([tickReport()], [item()]))
    expect(received?.item).toEqual({ number: 7, assignees: ['op'] })
  })

  it('writes nothing when the claim is absent — the cockpit still owns the swap', async () => {
    let called = false
    const planner = createAutoPlanner(deps({ readGateClaim: () => Promise.resolve(ABSENT_CLAIM), autoApprove: () => { called = true; return Promise.resolve(APPLIED) } }))
    await planner.consider(snapshotWith([tickReport()], [item()]))
    expect(called).toBe(false)
  })

  it('writes nothing when the claim holds dispatch but not plan-gate', async () => {
    let called = false
    const planner = createAutoPlanner(deps({ readGateClaim: () => Promise.resolve(HELD_DISPATCH_ONLY), autoApprove: () => { called = true; return Promise.resolve(APPLIED) } }))
    await planner.consider(snapshotWith([tickReport()], [item()]))
    expect(called).toBe(false)
  })

  it('writes nothing while draining — the drain gate is deliberate', async () => {
    let called = false
    const planner = createAutoPlanner(deps({ runState: () => 'draining', autoApprove: () => { called = true; return Promise.resolve(APPLIED) } }))
    await planner.consider(snapshotWith([tickReport()], [item()]))
    expect(called).toBe(false)
  })

  it('never re-fires for a snapshot the GitHub read has not caught up to yet', async () => {
    let count = 0
    const planner = createAutoPlanner(deps({ autoApprove: () => { count += 1; return Promise.resolve(APPLIED) } }))
    const snapshot = snapshotWith([tickReport()], [item()], '2026-01-01T00:00:00Z')
    await planner.consider(snapshot)
    await planner.consider(snapshot)
    expect(count).toBe(1)
  })

  it('retries once the GitHub read moves past the last attempt', async () => {
    let count = 0
    const planner = createAutoPlanner(deps({ autoApprove: () => { count += 1; return Promise.resolve(APPLIED) } }))
    await planner.consider(snapshotWith([tickReport()], [item()], '2026-01-01T00:00:00Z'))
    await planner.consider(snapshotWith([tickReport()], [item()], '2026-01-01T00:01:00Z'))
    expect(count).toBe(2)
  })

  it('swallows a throw from autoApprove and still records the attempt', async () => {
    const planner = createAutoPlanner(deps({ autoApprove: () => Promise.reject(new Error('boom')) }))
    await expect(planner.consider(snapshotWith([tickReport()], [item()]))).resolves.toBeUndefined()
  })
})
