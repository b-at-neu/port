import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import type { LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import type { ApplyLabelsParams } from '../writes'
import type { RecoverPausedTriggerResult } from './resume'
import { applyItemAction } from './apply'
import type { ApplyItemActionDeps, ItemActionRequest, ReadyEntry } from './apply'

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
      commands: { worktrees: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
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
    stage: 'trigger',
    stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }],
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
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['planApproved'],
    sources: ['github'],
    claimedFiles: null,
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
    ...overrides,
  }
}

function snapshotOf(repositories: readonly RepositoryState[]): BoardSnapshot {
  return {
    state: { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00Z' }, readAt: '2026-01-01T00:00:00Z' },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick: [],
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
  }
}

function request(overrides: Partial<ItemActionRequest> = {}): ItemActionRequest {
  return { repoId: REPO_ID, kind: 'issue', number: 148, action: 'pause', expectedStage: 'planApproved', ...overrides }
}

function fakeDeps(overrides: Partial<ApplyItemActionDeps> = {}): { readonly deps: ApplyItemActionDeps; readonly calls: LabelWriteRequest[] } {
  const calls: LabelWriteRequest[] = []
  const deps: ApplyItemActionDeps = {
    applyLabels: (params: ApplyLabelsParams): Promise<WriteOutcome> => {
      calls.push(params.request)
      return Promise.resolve({ kind: 'applied', argv: [] })
    },
    recoverPausedTrigger: (): Promise<RecoverPausedTriggerResult> => Promise.resolve({ kind: 'no-record' }),
    ...overrides,
  }
  return { deps, calls }
}

describe('applyItemAction', () => {
  it('refuses repo-unavailable when the repository is missing from the snapshot entirely', async () => {
    const { deps } = fakeDeps()
    const result = await applyItemAction({ request: request(), snapshot: snapshotOf([]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: false, reason: 'repo-unavailable' })
  })

  it('refuses repo-unavailable when the repository is present but not ok (github-unavailable)', async () => {
    const { deps } = fakeDeps()
    const notOk: RepositoryState = { ok: false, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', reason: 'github-unavailable', kind: 'network', message: 'boom', freshness: {
      github: { unavailable: 'boom' }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: '2026-01-01T00:00:00Z' }, worktrees: { at: '2026-01-01T00:00:00Z' }, denials: { at: '2026-01-01T00:00:00Z' },
    } }
    const result = await applyItemAction({ request: request(), snapshot: snapshotOf([notOk]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: false, reason: 'repo-unavailable' })
  })

  it('refuses moved when the item is no longer in the reconciled list at all', async () => {
    const { deps } = fakeDeps()
    const result = await applyItemAction({ request: request(), snapshot: snapshotOf([repoState([])]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: false, reason: 'moved', expected: 'plan approved', observed: 'no longer tracked' })
  })

  it('refuses moved when the fresh stage disagrees with expectedStage, naming both', async () => {
    const movedItem = item({ stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], matchedKeys: ['inProgress'] })
    const { deps } = fakeDeps()
    const result = await applyItemAction({ request: request({ expectedStage: 'planApproved' }), snapshot: snapshotOf([repoState([movedItem])]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: false, reason: 'moved', expected: 'plan approved', observed: 'in progress' })
  })

  it('refuses viewer-unknown when the repository has no resolved viewer', async () => {
    const { deps } = fakeDeps()
    const result = await applyItemAction({ request: request(), snapshot: snapshotOf([repoState([item()], { viewer: null })]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: false, reason: 'viewer-unknown' })
  })

  it('refuses not-owned, naming the current assignees, when assigned to someone else', async () => {
    const { deps } = fakeDeps()
    const owned = item({ assignees: ['other'] })
    const result = await applyItemAction({ request: request(), snapshot: snapshotOf([repoState([owned])]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: false, reason: 'not-owned', owners: ['other'] })
  })

  it('applies pause and forwards applyLabels\' own outcome unchanged', async () => {
    const { deps, calls } = fakeDeps()
    const result = await applyItemAction({ request: request(), snapshot: snapshotOf([repoState([item()])]), entry: entry(), auditDir: '/audit' }, deps)
    expect(result).toEqual({ ok: true, outcome: { kind: 'applied', argv: [] } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ repo: 'o/a', kind: 'issue', number: 148, remove: ['planApproved'], action: 'pause' })
  })

  it('resume: reports no-pause-record without ever calling applyLabels', async () => {
    const resumable = item({ marked: true, stage: null, stages: [], matchedKeys: [] })
    const { deps, calls } = fakeDeps({ recoverPausedTrigger: () => Promise.resolve({ kind: 'no-record' }) })
    const result = await applyItemAction(
      { request: request({ action: 'resume', expectedStage: null }), snapshot: snapshotOf([repoState([resumable])]), entry: entry(), auditDir: '/audit' },
      deps,
    )
    expect(result).toEqual({ ok: false, reason: 'no-pause-record' })
    expect(calls).toHaveLength(0)
  })

  it('resume: reports pause-record-unresolvable without ever calling applyLabels', async () => {
    const resumable = item({ marked: true, stage: null, stages: [], matchedKeys: [] })
    const { deps, calls } = fakeDeps({ recoverPausedTrigger: () => Promise.resolve({ kind: 'unresolvable' }) })
    const result = await applyItemAction(
      { request: request({ action: 'resume', expectedStage: null }), snapshot: snapshotOf([repoState([resumable])]), entry: entry(), auditDir: '/audit' },
      deps,
    )
    expect(result).toEqual({ ok: false, reason: 'pause-record-unresolvable' })
    expect(calls).toHaveLength(0)
  })

  it('resume: fills the recovered trigger into the plan before writing', async () => {
    const resumable = item({ marked: true, stage: null, stages: [], matchedKeys: [] })
    const { deps, calls } = fakeDeps({ recoverPausedTrigger: () => Promise.resolve({ kind: 'recovered', trigger: 'ready' }) })
    const result = await applyItemAction(
      { request: request({ action: 'resume', expectedStage: null }), snapshot: snapshotOf([repoState([resumable])]), entry: entry(), auditDir: '/audit' },
      deps,
    )
    expect(result).toEqual({ ok: true, outcome: { kind: 'applied', argv: [] } })
    expect(calls[0]?.add).toEqual(['ready'])
  })

  it('gate: available and applied even when the repository has no resolved viewer', async () => {
    const pr = item({ kind: 'pull-request', marked: false, assignees: [] })
    const { deps, calls } = fakeDeps()
    const result = await applyItemAction(
      { request: request({ kind: 'pull-request', action: 'gate', expectedStage: 'planApproved' }), snapshot: snapshotOf([repoState([pr], { viewer: null })]), entry: entry(), auditDir: '/audit' },
      deps,
    )
    expect(result).toEqual({ ok: true, outcome: { kind: 'applied', argv: [] } })
    expect(calls[0]?.add).toEqual(['marker'])
  })

  it('throws when the action is not applicable and the stage did not drift — a client bug, not a race', async () => {
    const { deps } = fakeDeps()
    const issue = item({ kind: 'issue' })
    await expect(
      applyItemAction({ request: request({ action: 'gate', expectedStage: 'planApproved' }), snapshot: snapshotOf([repoState([issue])]), entry: entry(), auditDir: '/audit' }, deps),
    ).rejects.toThrow(/not applicable/)
  })
})
