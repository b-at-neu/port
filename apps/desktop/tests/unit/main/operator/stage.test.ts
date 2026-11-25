import { describe, expect, it } from 'vitest'
import { applyStageClaim, applyStageTransition, refusalOf } from '@/main/pipeline/operator/stage'
import type { ResolvedItem } from '@/types/github'
import type { StageEvent, StagePlanFile } from '@/types/stage-labels'
import type { WriteOutcome } from '@/types/writes'
import type { Stage, Status, Ticket } from '@/utils/pipeline/ticket'
import type { FakeItem } from '../../../support/fake-github'
import { operatorRig, REPO_ID } from '../../../support/operator-rig'
import { NOW, ticketOf } from '../../../support/tickets'
import { item as reconciled } from '../incidents/fixtures'

const issue: FakeItem = { number: 52, assignees: ['op'], labels: ['port'] }
const pr = (number: number, overrides: Partial<FakeItem> = {}): FakeItem => ({ number, kind: 'pull-request', assignees: ['op'], headRefName: '52-add-thing', labels: ['port'], ...overrides })
const resolvedIssue: ResolvedItem = { number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: ['op'], headRefName: null, headRefOid: null, author: null }

const queued: Status = { kind: 'queued', reason: 'new', since: NOW }
const running: Status = { kind: 'running', runId: null }
const at = (stage: Stage, status: Status, overrides: Partial<Ticket> = {}): Ticket => ticketOf({ repo: REPO_ID, ticket: 52, stage, status, ...overrides })

const IMPL = { number: 52, kind: 'issue', agent: 'impl', trigger: 'planApproved' } as const
const PLAN = { number: 52, kind: 'issue', agent: 'plan', trigger: 'ready' } as const
const REVIEW = { number: 52, kind: 'pull-request', agent: 'review', trigger: 'readyForReview' } as const
const PR_OPENED: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null }
const planWritten = (plan: StagePlanFile | null): StageEvent => ({ kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan })
const READ_PLAN = planWritten({ kind: 'read', body: '## Implementation Plan' })

async function stage(items: readonly FakeItem[], tickets: readonly Ticket[] | null) {
  const rig = await operatorRig({ items, tickets })
  return {
    ...rig,
    transition: (record: Parameters<typeof applyStageTransition>[1]['record'], event: StageEvent, snapshot?: Parameters<typeof applyStageTransition>[1]['snapshot']) =>
      applyStageTransition(rig.ctx, { entry: rig.entry, record, event, auditDir: rig.auditDir, scratchDir: rig.scratchDir, ...(snapshot === undefined ? {} : { snapshot }) }),
  }
}

describe('refusalOf', () => {
  it.each<[WriteOutcome, string | null, boolean]>([
    [{ kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: 'r' } }, 'moved', false],
    [{ kind: 'unresolvable-label', keys: ['planReview'] }, 'unresolvable-label', false],
    [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }, 'write-failed', true],
    [{ kind: 'verify-failed', message: 'no net' }, 'write-failed', true],
    [{ kind: 'ownership-unreadable', path: 'p', message: 'bad' }, 'write-failed', true],
    [{ kind: 'item-unavailable' }, 'write-failed', true],
    [{ kind: 'state-unsaved', message: 'disk full' }, 'write-failed', true],
    [{ kind: 'no-op' }, null, false],
    [{ kind: 'applied', argv: [] }, null, false],
    [{ kind: 'mirror-failed', mirror: { kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null } }, null, false],
  ])('%j → %s (retryable: %s)', (outcome, reason, retryable) => {
    expect(refusalOf(outcome)).toMatchObject(reason === null ? { kind: 'applied' } : { kind: 'refused', reason, retryable })
  })
})

describe('applyStageClaim', () => {
  it('moves the claimed ticket to running from the re-read item', async () => {
    const rig = await operatorRig({ items: [issue], tickets: [at('implement', queued)] })
    expect(await applyStageClaim(rig.ctx, { entry: rig.entry, candidate: IMPL, resolved: resolvedIssue, auditDir: rig.auditDir })).toEqual({ kind: 'applied' })
    expect(rig.ticket(52)).toMatchObject({ rev: 1, stage: 'implement', status: { kind: 'running' } })
  })

  it('refuses a claim whose assignees no longer match the re-read item', async () => {
    const rig = await operatorRig({ items: [{ ...issue, assignees: ['someone-else'] }], tickets: [at('implement', queued)] })
    expect(await applyStageClaim(rig.ctx, { entry: rig.entry, candidate: IMPL, resolved: resolvedIssue, auditDir: rig.auditDir })).toMatchObject({ kind: 'refused', reason: 'moved' })
    expect(rig.ticket(52)?.rev).toBe(0)
  })
})

