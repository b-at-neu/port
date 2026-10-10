import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { ItemActionResult } from '../../shared/actions/types'
import type { ReadyEntry } from '../actions/apply'
import type { RunStateStore, SetRunStateResult } from './store'
import { haltDispatch } from './halt'

const VOCABULARY = resolveVocabulary({})
const REPO_ID = 'repo-a' as RepoId

function entry(overrides: Partial<ReadyEntry> = {}): ReadyEntry {
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
    ...overrides,
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
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['reviewing'],
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
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z' },
    freshness: {
      github: { at: '2026-01-01T00:00:00Z' },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: '2026-01-01T00:00:00Z' },
      worktrees: { at: '2026-01-01T00:00:00Z' },
      denials: { at: '2026-01-01T00:00:00Z' },
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
  return {
    state: { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00Z' }, readAt: '2026-01-01T00:00:00Z' },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
    dispatch: [],
  }
}

function fakeRunStates(setResult: SetRunStateResult = { ok: true }): { readonly runStates: RunStateStore; readonly setCalls: (readonly [readonly RepoId[], string])[] } {
  const setCalls: (readonly [readonly RepoId[], string])[] = []
  const runStates: RunStateStore = {
    current: (repoId) => ({ repoId, state: 'paused', since: '2026-01-01T00:00:00Z' }),
    status: () => ({ kind: 'loaded' }),
    snapshot: () => ({ store: { kind: 'loaded' }, repositories: [] }),
    load: () => Promise.resolve(),
    set: (repoIds, state) => {
      setCalls.push([repoIds, state])
      return Promise.resolve(setResult)
    },
    forget: () => Promise.resolve({ ok: true }),
    path: '/userData/dispatch.json',
  }
  return { runStates, setCalls }
}

const NOW = () => new Date('2026-01-01T00:00:00Z')

describe('haltDispatch', () => {
  it('aborts entirely when the run-state write fails, before touching a single item', async () => {
    const { runStates } = fakeRunStates({ ok: false, reason: 'unwritable', message: 'disk full' })
    let called = false
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item()])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => { called = true; return Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) } },
    )
    expect(report).toEqual({ kind: 'aborted', reason: 'run-state-unwritable', message: 'disk full', path: '/userData/dispatch.json' })
    expect(called).toBe(false)
  })

  it('stops every in-flight item and reports the removed label', async () => {
    const { runStates } = fakeRunStates()
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item()])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) },
    )
    expect(report).toEqual({
      kind: 'completed',
      items: [{ kind: 'stopped', number: 148, itemKind: 'issue', repoId: REPO_ID, removedLabel: 'reviewing', attachedAgent: null, stoppedTask: false }],
    })
  })

  it('names an attached agent without failing the stop itself', async () => {
    const { runStates } = fakeRunStates()
    const attached = item({ agents: [{ agentId: 'a1', agentType: 'review-agent', stage: 'review-agent', model: null, activity: 'active', idleMs: 1000, lastActivityAt: '2026-01-01T00:00:00Z', match: 'direct' }] })
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([attached])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) },
    )
    expect(report).toEqual({
      kind: 'completed',
      items: [{ kind: 'stopped', number: 148, itemKind: 'issue', repoId: REPO_ID, removedLabel: 'reviewing', attachedAgent: 'review-agent', stoppedTask: false }],
    })
  })

  it('calls stopFor before applyItemAction, and standDown after the loop (#265, #314)', async () => {
    const { runStates } = fakeRunStates()
    const order: string[] = []
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item()])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      {
        stopFor: (repoId, number) => {
          order.push('stopFor')
          expect(repoId).toBe(REPO_ID)
          expect(number).toBe(148)
          return Promise.resolve(true)
        },
        applyItemAction: () => {
          order.push('applyItemAction')
          return Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } })
        },
        standDown: (repoId) => {
          order.push('standDown')
          expect(repoId).toBe(REPO_ID)
          return Promise.resolve(true)
        },
      },
    )
    expect(order).toEqual(['stopFor', 'applyItemAction', 'standDown'])
    expect(report).toEqual({
      kind: 'completed',
      items: [{ kind: 'stopped', number: 148, itemKind: 'issue', repoId: REPO_ID, removedLabel: 'reviewing', attachedAgent: null, stoppedTask: true }],
    })
  })

  it('calls standDown for every in-scope ready entry even when nothing was in flight', async () => {
    const { runStates } = fakeRunStates()
    const standDownCalls: RepoId[] = []
    await haltDispatch(
      { snapshot: snapshotOf([repoState([])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }), standDown: (repoId) => { standDownCalls.push(repoId); return Promise.resolve(false) } },
    )
    expect(standDownCalls).toEqual([REPO_ID])
  })

  it('defaults stoppedTask to false when no stopFor is wired at all', async () => {
    const { runStates } = fakeRunStates()
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item()])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) },
    )
    expect(report.kind).toBe('completed')
    if (report.kind !== 'completed') return
    expect(report.items[0]).toMatchObject({ stoppedTask: false })
  })

  it('skips a session-required item without ever calling applyItemAction', async () => {
    const { runStates } = fakeRunStates()
    let called = false
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item({ sessionRequired: true })])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => { called = true; return Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) } },
    )
    expect(report).toEqual({ kind: 'completed', items: [{ kind: 'skipped', number: 148, itemKind: 'issue', repoId: REPO_ID, reason: 'session-required', owner: null }] })
    expect(called).toBe(false)
  })

  it('skips a not-owned item, naming the owner, without ever calling applyItemAction', async () => {
    const { runStates } = fakeRunStates()
    let called = false
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item({ assignees: ['other'] })])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => { called = true; return Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) } },
    )
    expect(report).toEqual({ kind: 'completed', items: [{ kind: 'skipped', number: 148, itemKind: 'issue', repoId: REPO_ID, reason: 'not-owned', owner: 'other' }] })
    expect(called).toBe(false)
  })

  it('skips viewer-unknown without ever calling applyItemAction', async () => {
    const { runStates } = fakeRunStates()
    let called = false
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item()], { viewer: null })]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => { called = true; return Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) } },
    )
    expect(report).toEqual({ kind: 'completed', items: [{ kind: 'skipped', number: 148, itemKind: 'issue', repoId: REPO_ID, reason: 'viewer-unknown', owner: null }] })
    expect(called).toBe(false)
  })

  it('carries a refused ItemActionResult straight into the report', async () => {
    const { runStates } = fakeRunStates()
    const refusal: ItemActionResult = { ok: false, reason: 'moved', expected: 'reviewing', observed: 'no longer tracked' }
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([item()])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve(refusal) },
    )
    expect(report).toEqual({ kind: 'completed', items: [{ kind: 'refused', number: 148, itemKind: 'issue', repoId: REPO_ID, result: refusal }] })
  })

  it('reports an empty completed set when nothing is in flight', async () => {
    const { runStates } = fakeRunStates()
    const report = await haltDispatch(
      { snapshot: snapshotOf([repoState([])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) },
    )
    expect(report).toEqual({ kind: 'completed', items: [] })
  })

  it('pauses before it stops — set() is called even when nothing ends up in flight', async () => {
    const { runStates, setCalls } = fakeRunStates()
    await haltDispatch(
      { snapshot: snapshotOf([repoState([])]), entries: [entry()], runStates, repoIds: [REPO_ID], auditDir: '/audit', now: NOW },
      { applyItemAction: () => Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) },
    )
    expect(setCalls).toEqual([[[REPO_ID], 'paused']])
  })

  it('skips items for a repository with no entry in scope (pause scoped to one repository)', async () => {
    const other = 'repo-b' as RepoId
    const { runStates } = fakeRunStates()
    let called = false
    const report = await haltDispatch(
      {
        snapshot: snapshotOf([repoState([item()], { repoId: other, repo: 'o/b' })]),
        entries: [entry()],
        runStates,
        repoIds: [REPO_ID],
        auditDir: '/audit',
        now: NOW,
      },
      { applyItemAction: () => { called = true; return Promise.resolve({ ok: true, outcome: { kind: 'applied', argv: [] } }) } },
    )
    expect(report).toEqual({ kind: 'completed', items: [] })
    expect(called).toBe(false)
  })
})
