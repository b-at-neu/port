import { describe, expect, it } from 'vitest'
import type { RepositoryState, ReconciledItem } from '@/types/state'
import { applyItemAction } from '@/main/pipeline/operator/apply'
import type { ItemActionRequest } from '@/types/actions'
import { boardSnapshot as snapshotOf, reconciledItem, repositoryState as repoState } from '../../../support/board-snapshot'
import { operatorRig, REPO_ID } from '../../../support/operator-rig'
import { AT } from '../../../support/state-store'
import { ticketOf } from '../../../support/tickets'

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

const NOT_OK: RepositoryState = { ok: false, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', reason: 'github-unavailable', kind: 'network', message: 'boom', freshness: {
  github: { unavailable: 'boom' }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: AT }, worktrees: { at: AT }, denials: { at: AT },
} }

const movedItem = item({ stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], matchedKeys: ['inProgress'] })

describe('applyItemAction — refusals', () => {
  it.each([
    { name: 'a repository missing from the snapshot', snapshot: snapshotOf([]), expected: { ok: false, reason: 'repo-unavailable' } },
    { name: 'a repository that is present but not ok', snapshot: snapshotOf([NOT_OK]), expected: { ok: false, reason: 'repo-unavailable' } },
    { name: 'an item no longer in the reconciled list', snapshot: snapshotOf([repoState([])]), expected: { ok: false, reason: 'moved', expected: 'plan approved', observed: 'no longer tracked' } },
    { name: 'a stage that disagrees with expectedStage', snapshot: snapshotOf([repoState([movedItem])]), expected: { ok: false, reason: 'moved', expected: 'plan approved', observed: 'in progress' } },
    { name: 'a repository with no resolved viewer', snapshot: snapshotOf([repoState([item()], { viewer: null })]), expected: { ok: false, reason: 'viewer-unknown' } },
    { name: 'an item assigned to someone else', snapshot: snapshotOf([repoState([item({ assignees: ['other'] })])]), expected: { ok: false, reason: 'not-owned', owners: ['other'] } },
  ])('refuses $name', async ({ snapshot, expected }) => {
    const rig = await operatorRig()
    expect(await applyItemAction(rig.ctx, { request: request(), snapshot, entry: rig.entry, auditDir: rig.auditDir })).toEqual(expected)
  })

  it('throws when the action is not applicable and the stage did not drift — a client bug, not a race', async () => {
    const rig = await operatorRig()
    await expect(applyItemAction(rig.ctx, { request: request({ action: 'gate', expectedStage: 'planApproved' }), snapshot: snapshotOf([repoState([item({ kind: 'issue' })])]), entry: rig.entry, auditDir: rig.auditDir })).rejects.toThrow(/not applicable/)
  })

  it('resume: reports no-pause-record when nothing was ever paused', async () => {
    const rig = await operatorRig()
    const resumable = item({ marked: true, stage: null, stages: [], matchedKeys: [] })
    const result = await applyItemAction(rig.ctx, { request: request({ action: 'resume', expectedStage: null }), snapshot: snapshotOf([repoState([resumable])]), entry: rig.entry, auditDir: rig.auditDir })
    expect(result).toEqual({ ok: false, reason: 'no-pause-record' })
  })
})

describe('applyItemAction — writes', () => {
  it("applies the gate action and forwards the writer's outcome", async () => {
    const rig = await operatorRig({ items: [{ number: 148, labels: ['port'], assignees: [] }], tickets: [ticketOf({ repo: REPO_ID, ticket: 148 })] })
    const pr = item({ kind: 'pull-request', marked: false, assignees: [] })
    const result = await applyItemAction(rig.ctx, { request: request({ kind: 'pull-request', action: 'gate', expectedStage: 'planApproved' }), snapshot: snapshotOf([repoState([pr], { viewer: null })]), entry: rig.entry, auditDir: rig.auditDir })
    expect(result.ok).toBe(true)
  })
})