describe('applyStageTransition — reads', () => {
  it('an unreadable item is a retryable write-failed with no write', async () => {
    const rig = await stage([], [at('plan', running)])
    expect(await rig.transition(PLAN, READ_PLAN)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
  })

  it('a failed read is a retryable write-failed', async () => {
    const rig = await stage([issue], [at('plan', running)])
    rig.github.failNextRead('offline')
    expect(await rig.transition(PLAN, READ_PLAN)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
  })

  it.each([
    ['a missing hand-back', { kind: 'outcome', outcome: 'completed', handback: null, plan: null }, 'no-handback'],
    ['an unknown token', { kind: 'outcome', outcome: 'completed', handback: { token: 'done', arg: null }, plan: null }, 'unknown-handback'],
  ] as const)('refuses %s before reading anything', async (_name, bad, reason) => {
    const rig = await stage([issue], [at('plan', running)])
    rig.github.failNextRead('must not be read')
    expect(await rig.transition(PLAN, bad)).toMatchObject({ kind: 'refused', reason, retryable: false })
  })

  it('writes nothing for an outcome the table leaves to Resume', async () => {
    const rig = await stage([issue], [at('plan', running)])
    expect(await rig.transition(PLAN, { kind: 'outcome', outcome: 'interrupted', handback: null, plan: null })).toEqual({ kind: 'applied' })
    expect(rig.ticket(52)?.rev).toBe(0)
  })
})

describe('applyStageTransition — incidents', () => {
  const blocked: StageEvent = { kind: 'outcome', outcome: 'blocked', handback: null, plan: null }
  const snapshotItem = reconciled({ kind: 'issue', number: 52, closingPullRequests: [{ number: 80, state: 'OPEN', headRefName: '52-add-thing' }] })

  it.each([
    { name: 'an existing-work incident for a blocked impl hand-back with an open pull request', item: snapshotItem, expected: { bucket: 'existing-work', stage: 'blocked', condition: 'pr-open' } },
    { name: 'an escalation incident when the ticket has no open pull request of its own', item: null, expected: { bucket: 'escalation', stage: 'blocked' } },
  ])('attaches $name', async ({ item, expected }) => {
    const rig = await stage([issue], [at('implement', running)])
    await rig.transition(IMPL, blocked, { item, at: 'tick-1' })
    expect(rig.incidents[0]).toMatchObject(expected)
  })

  it('attaches nothing without a snapshot, and nothing for a hand-back that lands on no human', async () => {
    const withoutSnapshot = await stage([issue], [at('implement', running)])
    await withoutSnapshot.transition(IMPL, blocked)
    expect(withoutSnapshot.incidents).toEqual([])

    const planned = await stage([issue], [at('plan', running)])
    await planned.transition(PLAN, planWritten({ kind: 'read', body: 'b' }), { item: null, at: null })
    expect(planned.incidents).toEqual([])
  })
})

describe('applyStageTransition — plan-written body', () => {
  it('posts the body, then moves the ticket to the plan gate', async () => {
    const rig = await stage([issue], [at('plan', running)])
    expect(await rig.transition(PLAN, READ_PLAN)).toEqual({ kind: 'applied' })
    expect(rig.github.body(52)).toBe('## Implementation Plan')
    expect(rig.ticket(52)).toMatchObject({ rev: 1, status: { kind: 'waiting-on-you', gate: 'plan-approval' } })
  })

  it('posts nothing when the ticket moved while the session ran, or is not tracked', async () => {
    const moved = await stage([issue], [at('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' })])
    await moved.transition(PLAN, READ_PLAN)
    expect(moved.github.body(52)).toBe('')
    const untracked = await stage([issue], [])
    await untracked.transition(PLAN, READ_PLAN)
    expect(untracked.github.body(52)).toBe('')
  })

  it.each<[StagePlanFile | null, string, string | null]>([
    [null, 'no-plan-file', null],
    [{ kind: 'missing', detail: 'EACCES: denied' }, 'no-plan-file', 'EACCES: denied'],
    [{ kind: 'empty' }, 'empty-plan-file', null],
  ])('refuses %j before any read or write', async (plan, reason, detail) => {
    const rig = await stage([issue], [at('plan', running)])
    rig.github.failNextRead('must not be read')
    expect(await rig.transition(PLAN, planWritten(plan))).toEqual({ kind: 'refused', reason, retryable: false, detail })
    expect(rig.github.body(52)).toBe('')
  })

  it('a failed body post is retryable and moves nothing', async () => {
    const rig = await stage([issue], [at('plan', running)])
    rig.github.failWrites(52, 'boom')
    expect(await rig.transition(PLAN, READ_PLAN)).toEqual({ kind: 'refused', reason: 'write-failed', retryable: true, detail: 'boom' })
    expect(rig.ticket(52)?.rev).toBe(0)
  })
})

describe('applyStageTransition — pr-opened', () => {
  const inProgress = [at('implement', running, { rev: 2 })]

  it('moves the ticket to review with the pull request, on the rev it read', async () => {
    const rig = await stage([issue, pr(8)], inProgress)
    expect(await rig.transition(IMPL, PR_OPENED)).toEqual({ kind: 'applied' })
    expect(rig.ticket(52)).toMatchObject({ rev: 3, stage: 'review', pr: { number: 8 } })
  })

  it.each([
    ['a closed pull request', [issue, pr(8, { state: 'CLOSED' })]],
    ['a pull request on another issue’s branch', [issue, pr(8, { headRefName: '53-other-thing' })]],
    ['a branch that only starts with the same digits', [issue, pr(8, { headRefName: '520-other-thing' })]],
    ['an issue named as the pull request', [issue, { number: 8, assignees: ['op'] }]],
    ['a pull request that does not exist', [issue]],
  ])('rejects %s with no write', async (_name, items) => {
    const rig = await stage(items, inProgress)
    expect(await rig.transition(IMPL, PR_OPENED)).toEqual({ kind: 'refused', reason: 'pr-unverified', retryable: false, detail: null })
    expect(rig.ticket(52)?.rev).toBe(2)
  })

  it('a failed label write after the commit still reports applied, since the state moved', async () => {
    const rig = await stage([issue, pr(8)], inProgress)
    rig.github.failWrites(52, 'boom')
    expect(await rig.transition(IMPL, PR_OPENED)).toEqual({ kind: 'applied' })
    expect(rig.ticket(52)).toMatchObject({ stage: 'review', mirror: { failure: { outcome: { kind: 'write-failed' } } } })
  })

  it('adopts the same way, and refuses an adoption of a pull request not open on the issue’s own branch', async () => {
    const adopt: StageEvent = { kind: 'adopt', handback: { token: 'pr-opened', arg: '#8' } }
    const ok = await stage([issue, pr(8)], [at('implement', queued)])
    expect(await ok.transition(IMPL, adopt)).toEqual({ kind: 'applied' })
    expect(ok.ticket(52)).toMatchObject({ stage: 'review', pr: { number: 8 } })
    const bad = await stage([issue, pr(8, { headRefName: '53-other-thing' })], inProgress)
    expect(await bad.transition(IMPL, adopt)).toMatchObject({ reason: 'pr-unverified' })
  })
})

describe('applyStageTransition — other events', () => {
  it.each([
    { name: 'a rollback re-queues the ticket', event: { kind: 'rollback' } as StageEvent, from: at('implement', running), after: { status: { kind: 'queued' } } },
    { name: 'an error outcome resets the ticket', event: { kind: 'outcome', outcome: 'error', handback: null, plan: null } as StageEvent, from: at('implement', running), after: { status: { kind: 'queued' } } },
    { name: 'the next turn unblocks the ticket', event: { kind: 'resumed-turn' } as StageEvent, from: at('implement', { kind: 'blocked', on: [], reason: '' }), after: { status: { kind: 'running' } } },
  ])('$name', async ({ event, from, after }) => {
    const rig = await stage([issue], [from])
    expect(await rig.transition(IMPL, event)).toEqual({ kind: 'applied' })
    expect(rig.ticket(52)).toMatchObject({ rev: 1, ...after })
  })

  it('a review hand-back writes the pull request itself', async () => {
    const rig = await stage([pr(52)], [at('review', running, { pr: { number: 52, approvedAt: null } })])
    expect(await rig.transition(REVIEW, { kind: 'outcome', outcome: 'completed', handback: { token: 'approved', arg: null }, plan: null })).toEqual({ kind: 'applied' })
    expect(rig.ticket(52, 'pull-request')?.rev).toBe(1)
  })

  it('a refresh hand-back names the refresh stage and its argument', async () => {
    const rig = await stage([pr(52)], [at('refresh', running, { pr: { number: 52, approvedAt: NOW } })])
    const record = { number: 52, kind: 'pull-request', agent: 'revise', trigger: 'refreshBranch' } as const
    expect(await rig.transition(record, { kind: 'outcome', outcome: 'completed', handback: { token: 'refreshed', arg: 'clean' }, plan: null })).toEqual({ kind: 'applied' })
    expect(rig.ticket(52, 'pull-request')?.rev).toBe(1)
  })
})
