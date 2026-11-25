import { describe, expect, it, vi } from 'vitest'
import { applyStageClaim, applyStageTransition } from '@/main/pipeline/operator/stage'
import type { StageWriteDeps } from '@/main/pipeline/operator/stage'
import type { ReadyEntry } from '@/types/actions'
import type { ResolvedItem } from '@/types/github'
import type { StageEvent, StagePlanFile } from '@/types/stage-labels'
import type { PostCommentParams, WriteEventParams, WriteOutcome } from '@/types/writes'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { Stage, Status, Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { item as reconciled } from '../incidents/fixtures'
import { NOW, ticketOf } from '../../../support/tickets'

const VOCABULARY = resolveVocabulary({})
const APPLIED: WriteOutcome = { kind: 'applied', argv: [] }

function entry(): ReadyEntry {
  return {
    id: 'repo-a' as RepoId,
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
      sessionRequiredPaths: [],
      checkDispositions: {},
      overrides: [],
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: VOCABULARY,
    },
    diagnostics: [],
  }
}

function issue(number = 52): ResolvedItem {
  return { number, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: ['op'], headRefName: null, author: null }
}

function pr(number: number, overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return { number, kind: 'pull-request', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: ['op'], headRefName: '52-add-thing', author: 'op', ...overrides }
}

const queued: Status = { kind: 'queued', reason: 'new', since: NOW }
const running: Status = { kind: 'running', runId: null }
const at = (stage: Stage, status: Status, overrides: Partial<Ticket> = {}): Ticket => ticketOf({ ticket: 52, stage, status, ...overrides })

interface RigOptions {
  /** The store's tickets; none reads each item as untracked. */
  readonly tickets?: readonly Ticket[]
  readonly outcomes?: readonly WriteOutcome[]
  readonly bodyOutcomes?: readonly WriteOutcome[]
}

function deps(items: readonly ResolvedItem[], options: RigOptions = {}) {
  const queue = [...(options.outcomes ?? [])]
  const written: WriteEventParams[] = []
  const writeEvent = vi.fn((params: WriteEventParams): Promise<WriteOutcome> => {
    written.push(params)
    return Promise.resolve(queue.shift() ?? APPLIED)
  })
  const ticketOf = vi.fn((_repoId: RepoId, kind: string, number: number): Ticket | null => (options.tickets ?? []).find((t) => (kind === 'issue' ? t.ticket === number : t.pr?.number === number || t.ticket === number)) ?? null)
  const fetchItemsByNumber = vi.fn((params: { readonly numbers: readonly number[] }) => {
    const wanted = new Set(params.numbers)
    return Promise.resolve({ ok: true as const, resolved: items.filter((i) => wanted.has(i.number)), unavailable: params.numbers.filter((n) => !items.some((i) => i.number === n)), fetchedAt: 'r' })
  })
  const bodies: PostCommentParams[] = []
  const bodyQueue = [...(options.bodyOutcomes ?? [])]
  const postIssueBody = vi.fn((params: PostCommentParams): Promise<WriteOutcome> => {
    bodies.push(params)
    return Promise.resolve(bodyQueue.shift() ?? APPLIED)
  })
  const writeDeps: StageWriteDeps = { writeEvent, ticketOf, postIssueBody, fetchItemsByNumber }
  return { writeDeps, written, bodies, writeEvent, postIssueBody, fetchItemsByNumber }
}

const IMPL = { number: 52, kind: 'issue', agent: 'impl', trigger: 'planApproved' } as const
const PLAN = { number: 52, kind: 'issue', agent: 'plan', trigger: 'ready' } as const
const REVIEW = { number: 52, kind: 'pull-request', agent: 'review', trigger: 'readyForReview' } as const
const PR_OPENED: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null }
const planWritten = (plan: StagePlanFile | null): StageEvent => ({ kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan })
const transition = (record: Parameters<typeof applyStageTransition>[0]['record'], event: StageEvent, rig: ReturnType<typeof deps>, extra: { snapshot?: Parameters<typeof applyStageTransition>[0]['snapshot'] } = {}) =>
  applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch', ...extra }, rig.writeDeps)

describe('applyStageClaim', () => {
  it('writes one claim event on the rev it read, from the re-read item, with the assignees exactly', async () => {
    const rig = deps([], { tickets: [at('implement', queued, { rev: 4 })] })
    expect(await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue(), auditDir: '/audit' }, rig.writeDeps)).toEqual({ kind: 'applied' })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
    expect(rig.written).toHaveLength(1)
    expect(rig.written[0]).toMatchObject({ auditDir: '/audit', repoRoot: '/repo', request: { kind: 'issue', number: 52, event: { kind: 'claim', stage: 'implement' }, expectedRev: 4, action: 'stage-claim', repo: 'o/a', assignees: { kind: 'exactly', logins: ['op'] } } })
    expect(rig.written[0]?.request.incident).toBeUndefined()
  })

  it('claims a refresh as the refresh stage, and carries no rev for an untracked item', async () => {
    const rig = deps([])
    await applyStageClaim({ entry: entry(), candidate: { number: 52, kind: 'pull-request', agent: 'revise', trigger: 'refreshBranch' }, resolved: pr(52), auditDir: '/audit' }, rig.writeDeps)
    expect(rig.written[0]?.request).toMatchObject({ kind: 'pull-request', event: { kind: 'claim', stage: 'refresh' }, expectedRev: null })
  })
})

