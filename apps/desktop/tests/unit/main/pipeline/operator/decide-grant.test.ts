import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { ItemDecisionRequest } from '@/types/actions'
import { applyItemDecision } from '@/main/pipeline/operator/decide'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { boardSnapshot as snapshotOf, reconciledItem, repositoryState } from '../../../../support/board-snapshot'
import { operatorRig, REPO_ID, type OperatorRigOptions } from '../../../../support/operator-rig'
import { queuedAt, ticketOf } from '../../../../support/tickets'

const PR = { number: 300, approvedAt: null }
const CHANGES_REQUESTED = ticketOf({ repo: REPO_ID, ticket: 51, pr: PR, stage: 'revise', status: queuedAt('changes-requested') })

const REQUEST: ItemDecisionRequest = { repoId: REPO_ID, number: 300, decision: 'grant', expected: ticketViewOf(CHANGES_REQUESTED), route: null, note: null, skipComment: false, picks: null }

const cappedItem = (overrides: Partial<ReconciledItem> = {}): ReconciledItem =>
  reconciledItem({ repoId: REPO_ID, kind: 'pull-request', number: 300, ticket: null, headRefOid: 'a'.repeat(40), reviewCycleCount: 5, ...overrides })

const AT_CAP: OperatorRigOptions = {
  viewer: 'op',
  items: [{ number: 51, labels: ['port'], assignees: ['op'] }, { number: 300, kind: 'pull-request', labels: ['port'], assignees: ['op'], headRefName: '51-fix', headRefOid: 'a'.repeat(40) }],
  tickets: [CHANGES_REQUESTED],
}

async function grant(options: { readonly rig?: OperatorRigOptions; readonly item?: ReconciledItem; readonly liveStage?: boolean } = {}) {
  const rig = await operatorRig(options.rig ?? AT_CAP)
  const snapshot = snapshotOf([repositoryState([options.item ?? cappedItem()], { repoId: REPO_ID, reviewCycleCap: 5 })])
  const result = applyItemDecision(rig.ctx, { request: REQUEST, snapshot, entry: rig.entry, auditDir: rig.auditDir, scratchDir: rig.scratchDir, liveStage: options.liveStage ?? false })
  return { rig, result }
}

describe('applyItemDecision — grant', () => {
  it('posts the cycle grant comment, then writes the unchanged label set and counts no-op as success', async () => {
    const { rig, result } = await grant()
    expect(await result).toMatchObject({ ok: true, comment: { kind: 'applied' } })
    expect(rig.github.comments(300)).toEqual(['## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.'])
  })

  it('refuses moved when the store shows the item waiting on a human, posting nothing', async () => {
    const atHuman: OperatorRigOptions = { ...AT_CAP, tickets: [ticketOf({ repo: REPO_ID, ticket: 51, pr: { number: 300, approvedAt: null }, stage: 'review', status: { kind: 'waiting-on-you', gate: 'escalation', detail: '' } })] }
    const { rig, result } = await grant({ rig: atHuman })
    expect(await result).toMatchObject({ ok: false, reason: 'moved' })
    expect(rig.github.comments(300)).toEqual([])
  })

  it('aborts comment-failed without touching the labels', async () => {
    const rig = await operatorRig(AT_CAP)
    rig.github.failComments('boom')
    const result = await applyItemDecision(rig.ctx, { request: REQUEST, snapshot: snapshotOf([repositoryState([cappedItem()], { repoId: REPO_ID, reviewCycleCap: 5 })]), entry: rig.entry, auditDir: rig.auditDir, scratchDir: rig.scratchDir, liveStage: false })
    expect(result).toMatchObject({ ok: false, reason: 'comment-failed' })
    expect(rig.ticket(51)?.rev).toBe(0)
  })

  it.each([
    { name: 'agent-live while a stage session is live', options: { liveStage: true }, expected: { ok: false, reason: 'refused', refusal: 'agent-live' } },
    { name: 'not-owned with the owners', options: { item: cappedItem({ assignees: ['other'] }) }, expected: { ok: false, reason: 'not-owned', owners: ['other'] } },
  ])('refuses $name', async ({ options, expected }) => {
    const { rig, result } = await grant(options)
    expect(await result).toEqual(expected)
    expect(rig.github.comments(300)).toEqual([])
  })

  it('throws below the cap, where grant does not apply', async () => {
    const { result } = await grant({ item: cappedItem({ reviewCycleCount: 2 }) })
    await expect(result).rejects.toThrow("'grant' is not applicable")
  })
})
