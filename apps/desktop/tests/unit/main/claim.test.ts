import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { claimApply, claimPreflight } from '@/main/pipeline/claim'
import { createTestContext } from '../../support/context'
import { operatorRig, REPO_ID, type OperatorRigOptions } from '../../support/operator-rig'
import { ticketOf } from '../../support/tickets'

const UNCLAIMED: OperatorRigOptions = { viewer: 'alice', items: [{ number: 93, labels: [], assignees: [] }] }

const apply = (rig: Awaited<ReturnType<typeof operatorRig>>, overrides: Partial<Parameters<typeof claimApply>[1]> = {}) =>
  claimApply(rig.ctx, { repoId: REPO_ID, number: 93, planGate: 'review', confirmedAssignees: [], auditDir: rig.auditDir, ...overrides })

describe('claimPreflight', () => {
  it.each([
    { name: 'not registered', repositories: [], message: "claim found no repository registered with id 'repo-a'" },
    { name: 'not ready', repositories: [{ id: REPO_ID as RepoId, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }], message: "claim requires a 'ready' repository, got 'directory-missing'" },
  ])('rejects a repository that is $name', async ({ repositories, message }) => {
    await expect(claimPreflight(createTestContext({ repositories }), { repoId: REPO_ID, number: 93 })).rejects.toThrow(message)
  })

  it('surfaces a fetch failure as kind: failed', async () => {
    const rig = await operatorRig(UNCLAIMED)
    rig.github.failNextRead('dial tcp')
    expect(await claimPreflight(rig.ctx, { repoId: REPO_ID, number: 93 })).toMatchObject({ kind: 'failed' })
  })

  it('reports unresolved for a number that does not exist', async () => {
    const rig = await operatorRig(UNCLAIMED)
    expect(await claimPreflight(rig.ctx, { repoId: REPO_ID, number: 999_999 })).toEqual({ kind: 'unresolved' })
  })

  it('fails with the unseeded message while the store holds no state for the repository', async () => {
    const rig = await operatorRig({ ...UNCLAIMED, tickets: null })
    expect(await claimPreflight(rig.ctx, { repoId: REPO_ID, number: 93 })).toEqual({ kind: 'failed', message: "port hasn't loaded this repository's pipeline state yet" })
  })

  it('resolves a claimable item with its verdict', async () => {
    const rig = await operatorRig(UNCLAIMED)
    const result = await claimPreflight(rig.ctx, { repoId: REPO_ID, number: 93 })
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.viewer).toBe('alice')
    expect(result.verdict).toEqual({ kind: 'claimable', assigneeSituation: 'unassigned', others: [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 } })
  })
})

describe('claimApply', () => {
  it('refuses without writing when the fresh verdict is no longer claimable', async () => {
    const rig = await operatorRig(UNCLAIMED)
    expect(await apply(rig, { number: 999_999 })).toEqual({ kind: 'refused', verdict: { kind: 'not-found' } })
  })

  it('refuses as moved when the fresh assignee set disagrees with what was confirmed', async () => {
    const rig = await operatorRig({ viewer: 'alice', items: [{ number: 93, labels: [], assignees: ['bob'] }] })
    expect(await apply(rig)).toMatchObject({ kind: 'moved', confirmed: [], current: ['bob'] })
    expect(rig.github.assignees(93)).toEqual(['bob'])
  })

  it('claims an item for the viewer and tracks it, when confirmed and fresh assignees agree', async () => {
    const rig = await operatorRig(UNCLAIMED)
    expect(await apply(rig, { planGate: 'auto' })).toMatchObject({ kind: 'write', outcome: { kind: 'applied' } })
    expect(rig.github.assignees(93)).toEqual(['alice'])
    expect(rig.ticket(93)).toMatchObject({ autoPlan: true })
  })

  it('refuses a ticket the store already tracks, even when GitHub shows no labels', async () => {
    const rig = await operatorRig({ ...UNCLAIMED, tickets: [ticketOf({ repo: REPO_ID, ticket: 93 })] })
    expect(await apply(rig)).toEqual({ kind: 'refused', verdict: { kind: 'already-claimed', markerName: 'claude' } })
  })

  it('refuses with the unseeded state-unsaved outcome, and writes nothing, while the store holds no state', async () => {
    const rig = await operatorRig({ ...UNCLAIMED, tickets: null })
    expect(await apply(rig)).toEqual({ kind: 'write', outcome: { kind: 'state-unsaved', message: "port hasn't loaded this repository's pipeline state yet" } })
    expect(rig.github.assignees(93)).toEqual([])
  })

  it('surfaces an unreachable preflight as preflight-failed, without writing', async () => {
    const rig = await operatorRig(UNCLAIMED)
    rig.github.failNextRead('gh: 401')
    expect(await apply(rig)).toMatchObject({ kind: 'preflight-failed' })
    expect(rig.ticket(93)).toBeNull()
  })
})
