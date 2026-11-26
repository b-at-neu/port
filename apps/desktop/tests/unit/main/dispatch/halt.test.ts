import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import type { ItemActionResult, ReadyEntry } from '@/types/actions'
import type { RunStateStore } from '@/types/dispatch'
import { haltDispatch } from '@/main/dispatch/halt'
import { createTestContext } from '../../../support/context'

const apply = vi.hoisted(() => vi.fn<(params: unknown) => Promise<ItemActionResult>>())
vi.mock('@/main/pipeline/operator/apply', () => ({ applyItemAction: (_ctx: unknown, params: unknown) => apply(params) }))

const VOCABULARY = resolveVocabulary({})
const REPO_ID = 'repo-a' as RepoId
const APPLIED: ItemActionResult = { ok: true, outcome: { kind: 'applied', argv: [] } }

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
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
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
    number: 148,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/148',
    assignees: ['op'],
    stage: 'in-flight',
    stages: [{ key: 'reviewing', name: 'reviewing', role: 'in-flight' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'in-flight',
    statusEvidence: null,
    waitingOn: null,
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
    matchedKeys: ['reviewing'],
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
    closingPullRequests: null,
    ...overrides,
  }
}

function repoState(items: readonly ReconciledItem[], overrides: Partial<Extract<RepositoryState, { readonly ok: true }>> = {}): Extract<RepositoryState, { readonly ok: true }> {
  return {
    ok: true,
    repoId: REPO_ID,
    repo: 'o/a',
    displayName: 'o/a',
    items,
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: '2026-01-01T00:00:00Z' },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z', limit: 5000 },
    freshness: {
      github: { at: '2026-01-01T00:00:00Z' },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: '2026-01-01T00:00:00Z' },
      worktrees: { at: '2026-01-01T00:00:00Z' },
      denials: { at: '2026-01-01T00:00:00Z' },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    integrationChecks: {},
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
    ...overrides,
  }
}

function snapshotOf(repositories: readonly RepositoryState[]): BoardSnapshot {
  return {
    state: { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00Z' }, readAt: '2026-01-01T00:00:00Z' },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
    dispatch: [],
    autoPlan: [],
  }
}

function setup(dispatcher: { stopFor?: (repoId: RepoId, number: number) => Promise<boolean>; standDown?: (repoId: RepoId) => Promise<boolean> } = {}) {
  const calls: string[] = []
  const live = {
    dispatcher: {
      stopFor: (repoId: RepoId, number: number) => {
        calls.push('stopFor')
        return (dispatcher.stopFor ?? (() => Promise.resolve(false)))(repoId, number)
      },
      standDown: (repoId: RepoId) => {
        calls.push(`standDown ${repoId}`)
        return (dispatcher.standDown ?? (() => Promise.resolve(false)))(repoId)
      },
    },
  }
  return { ctx: createTestContext({ live: live as never }), calls }
}

function halt(ctx: ReturnType<typeof createTestContext>, items: readonly ReconciledItem[], state: Partial<Extract<RepositoryState, { readonly ok: true }>> = {}) {
  return haltDispatch(ctx, { snapshot: snapshotOf([repoState(items, state)]), entries: [entry()], repoIds: [REPO_ID] })
}

beforeEach(() => {
  apply.mockReset().mockResolvedValue(APPLIED)
})

describe('haltDispatch', () => {
  it('aborts entirely when the run-state write fails, before touching a single item', async () => {
    const runStates = { set: () => Promise.resolve({ ok: false, reason: 'unwritable', message: 'disk full' }), path: '/userData/dispatch.json' } as unknown as RunStateStore
    const ctx = createTestContext({ stores: { runStates }, live: {} })
    const report = await halt(ctx, [item()])
    expect(report).toEqual({ kind: 'aborted', reason: 'run-state-unwritable', message: 'disk full', path: '/userData/dispatch.json' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('pauses first, stops every in-flight item and reports the removed label and attached agent', async () => {
    const { ctx } = setup()
    const attached = item({ agents: [{ agentId: 'a1', agentType: 'review-agent', stage: 'review-agent', model: null, activity: 'active', idleMs: 1000, lastActivityAt: '2026-01-01T00:00:00Z', match: 'direct', sessionId: 's1' }] })
    const report = await halt(ctx, [attached])
    expect(ctx.stores.runStates.current(REPO_ID).state).toBe('paused')
    expect(report).toEqual({ kind: 'completed', items: [{ kind: 'stopped', number: 148, itemKind: 'issue', repoId: REPO_ID, removedLabel: 'reviewing', attachedAgent: 'review-agent', stoppedTask: false }] })
  })

  it('calls stopFor before the label write, and standDown after the loop', async () => {
    const { ctx, calls } = setup({ stopFor: () => Promise.resolve(true) })
    apply.mockImplementation(() => {
      calls.push('apply')
      return Promise.resolve(APPLIED)
    })
    const report = await halt(ctx, [item()])
    expect(calls).toEqual(['stopFor', 'apply', `standDown ${REPO_ID}`])
    expect(report).toMatchObject({ kind: 'completed', items: [{ kind: 'stopped', stoppedTask: true }] })
  })

  it('stands down every in-scope ready entry even when nothing was in flight', async () => {
    const { ctx, calls } = setup()
    expect(await halt(ctx, [])).toEqual({ kind: 'completed', items: [] })
    expect(calls).toEqual([`standDown ${REPO_ID}`])
  })

  it.each([
    ['a session-required item', item({ sessionRequired: true }), {}, { reason: 'session-required', owner: null }],
    ['a not-owned item, naming the owner', item({ assignees: ['other'] }), {}, { reason: 'not-owned', owner: 'other' }],
    ['an unknown viewer', item(), { viewer: null }, { reason: 'viewer-unknown', owner: null }],
  ] as const)('skips %s without ever writing', async (_name, skipped, state, expected) => {
    const { ctx } = setup()
    const report = await halt(ctx, [skipped], state)
    expect(report).toEqual({ kind: 'completed', items: [{ kind: 'skipped', number: 148, itemKind: 'issue', repoId: REPO_ID, ...expected }] })
    expect(apply).not.toHaveBeenCalled()
  })

  it('carries a refused ItemActionResult straight into the report', async () => {
    const refusal: ItemActionResult = { ok: false, reason: 'moved', expected: 'reviewing', observed: 'no longer tracked' }
    apply.mockResolvedValue(refusal)
    const { ctx } = setup()
    expect(await halt(ctx, [item()])).toEqual({ kind: 'completed', items: [{ kind: 'refused', number: 148, itemKind: 'issue', repoId: REPO_ID, result: refusal }] })
  })

  it('skips items for a repository with no entry in scope', async () => {
    const { ctx } = setup()
    const other = 'repo-b' as RepoId
    const report = await haltDispatch(ctx, { snapshot: snapshotOf([repoState([item()], { repoId: other, repo: 'o/b' })]), entries: [entry()], repoIds: [REPO_ID] })
    expect(report).toEqual({ kind: 'completed', items: [] })
    expect(apply).not.toHaveBeenCalled()
  })
})
