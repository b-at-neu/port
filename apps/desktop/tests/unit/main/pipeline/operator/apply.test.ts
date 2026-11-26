import { describe, expect, it } from 'vitest'
import type { RepositoryState, ReconciledItem } from '@/types/state'
import { applyItemAction } from '@/main/pipeline/operator/apply'
import type { ItemActionRequest } from '@/types/actions'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { boardSnapshot as snapshotOf, reconciledItem, repositoryState as repoState } from '../../../../support/board-snapshot'
import { operatorRig, REPO_ID } from '../../../../support/operator-rig'
import { AT } from '../../../../support/state-store'
import { queuedAt, ticketOf } from '../../../../support/tickets'

const QUEUED = ticketOf({ repo: REPO_ID, ticket: 148, stage: 'implement', status: queuedAt() })
const RUNNING = ticketOf({ repo: REPO_ID, ticket: 148, stage: 'implement', status: { kind: 'running', runId: 'run-1' } })

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({ number: 148, url: 'https://github.com/o/a/issues/148', ticket: QUEUED, ...overrides })
}

function request(overrides: Partial<ItemActionRequest> = {}): ItemActionRequest {
  return { repoId: REPO_ID, kind: 'issue', number: 148, action: 'pause', expected: ticketViewOf(QUEUED), ...overrides }
}

const NOT_OK: RepositoryState = { ok: false, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', reason: 'github-unavailable', kind: 'network', message: 'boom', freshness: {
  github: { unavailable: 'boom' }, itemStates: { unavailable: 'no re-check needed' }, sessions: { at: AT }, worktrees: { at: AT }, denials: { at: AT },
} }

const ISSUE_148 = { number: 148, labels: ['port'], assignees: ['op'] }

describe('applyItemAction — refusals', () => {
  it.each([
    { name: 'a repository missing from the snapshot', snapshot: snapshotOf([]), expected: { ok: false, reason: 'repo-unavailable' } },
    { name: 'a repository that is present but not ok', snapshot: snapshotOf([NOT_OK]), expected: { ok: false, reason: 'repo-unavailable' } },
    { name: 'an item no longer in the reconciled list', snapshot: snapshotOf([repoState([])]), expected: { ok: false, reason: 'moved', observed: 'no longer tracked' } },
    { name: 'a repository with no resolved viewer', snapshot: snapshotOf([repoState([item()], { viewer: null })]), expected: { ok: false, reason: 'viewer-unknown' } },
    { name: 'an item assigned to someone else', snapshot: snapshotOf([repoState([item({ assignees: ['other'] })])]), expected: { ok: false, reason: 'not-owned', owners: ['other'] } },
  ])('refuses $name', async ({ snapshot, expected }) => {
    const rig = await operatorRig({ items: [ISSUE_148], tickets: [QUEUED] })
    expect(await applyItemAction(rig.ctx, { request: request(), snapshot, entry: rig.entry, auditDir: rig.auditDir })).toMatchObject(expected)
  })

  it('refuses as moved when the stored ticket no longer matches the view the operator saw', async () => {
    const rig = await operatorRig({ items: [ISSUE_148], tickets: [RUNNING] })
    const result = await applyItemAction(rig.ctx, { request: request(), snapshot: snapshotOf([repoState([item()])]), entry: rig.entry, auditDir: rig.auditDir })
    expect(result).toMatchObject({ ok: false, reason: 'moved' })
  })

  it('throws when the action is not applicable and the ticket did not move — a client bug, not a race', async () => {
    const rig = await operatorRig({ items: [ISSUE_148], tickets: [QUEUED] })
    await expect(applyItemAction(rig.ctx, { request: request({ action: 'gate' }), snapshot: snapshotOf([repoState([item({ kind: 'issue' })])]), entry: rig.entry, auditDir: rig.auditDir })).rejects.toThrow(/not applicable/)
  })

  it('resume: is not applicable on a ticket that was never paused', async () => {
    const rig = await operatorRig({ items: [ISSUE_148], tickets: [QUEUED] })
    await expect(applyItemAction(rig.ctx, { request: request({ action: 'resume' }), snapshot: snapshotOf([repoState([item()])]), entry: rig.entry, auditDir: rig.auditDir })).rejects.toThrow(/not applicable/)
  })
})

describe('applyItemAction — writes', () => {
  it("applies the gate action and forwards the writer's outcome", async () => {
    const rig = await operatorRig({ items: [ISSUE_148], tickets: [QUEUED] })
    const pr = item({ kind: 'pull-request', marked: false, assignees: [], stages: [{ key: 'reviewing', name: 'reviewing', role: 'in-flight' }] })
    const result = await applyItemAction(rig.ctx, { request: request({ kind: 'pull-request', action: 'gate', expected: null }), snapshot: snapshotOf([repoState([{ ...pr, ticket: null }], { viewer: null })]), entry: rig.entry, auditDir: rig.auditDir })
    expect(result.ok).toBe(true)
  })

  it('applies a pause as an operator move on the stored ticket', async () => {
    const rig = await operatorRig({ items: [ISSUE_148], tickets: [QUEUED] })
    const result = await applyItemAction(rig.ctx, { request: request(), snapshot: snapshotOf([repoState([item()])]), entry: rig.entry, auditDir: rig.auditDir })
    expect(result.ok).toBe(true)
    expect(rig.ctx.stores.pipelineState.ticket(REPO_ID, { kind: 'issue', number: 148 })).toMatchObject({ rev: QUEUED.rev + 1, status: { kind: 'held', on: 'paused' } })
  })
})
