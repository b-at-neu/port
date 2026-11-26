import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { ApplyObservationParams } from '@/types/actions'
import { applyObservation } from '@/main/pipeline/operator/observe'
import { reconciledItem } from '../../../../support/board-snapshot'
import { operatorRig, REPO_ID, type OperatorRigOptions } from '../../../../support/operator-rig'
import { ticketOf } from '../../../../support/tickets'

const pullRequestRig = (): OperatorRigOptions => ({
  items: [{ number: 7, labels: ['port'], assignees: ['op'] }, { number: 52, kind: 'pull-request', labels: ['port'], assignees: ['op'], headRefName: '7-fix', headRefOid: 'abc1234' }],
  tickets: [ticketOf({ repo: REPO_ID, ticket: 7, pr: { number: 52, approvedAt: null }, stage: 'review' })],
})

const item = (comments: ReconciledItem['comments']): ReconciledItem =>
  reconciledItem({ repoId: REPO_ID, kind: 'pull-request', number: 52, stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }], matchedKeys: ['readyForReview'], headRefOid: 'abc1234', comments })

async function observeZeroDiff(comments: ReconciledItem['comments']) {
  const rig = await operatorRig(pullRequestRig())
  const params: ApplyObservationParams = { entry: rig.entry, item: item(comments), observation: { kind: 'zero-diff', number: 52, itemKind: 'pull-request', count: 2, headRefOid: 'abc1234' }, auditDir: rig.auditDir, scratchDir: rig.scratchDir }
  return { rig, result: await applyObservation(rig.ctx, params) }
}

describe('applyObservation — escalation dedup', () => {
  it('posts the first escalation on a head', async () => {
    const { rig, result } = await observeZeroDiff([])
    expect(result.comment?.kind).toBe('applied')
    expect(rig.github.comments(52)).toHaveLength(1)
  })

  it.each([
    { name: 'skips the comment when the newest escalation already carries this cause on this head', head: 'abc1234', posted: 0 },
    { name: 'posts again for the same cause on a moved head', head: 'old1111', posted: 1 },
  ])('$name', async ({ head, posted }) => {
    const comments = [{ body: `## Pipeline Escalation\nEarlier.\n<!-- port:escalation sha-cap ${head} -->`, createdAt: '2026-01-01T00:00:00Z' }]
    const { rig, result } = await observeZeroDiff(comments)
    expect(result.labels.kind).toBe('applied')
    expect(rig.github.comments(52)).toHaveLength(posted)
  })
})

describe('applyObservation — plan-missing re-read', () => {
  const issueRig = (body: string | null): OperatorRigOptions => ({
    items: body === null ? [] : [{ number: 52, labels: ['port'], assignees: ['op'], body }],
    tickets: [ticketOf({ repo: REPO_ID, ticket: 52, stage: 'plan', status: { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' } })],
  })

  it.each([
    { name: 'stale snapshot, plan on re-read', body: 'Why\n\n## Implementation Plan\n\nSteps', labels: 'no-op', comments: 0 },
    { name: 'genuinely missing plan', body: 'Why\n\nNo plan here', labels: 'applied', comments: 1 },
    { name: 'heading only inside a longer line', body: 'See ## Implementation Plan below', labels: 'applied', comments: 1 },
    { name: 're-read resolves to no item', body: null, labels: 'item-unavailable', comments: 0 },
  ])('$name', async ({ body, labels, comments }) => {
    const rig = await operatorRig(issueRig(body))
    const planMissing = reconciledItem({ repoId: REPO_ID, kind: 'issue', number: 52, stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], matchedKeys: ['planReview'], planPresent: false })
    const result = await applyObservation(rig.ctx, { entry: rig.entry, item: planMissing, observation: { kind: 'plan-missing', number: 52, itemKind: 'issue' }, auditDir: rig.auditDir, scratchDir: rig.scratchDir })
    expect(result.labels.kind).toBe(labels)
    if (body !== null) expect(rig.github.comments(52)).toHaveLength(comments)
  })

  it('reports a failed re-read without writing', async () => {
    const rig = await operatorRig(issueRig('Why'))
    rig.github.failNextRead('timed out')
    const planMissing = reconciledItem({ repoId: REPO_ID, kind: 'issue', number: 52, stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], matchedKeys: ['planReview'], planPresent: false })
    const result = await applyObservation(rig.ctx, { entry: rig.entry, item: planMissing, observation: { kind: 'plan-missing', number: 52, itemKind: 'issue' }, auditDir: rig.auditDir, scratchDir: rig.scratchDir })
    expect(result.labels.kind).toBe('verify-failed')
    expect(result.comment).toBeNull()
    expect(rig.github.labels(52)).toEqual(['port'])
  })
})
