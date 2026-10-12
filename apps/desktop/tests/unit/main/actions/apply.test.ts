import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import type { ApplyLabelsParams } from '@/main/writes/apply'
import type { RecoverPausedTriggerResult } from '@/main/actions/resume'
import { applyItemAction } from '@/main/actions/apply'
import type { ApplyItemActionDeps, ItemActionRequest } from '@/main/actions/apply'
import { boardSnapshot as snapshotOf, readyEntry as entry, reconciledItem, repositoryState as repoState } from '../../../fixtures/board-state'

const REPO_ID = 'repo-a' as RepoId

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({
    number: 148,
    url: 'https://github.com/o/a/issues/148',
    stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }],
    matchedKeys: ['planApproved'],
    ...overrides,
  })
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