describe('applyStageTransition — refusals map from the write outcome', () => {
  const event = planWritten({ kind: 'read', body: '## Implementation Plan' })
  const planning = { tickets: [at('plan', running)] }

  it.each<[WriteOutcome, string, boolean]>([
    [{ kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: 'r' } }, 'moved', false],
    [{ kind: 'unresolvable-label', keys: ['planReview'] }, 'unresolvable-label', false],
    [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }, 'write-failed', true],
    [{ kind: 'verify-failed', message: 'no net' }, 'write-failed', true],
    [{ kind: 'ownership-unreadable', path: 'p', message: 'bad' }, 'write-failed', true],
    [{ kind: 'item-unavailable' }, 'write-failed', true],
    [{ kind: 'state-unsaved', message: 'disk full' }, 'write-failed', true],
  ])('%j → %s (retryable: %s)', async (outcome, reason, retryable) => {
    const rig = deps([issue()], { ...planning, outcomes: [outcome] })
    expect(await transition(PLAN, event, rig)).toMatchObject({ kind: 'refused', reason, retryable })
  })

  it.each([{ kind: 'no-op' }, { kind: 'mirror-failed', mirror: { kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null } }] as const)('treats %j as applied, since the state moved', async (outcome) => {
    const rig = deps([issue()], { ...planning, outcomes: [outcome] })
    expect(await transition(PLAN, event, rig)).toEqual({ kind: 'applied' })
  })

  it('an unreadable item is a retryable write-failed with no write', async () => {
    const rig = deps([], planning)
    expect(await transition(PLAN, event, rig)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(rig.writeEvent).not.toHaveBeenCalled()
  })

  it('a failed read is a retryable write-failed with the message', async () => {
    const rig = deps([issue()], planning)
    rig.fetchItemsByNumber.mockResolvedValueOnce({ ok: false as never, kind: 'network' as never, message: 'offline', fetchedAt: 'r' } as never)
    expect(await transition(PLAN, event, rig)).toEqual({ kind: 'refused', reason: 'write-failed', retryable: true, detail: 'offline' })
  })

  it.each([
    ['a missing hand-back', { kind: 'outcome', outcome: 'completed', handback: null, plan: null }, 'no-handback'],
    ['an unknown token', { kind: 'outcome', outcome: 'completed', handback: { token: 'done', arg: null }, plan: null }, 'unknown-handback'],
  ] as const)('refuses %s before reading anything', async (_name, bad, reason) => {
    const rig = deps([issue()], planning)
    expect(await transition(PLAN, bad, rig)).toMatchObject({ kind: 'refused', reason, retryable: false })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
  })

  it('writes nothing for an outcome the table leaves to Resume', async () => {
    const rig = deps([issue()], planning)
    expect(await transition(PLAN, { kind: 'outcome', outcome: 'interrupted', handback: null, plan: null }, rig)).toEqual({ kind: 'applied' })
    expect(rig.writeEvent).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — incidents', () => {
  const blocked: StageEvent = { kind: 'outcome', outcome: 'blocked', handback: null, plan: null }
  const inProgress = { tickets: [at('implement', running)] }
  const snapshotItem = reconciled({ kind: 'issue', number: 52, closingPullRequests: [{ number: 80, state: 'OPEN', headRefName: '52-add-thing' }] })

  it('attaches an existing-work incident, with the open pull request as its subject, to a blocked impl hand-back', async () => {
    const rig = deps([issue()], inProgress)
    await transition(IMPL, blocked, rig, { snapshot: { item: snapshotItem, at: 'tick-1' } })
    expect(rig.written[0]?.request).toMatchObject({ event: { kind: 'blocked' }, action: 'stage-blocked', incident: { bucket: 'existing-work', stage: 'blocked', condition: 'pr-open', subject: { kind: 'pull-request', number: 80 } } })
  })

  it('attaches an escalation incident when the ticket has no open pull request of its own', async () => {
    const rig = deps([issue()], inProgress)
    await transition(IMPL, blocked, rig, { snapshot: { item: null, at: null } })
    expect(rig.written[0]?.request.incident).toMatchObject({ bucket: 'escalation', stage: 'blocked', condition: 'stage-blocked' })
  })

  it('attaches one to an escalated hand-back as needsHuman', async () => {
    const rig = deps([pr(52)], { tickets: [at('review', running, { pr: { number: 52, approvedAt: null } })] })
    await transition(REVIEW, { kind: 'outcome', outcome: 'completed', handback: { token: 'checks-pending', arg: null }, plan: null }, rig, { snapshot: { item: null, at: null } })
    expect(rig.written[0]?.request.incident).toMatchObject({ bucket: 'escalation', stage: 'needsHuman' })
  })

  it('attaches nothing without a snapshot, and nothing for a hand-back that lands on no human', async () => {
    const withoutSnapshot = deps([issue()], inProgress)
    await transition(IMPL, blocked, withoutSnapshot)
    expect(withoutSnapshot.written[0]?.request.incident).toBeUndefined()

    const planned = deps([issue()], { tickets: [at('plan', running)] })
    await transition(PLAN, planWritten({ kind: 'read', body: 'b' }), planned, { snapshot: { item: null, at: null } })
    expect(planned.written[0]?.request.incident).toBeUndefined()
  })
})

describe('applyStageTransition — plan-written body', () => {
  const read = planWritten({ kind: 'read', body: '## Implementation Plan' })
  const planning = { tickets: [at('plan', running)] }

  it('posts the body, then writes the event', async () => {
    const order: string[] = []
    const rig = deps([issue()], planning)
    rig.postIssueBody.mockImplementationOnce(() => {
      order.push('body')
      return Promise.resolve(APPLIED)
    })
    rig.writeEvent.mockImplementationOnce(() => {
      order.push('event')
      return Promise.resolve(APPLIED)
    })
    expect(await transition(PLAN, read, rig)).toEqual({ kind: 'applied' })
    expect(order).toEqual(['body', 'event'])
    expect(rig.postIssueBody.mock.calls[0]?.[0]).toMatchObject({ request: { repo: 'o/a', kind: 'issue', number: 52, body: '## Implementation Plan', action: 'stage-handback-plan-body', scratchDir: '/scratch' }, repoRoot: '/repo', auditDir: '/audit' })
    expect(rig.writeEvent.mock.calls[0]?.[0].request).toMatchObject({ event: { kind: 'handback', stage: 'plan', token: 'plan-written' }, action: 'stage-handback-plan-written' })
  })

  it('posts nothing when the ticket moved while the session ran, or is not tracked', async () => {
    const moved = deps([issue()], { tickets: [at('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' })] })
    await transition(PLAN, read, moved)
    expect(moved.postIssueBody).not.toHaveBeenCalled()
    const untracked = deps([issue()])
    await transition(PLAN, read, untracked)
    expect(untracked.postIssueBody).not.toHaveBeenCalled()
  })

  it.each<[StagePlanFile | null, string, string | null]>([
    [null, 'no-plan-file', null],
    [{ kind: 'missing', detail: 'EACCES: denied' }, 'no-plan-file', 'EACCES: denied'],
    [{ kind: 'empty' }, 'empty-plan-file', null],
  ])('refuses %j before any read or write', async (plan, reason, detail) => {
    const rig = deps([issue()], planning)
    expect(await transition(PLAN, planWritten(plan), rig)).toEqual({ kind: 'refused', reason, retryable: false, detail })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
    expect(rig.postIssueBody).not.toHaveBeenCalled()
    expect(rig.writeEvent).not.toHaveBeenCalled()
  })

  it('a failed body post is retryable and writes no event', async () => {
    const rig = deps([issue()], { ...planning, bodyOutcomes: [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }] })
    expect(await transition(PLAN, read, rig)).toEqual({ kind: 'refused', reason: 'write-failed', retryable: true, detail: 'boom' })
    expect(rig.writeEvent).not.toHaveBeenCalled()
  })

  it('a failed event after an applied post re-posts the same body on retry', async () => {
    const rig = deps([issue()], { ...planning, outcomes: [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }] })
    expect(await transition(PLAN, read, rig)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(await transition(PLAN, read, rig)).toEqual({ kind: 'applied' })
    expect(rig.bodies.map((b) => b.request.body)).toEqual(['## Implementation Plan', '## Implementation Plan'])
  })

  it('posts no body for any other hand-back', async () => {
    const rig = deps([pr(8), issue()], { tickets: [at('implement', running)] })
    await transition(IMPL, PR_OPENED, rig)
    expect(rig.postIssueBody).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — pr-opened', () => {
  const inProgress = { tickets: [at('implement', running, { rev: 2 })] }

  it('writes one event on the issue, carrying the pull request, on the rev it read', async () => {
    const rig = deps([issue(), pr(8)], inProgress)
    expect(await transition(IMPL, PR_OPENED, rig)).toEqual({ kind: 'applied' })
    expect(rig.written).toHaveLength(1)
    expect(rig.written[0]?.request).toMatchObject({ kind: 'issue', number: 52, event: { kind: 'handback', stage: 'implement', token: 'pr-opened', pr: 8, via: 'session' }, expectedRev: 2, action: 'stage-handback-pr-opened' })
  })

  it.each([
    ['a closed pull request', [issue(), pr(8, { state: 'CLOSED' })]],
    ['a pull request on another issue’s branch', [issue(), pr(8, { headRefName: '53-other-thing' })]],
    ['a branch that only starts with the same digits', [issue(), pr(8, { headRefName: '520-other-thing' })]],
    ['an issue named as the pull request', [issue(), issue(8)]],
    ['a pull request that does not exist', [issue()]],
  ])('rejects %s with no write', async (_name, items) => {
    const rig = deps(items, inProgress)
    expect(await transition(IMPL, PR_OPENED, rig)).toEqual({ kind: 'refused', reason: 'pr-unverified', retryable: false, detail: null })
    expect(rig.writeEvent).not.toHaveBeenCalled()
  })

  it('a failed write is a retryable refusal, and a stale one is moved', async () => {
    const failed = deps([issue(), pr(8)], { ...inProgress, outcomes: [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }] })
    expect(await transition(IMPL, PR_OPENED, failed)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    const stale = deps([issue(), pr(8)], { ...inProgress, outcomes: [{ kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: 'r' } }] })
    expect(await transition(IMPL, PR_OPENED, stale)).toMatchObject({ reason: 'moved', retryable: false })
  })

  it('adopts the same way, under its own action', async () => {
    const rig = deps([issue(), pr(8)], { tickets: [at('implement', queued)] })
    expect(await transition(IMPL, { kind: 'adopt', handback: { token: 'pr-opened', arg: '#8' } }, rig)).toEqual({ kind: 'applied' })
    expect(rig.written[0]?.request).toMatchObject({ event: { via: 'adopt', pr: 8 }, action: 'stage-adopt-pr-opened' })
  })

  it('refuses an adoption of a pull request that is not open on the issue’s own branch', async () => {
    const rig = deps([issue(), pr(8, { headRefName: '53-other-thing' })], inProgress)
    expect(await transition(IMPL, { kind: 'adopt', handback: { token: 'pr-opened', arg: '#8' } }, rig)).toMatchObject({ reason: 'pr-unverified' })
    expect(rig.writeEvent).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — other events', () => {
  it('a rollback re-reads the item and writes a rollback event', async () => {
    const rig = deps([issue()], { tickets: [at('implement', running)] })
    expect(await transition(IMPL, { kind: 'rollback' }, rig)).toEqual({ kind: 'applied' })
    expect(rig.fetchItemsByNumber).toHaveBeenCalledTimes(1)
    expect(rig.written[0]?.request).toMatchObject({ event: { kind: 'rollback', stage: 'implement' }, action: 'stage-rollback' })
  })

  it('an error outcome resets under its own action, and the next turn unblocks', async () => {
    const reset = deps([issue()], { tickets: [at('implement', running)] })
    await transition(IMPL, { kind: 'outcome', outcome: 'error', handback: null, plan: null }, reset)
    expect(reset.written[0]?.request).toMatchObject({ event: { kind: 'error-reset' }, action: 'stage-error-reset' })
    const next = deps([issue()], { tickets: [at('implement', { kind: 'blocked', on: [], reason: '' })] })
    await transition(IMPL, { kind: 'resumed-turn' }, next)
    expect(next.written[0]?.request).toMatchObject({ event: { kind: 'resumed-turn' }, action: 'stage-unblocked' })
  })

  it('a review hand-back writes the pull request itself', async () => {
    const rig = deps([pr(52)], { tickets: [at('review', running, { pr: { number: 52, approvedAt: null } })] })
    expect(await transition(REVIEW, { kind: 'outcome', outcome: 'completed', handback: { token: 'approved', arg: null }, plan: null }, rig)).toEqual({ kind: 'applied' })
    expect(rig.written[0]?.request).toMatchObject({ kind: 'pull-request', number: 52, event: { stage: 'review', token: 'approved' } })
  })

  it('a refresh hand-back names the refresh stage and its argument', async () => {
    const rig = deps([pr(52)], { tickets: [at('refresh', running, { pr: { number: 52, approvedAt: NOW } })] })
    await transition({ number: 52, kind: 'pull-request', agent: 'revise', trigger: 'refreshBranch' }, { kind: 'outcome', outcome: 'completed', handback: { token: 'refreshed', arg: 'clean' }, plan: null }, rig)
    expect(rig.written[0]?.request).toMatchObject({ event: { stage: 'refresh', token: 'refreshed', arg: 'clean' }, action: 'stage-handback-refreshed-clean' })
  })
})
