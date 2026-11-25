import { describe, expect, it } from 'vitest'
import { autoApprovePlan, gateAnswer, gatePreflight } from '@/main/pipeline/operator/gate'
import type { GateAnswerParams } from '@/types/actions'
import { createTestContext } from '../../../support/context'
import { operatorRig, REPO_ID, type OperatorRigOptions } from '../../../support/operator-rig'
import { ticketOf } from '../../../support/tickets'

const BODY = 'Ticket body.\n\n## Implementation Plan\n\nPlan text.'
const atPlanReview = ticketOf({ repo: REPO_ID, ticket: 148, stage: 'plan', status: { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' } })
const GATE: OperatorRigOptions = { viewer: 'alice', items: [{ number: 148, title: 'E3 · Plan review gate', labels: ['port', 'plan review'], assignees: [], body: BODY }], tickets: [atPlanReview] }

const answer = (rig: Awaited<ReturnType<typeof operatorRig>>, overrides: Partial<GateAnswerParams> = {}) =>
  gateAnswer(rig.ctx, { repoId: REPO_ID, number: 148, decision: 'approve', feedback: null, skipComment: false, auditDir: rig.auditDir, scratchDir: rig.scratchDir, ...overrides })

describe('gatePreflight', () => {
  it.each([
    { name: 'a repository that is not registered', repositories: [], repoId: REPO_ID, message: "gate found no repository registered with id 'repo-a'" },
    { name: 'a repository that is not ready', repositories: [{ id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }], repoId: REPO_ID, message: "gate requires a 'ready' repository, got 'directory-missing'" },
  ])('rejects $name', async ({ repositories, repoId, message }) => {
    const ctx = createTestContext({ repositories })
    await expect(gatePreflight(ctx, { repoId: repoId, number: 148 })).rejects.toThrow(message)
  })

  it('carries ownership on a fetch failure', async () => {
    const rig = await operatorRig(GATE)
    rig.github.failNextRead('dial tcp')
    expect(await gatePreflight(rig.ctx, { repoId: REPO_ID, number: 148 })).toMatchObject({ kind: 'failed', ownership: { kind: 'absent' } })
  })

  it('reports unresolved for a number that does not exist, carrying ownership', async () => {
    const rig = await operatorRig(GATE)
    expect(await gatePreflight(rig.ctx, { repoId: REPO_ID, number: 999_999 })).toEqual({ kind: 'unresolved', ownership: { kind: 'absent' } })
  })

  it('resolves an answerable item, splitting ticket and plan markdown at the heading, and summarizes ownership', async () => {
    const rig = await operatorRig({ ...GATE, appOwned: true })
    const result = await gatePreflight(rig.ctx, { repoId: REPO_ID, number: 148 })
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.ticketMarkdown).toBe('Ticket body.')
    expect(result.preflight.planMarkdown).toBe('## Implementation Plan\n\nPlan text.')
    expect(result.preflight.sessionRequired).toBe(false)
    expect(result.verdict).toEqual({ kind: 'answerable', noPlanBlock: false, assignedElsewhere: [] })
    expect(result.ownership.kind).toBe('app')
  })

  it('fails with the unseeded message while the store holds no state for the repository', async () => {
    const rig = await operatorRig({ ...GATE, tickets: null })
    expect(await gatePreflight(rig.ctx, { repoId: REPO_ID, number: 148 })).toEqual({ kind: 'failed', message: "port hasn't loaded this repository's pipeline state yet", ownership: { kind: 'absent' } })
  })

  it('reports noPlanBlock when the body carries no Implementation Plan heading', async () => {
    const rig = await operatorRig({ ...GATE, items: [{ number: 148, labels: ['port'], assignees: [], body: 'Just a ticket body.' }] })
    const result = await gatePreflight(rig.ctx, { repoId: REPO_ID, number: 148 })
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.planMarkdown).toBeNull()
    expect(result.verdict).toEqual({ kind: 'answerable', noPlanBlock: true, assignedElsewhere: [] })
  })
})

describe('gateAnswer', () => {
  it('refuses without any write when the fresh verdict is no longer answerable', async () => {
    const rig = await operatorRig({ ...GATE, tickets: [ticketOf({ repo: REPO_ID, ticket: 148, stage: 'implement' })] })
    expect(await answer(rig)).toMatchObject({ kind: 'refused', verdict: { kind: 'not-at-plan-review' } })
    expect(rig.ticket(148)?.rev).toBe(0)
  })

  it('surfaces an unreachable preflight as preflight-failed, without writing', async () => {
    const rig = await operatorRig(GATE)
    rig.github.failNextRead('gh: 401')
    expect(await answer(rig)).toMatchObject({ kind: 'preflight-failed' })
    expect(rig.ticket(148)?.rev).toBe(0)
  })

  it('approve: never posts a comment, moves the ticket to implementation', async () => {
    const rig = await operatorRig(GATE)
    expect(await answer(rig)).toMatchObject({ kind: 'answered', comment: null, labels: { kind: 'applied' } })
    expect(rig.github.comments(148)).toEqual([])
    expect(rig.ticket(148)).toMatchObject({ rev: 1, stage: 'implement' })
  })

  it('request-changes: posts the comment, then swaps the labels', async () => {
    const rig = await operatorRig(GATE)
    const result = await answer(rig, { decision: 'request-changes', feedback: 'please rework the risks section' })
    expect(result).toMatchObject({ kind: 'answered', comment: { kind: 'applied' }, labels: { kind: 'applied' } })
    expect(rig.github.comments(148)).toEqual(['please rework the risks section'])
    expect(rig.ticket(148)?.rev).toBe(1)
  })

  it('aborts as comment-failed before touching any label when the comment does not land', async () => {
    const rig = await operatorRig(GATE)
    rig.github.failComments('boom')
    expect(await answer(rig, { decision: 'request-changes', feedback: 'x' })).toMatchObject({ kind: 'comment-failed', comment: { kind: 'write-failed', stderr: 'boom' } })
    expect(rig.ticket(148)?.rev).toBe(0)
    expect(rig.github.labels(148)).toEqual(['port', 'plan review'])
  })

  it('skipComment suppresses the comment and nothing else — only the label swap retries', async () => {
    const rig = await operatorRig(GATE)
    expect(await answer(rig, { decision: 'request-changes', feedback: 'x', skipComment: true })).toMatchObject({ kind: 'answered', comment: null, labels: { kind: 'applied' } })
    expect(rig.github.comments(148)).toEqual([])
    expect(rig.ticket(148)?.rev).toBe(1)
  })
})

describe('autoApprovePlan', () => {
  it('approves an auto-plan ticket at the gate with no comment', async () => {
    const rig = await operatorRig({ ...GATE, items: [{ number: 148, labels: ['port', 'plan review', 'auto plan'], assignees: ['alice'], body: BODY }], tickets: [{ ...atPlanReview, autoPlan: true }] })
    const outcome = await autoApprovePlan(rig.ctx, { entry: rig.entry, item: { number: 148, assignees: ['alice'] }, auditDir: rig.auditDir })
    expect(outcome.kind).toBe('applied')
    expect(rig.ticket(148)).toMatchObject({ rev: 1, stage: 'implement' })
    expect(rig.github.comments(148)).toEqual([])
  })
})
