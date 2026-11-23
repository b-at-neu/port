import { describe, expect, it, vi } from 'vitest'
import { applyStageClaim, applyStageTransition } from '@/main/actions/stage'
import type { StageWriteDeps } from '@/main/actions/stage'
import type { ReadyEntry } from '@/types/actions'
import type { ResolvedItem } from '@/types/github'
import type { StageEvent, StagePlanFile } from '@/types/stage-labels'
import type { PostCommentParams, WriteOutcome, WriteStateParams } from '@/types/writes'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import { item as reconciled } from '../incidents/fixtures'

const VOCABULARY = resolveVocabulary({})

function entry(modules: { approvalGate: boolean } = { approvalGate: true }): ReadyEntry {
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
      modules: { ...modules, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: VOCABULARY,
    },
    diagnostics: [],
  }
}

function issue(labels: readonly string[], number = 52): ResolvedItem {
  return { number, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels, assignees: ['op'], headRefName: null, author: null }
}

function pr(number: number, overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return { number, kind: 'pull-request', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: ['op'], headRefName: '52-add-thing', author: 'op', ...overrides }
}

/** `stored` is the store's labels for every item; `null` reads each item's own labels, and `'unseeded'` is a repository the store does not hold yet. */
function deps(items: readonly ResolvedItem[], outcomes: readonly WriteOutcome[] = [], stored: readonly string[] | 'unseeded' | null = null, bodyOutcomes: readonly WriteOutcome[] = []) {
  const queue = [...outcomes]
  const applied: WriteStateParams[] = []
  const writeState = vi.fn((params: WriteStateParams): Promise<WriteOutcome> => {
    applied.push(params)
    return Promise.resolve(queue.shift() ?? { kind: 'applied', argv: [] })
  })
  const fetchItemsByNumber = vi.fn((params: { readonly numbers: readonly number[] }) => {
    const wanted = new Set(params.numbers)
    return Promise.resolve({ ok: true as const, resolved: items.filter((i) => wanted.has(i.number)), unavailable: params.numbers.filter((n) => !items.some((i) => i.number === n)), fetchedAt: 'r' })
  })
  const stateLabels = vi.fn((_repoId: unknown, _kind: unknown, number: number): readonly string[] | null => (stored === 'unseeded' ? null : (stored ?? items.find((item) => item.number === number)?.labels ?? [])))
  const bodies: PostCommentParams[] = []
  const bodyQueue = [...bodyOutcomes]
  const postIssueBody = vi.fn((params: PostCommentParams): Promise<WriteOutcome> => {
    bodies.push(params)
    return Promise.resolve(bodyQueue.shift() ?? { kind: 'applied', argv: [] })
  })
  const writeDeps: StageWriteDeps = { writeState, postIssueBody, stateLabels, fetchItemsByNumber }
  return { writeDeps, applied, bodies, writeState, postIssueBody, fetchItemsByNumber, stateLabels }
}

const IMPL = { number: 52, kind: 'issue', agent: 'impl', trigger: 'planApproved' } as const
const PR_OPENED: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null }

describe('applyStageClaim', () => {
  it('writes once, from the re-read item, with the exact precondition', async () => {
    const rig = deps([issue(['claude', 'plan approved'])])
    const result = await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue(['claude', 'plan approved']), auditDir: '/audit' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'applied' })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
    expect(rig.applied).toHaveLength(1)
    const [call] = rig.applied
    expect(call?.auditDir).toBe('/audit')
    expect(call?.repoRoot).toBe('/repo')
    expect(call?.request).toMatchObject({ kind: 'issue', number: 52, add: ['inProgress'], remove: ['planApproved'], action: 'stage-claim', repo: 'o/a' })
    expect(call?.request.expect.present).toEqual(['planApproved'])
    expect(call?.request.expect.absent).toEqual([])
    expect(call?.request.expect.assignees).toEqual({ kind: 'exactly', logins: ['op'] })
  })

  it('is moved, with no write, when a second role-bearing label is present', async () => {
    const rig = deps([issue(['plan approved', 'blocked'])])
    const result = await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue(['plan approved', 'blocked']), auditDir: '/audit' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'refused', reason: 'moved', retryable: false, detail: null })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('maps a failed precondition at the chokepoint to moved, never retryable', async () => {
    const outcome: WriteOutcome = { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: 'r' } }
    const rig = deps([issue(['plan approved'])], [outcome])
    const result = await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue(['plan approved']), auditDir: '/audit' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'refused', reason: 'moved', retryable: false, detail: null })
  })

  it('refuses retryably, with no write, while the repository is unseeded', async () => {
    const rig = deps([issue(['plan approved'])], [], 'unseeded')
    const result = await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue(['plan approved']), auditDir: '/audit' }, rig.writeDeps)
    expect(result).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(rig.writeState).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — refusals map from the write outcome', () => {
  const event: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan: { kind: 'read', body: '## Implementation Plan' } }
  const record = { number: 52, kind: 'issue', agent: 'plan', trigger: 'ready' } as const
  const planning = issue(['planning'])

  it.each<[WriteOutcome, string, boolean]>([
    [{ kind: 'unresolvable-label', keys: ['planReview'] }, 'unresolvable-label', false],
    [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }, 'write-failed', true],
    [{ kind: 'verify-failed', message: 'no net' }, 'write-failed', true],
    [{ kind: 'ownership-unreadable', path: 'p', message: 'bad' }, 'write-failed', true],
    [{ kind: 'item-unavailable' }, 'write-failed', true],
    [{ kind: 'state-unsaved', message: 'disk full' }, 'write-failed', true],
  ])('%j → %s (retryable: %s)', async (outcome, reason, retryable) => {
    const rig = deps([planning], [outcome])
    const result = await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ kind: 'refused', reason, retryable })
  })

  it('treats no-op as applied', async () => {
    const rig = deps([planning], [{ kind: 'no-op' }])
    expect(await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toEqual({ kind: 'applied' })
  })

  it('treats a failed label mirror as applied, since the state moved', async () => {
    const rig = deps([planning], [{ kind: 'mirror-failed', mirror: { kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null } }])
    expect(await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toEqual({ kind: 'applied' })
  })

  it('observes the stage from the store, not from the labels GitHub returned', async () => {
    const rig = deps([planning], [], ['claude', 'plan review'])
    const result = await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'refused', reason: 'moved', retryable: false, detail: null })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('claims a ticket whose labels were removed on GitHub when the store still holds its stage', async () => {
    const rig = deps([], [], ['claude', 'plan approved'])
    const result = await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue([]), auditDir: '/audit' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'applied' })
    expect(rig.applied[0]?.request.expect.present).toEqual(['planApproved'])
  })

  it('an unreadable item is a retryable write-failed with no write', async () => {
    const rig = deps([])
    const result = await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('a failed read is a retryable write-failed with the message', async () => {
    const rig = deps([planning])
    rig.fetchItemsByNumber.mockResolvedValueOnce({ ok: false as never, kind: 'network' as never, message: 'offline', fetchedAt: 'r' } as never)
    const result = await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'refused', reason: 'write-failed', retryable: true, detail: 'offline' })
  })

  it('refuses a missing hand-back before reading anything', async () => {
    const rig = deps([planning])
    const result = await applyStageTransition({ entry: entry(), record, event: { kind: 'outcome', outcome: 'completed', handback: null, plan: null }, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ kind: 'refused', reason: 'no-handback', retryable: false })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
  })

  it('refuses an unknown token before reading anything', async () => {
    const rig = deps([planning])
    const result = await applyStageTransition({ entry: entry(), record, event: { kind: 'outcome', outcome: 'completed', handback: { token: 'done', arg: null }, plan: null }, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ kind: 'refused', reason: 'unknown-handback' })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
  })

  it('writes nothing for an outcome the table leaves to Resume', async () => {
    const rig = deps([planning])
    const result = await applyStageTransition({ entry: entry(), record, event: { kind: 'outcome', outcome: 'interrupted', handback: null, plan: null }, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'applied' })
    expect(rig.writeState).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — incidents', () => {
  const blocked: StageEvent = { kind: 'outcome', outcome: 'blocked', handback: null, plan: null }
  const inProgress = issue(['in progress'])
  const snapshotItem = reconciled({ kind: 'issue', number: 52, closingPullRequests: [{ number: 80, state: 'OPEN', headRefName: '52-add-thing' }] })

  it('attaches an existing-work incident, with the open pull request as its subject, to a blocked impl hand-back', async () => {
    const rig = deps([inProgress])
    await applyStageTransition({ entry: entry(), record: IMPL, event: blocked, auditDir: '/audit', scratchDir: '/scratch', snapshot: { item: snapshotItem, at: 'tick-1' } }, rig.writeDeps)
    expect(rig.applied[0]?.request.incident).toMatchObject({ bucket: 'existing-work', stage: 'blocked', condition: 'pr-open', subject: { kind: 'pull-request', number: 80 } })
  })

  it('attaches an escalation incident when the ticket has no open pull request of its own', async () => {
    const rig = deps([inProgress])
    await applyStageTransition({ entry: entry(), record: IMPL, event: blocked, auditDir: '/audit', scratchDir: '/scratch', snapshot: { item: null, at: null } }, rig.writeDeps)
    expect(rig.applied[0]?.request.incident).toMatchObject({ bucket: 'escalation', stage: 'blocked', condition: 'stage-blocked' })
  })

  it('attaches nothing without a snapshot, and nothing for a write that adds neither gate', async () => {
    const withoutSnapshot = deps([inProgress])
    await applyStageTransition({ entry: entry(), record: IMPL, event: blocked, auditDir: '/audit', scratchDir: '/scratch' }, withoutSnapshot.writeDeps)
    expect(withoutSnapshot.applied[0]?.request.incident).toBeUndefined()

    const claim = deps([issue(['plan approved'])])
    await applyStageClaim({ entry: entry(), candidate: IMPL, resolved: issue(['plan approved']), auditDir: '/audit' }, claim.writeDeps)
    expect(claim.applied[0]?.request.incident).toBeUndefined()
  })
})

describe('applyStageTransition — plan-written body', () => {
  const record = { number: 52, kind: 'issue', agent: 'plan', trigger: 'ready' } as const
  const planWritten = (plan: StagePlanFile | null): StageEvent => ({ kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan })
  const read = planWritten({ kind: 'read', body: '## Implementation Plan' })
  const params = (event: StageEvent) => ({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' })

  it('posts the body, then swaps the labels', async () => {
    const order: string[] = []
    const rig = deps([issue(['planning'])])
    rig.postIssueBody.mockImplementationOnce(() => {
      order.push('body')
      return Promise.resolve({ kind: 'applied', argv: [] })
    })
    rig.writeState.mockImplementationOnce(() => {
      order.push('labels')
      return Promise.resolve({ kind: 'applied', argv: [] })
    })
    expect(await applyStageTransition(params(read), rig.writeDeps)).toEqual({ kind: 'applied' })
    expect(order).toEqual(['body', 'labels'])
    expect(rig.postIssueBody.mock.calls[0]?.[0]).toMatchObject({ request: { repo: 'o/a', kind: 'issue', number: 52, body: '## Implementation Plan', action: 'stage-handback-plan-body', scratchDir: '/scratch' }, repoRoot: '/repo', auditDir: '/audit' })
  })

  it('posts nothing when the ticket moved while the session ran', async () => {
    const rig = deps([issue(['plan review'])])
    expect(await applyStageTransition(params(read), rig.writeDeps)).toMatchObject({ kind: 'refused', reason: 'moved', retryable: false })
    expect(rig.postIssueBody).not.toHaveBeenCalled()
  })

  it.each<[StagePlanFile | null, string, string | null]>([
    [null, 'no-plan-file', null],
    [{ kind: 'missing', detail: 'EACCES: denied' }, 'no-plan-file', 'EACCES: denied'],
    [{ kind: 'empty' }, 'empty-plan-file', null],
  ])('refuses %j before any read or write', async (plan, reason, detail) => {
    const rig = deps([issue(['planning'])])
    expect(await applyStageTransition(params(planWritten(plan)), rig.writeDeps)).toEqual({ kind: 'refused', reason, retryable: false, detail })
    expect(rig.fetchItemsByNumber).not.toHaveBeenCalled()
    expect(rig.postIssueBody).not.toHaveBeenCalled()
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('a failed body post is retryable and makes no label write', async () => {
    const rig = deps([issue(['planning'])], [], null, [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }])
    expect(await applyStageTransition(params(read), rig.writeDeps)).toEqual({ kind: 'refused', reason: 'write-failed', retryable: true, detail: 'boom' })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('an unseeded repository posts no body and writes no label', async () => {
    const rig = deps([issue(['planning'])], [], 'unseeded')
    expect(await applyStageTransition(params(read), rig.writeDeps)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(rig.postIssueBody).not.toHaveBeenCalled()
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('a failed label write after an applied post re-posts the same body on retry', async () => {
    const rig = deps([issue(['planning'])], [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }])
    expect(await applyStageTransition(params(read), rig.writeDeps)).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(await applyStageTransition(params(read), rig.writeDeps)).toEqual({ kind: 'applied' })
    expect(rig.bodies.map((b) => b.request.body)).toEqual(['## Implementation Plan', '## Implementation Plan'])
  })

  it('posts no body for any other hand-back', async () => {
    const rig = deps([pr(8), issue(['in progress'])])
    await applyStageTransition({ entry: entry(), record: IMPL, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(rig.postIssueBody).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — pr-opened', () => {
  const record = IMPL
  const inProgress = issue(['in progress'])

  it('writes the pull request before the issue, each with its own exact precondition', async () => {
    const rig = deps([inProgress, pr(8)])
    const result = await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'applied' })
    expect(rig.applied.map((c) => [c.request.kind, c.request.number])).toEqual([
      ['pull-request', 8],
      ['issue', 52],
    ])
    expect(rig.applied[0]?.request).toMatchObject({ add: ['readyForReview', 'marker'], remove: [] })
    expect(rig.applied[0]?.request.expect.present).toEqual([])
    expect(rig.applied[1]?.request).toMatchObject({ add: ['prOpened'], remove: ['inProgress'] })
    expect(rig.applied[1]?.request.expect.present).toEqual(['inProgress'])
  })

  it('adds no marker when the approval gate is off', async () => {
    const rig = deps([inProgress, pr(8)])
    await applyStageTransition({ entry: entry({ approvalGate: false }), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(rig.applied[0]?.request.add).toEqual(['readyForReview'])
  })

  it('rejects a closed pull request with no write on either item', async () => {
    const rig = deps([inProgress, pr(8, { state: 'CLOSED' })])
    const result = await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'refused', reason: 'pr-unverified', retryable: false, detail: null })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('rejects a pull request on another issue’s branch', async () => {
    const rig = deps([inProgress, pr(8, { headRefName: '53-other-thing' })])
    const result = await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ reason: 'pr-unverified' })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('does not match a branch that only starts with the same digits', async () => {
    const rig = deps([inProgress, pr(8, { headRefName: '520-other-thing' })])
    expect(await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toMatchObject({ reason: 'pr-unverified' })
  })

  it('rejects an issue named as the pull request', async () => {
    const rig = deps([inProgress, issue([], 8)])
    expect(await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toMatchObject({ reason: 'pr-unverified' })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('rejects a pull request that does not exist', async () => {
    const rig = deps([inProgress])
    expect(await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toMatchObject({ reason: 'pr-unverified' })
  })

  it('a failed pull request write skips the issue write', async () => {
    const rig = deps([inProgress, pr(8)], [{ kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }])
    const result = await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ kind: 'refused', reason: 'write-failed', retryable: true })
    expect(rig.applied).toHaveLength(1)
    expect(rig.applied[0]?.request.number).toBe(8)
  })

  it('a refused issue write reports after the pull request write landed', async () => {
    const stale: WriteOutcome = { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: 'r' } }
    const rig = deps([inProgress, pr(8)], [{ kind: 'applied', argv: [] }, stale])
    const result = await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ reason: 'moved', retryable: false })
    expect(rig.applied).toHaveLength(2)
  })

  it('is moved, with no write, when the issue no longer carries the in-flight label alone', async () => {
    const rig = deps([issue(['in progress', 'blocked']), pr(8)])
    const result = await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toMatchObject({ reason: 'moved' })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('accepts a blocked issue', async () => {
    const rig = deps([issue(['blocked']), pr(8)])
    expect(await applyStageTransition({ entry: entry(), record, event: PR_OPENED, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toEqual({ kind: 'applied' })
    expect(rig.applied[1]?.request.remove).toEqual(['blocked'])
  })
})

describe('applyStageTransition — adopt', () => {
  const ADOPT: StageEvent = { kind: 'adopt', handback: { token: 'pr-opened', arg: '#8' } }
  const params = { entry: entry(), record: IMPL, event: ADOPT, auditDir: '/audit', scratchDir: '/scratch' }

  it('verifies the pull request like a hand-back and writes it before the issue', async () => {
    const rig = deps([issue(['plan approved']), pr(8)])
    expect(await applyStageTransition(params, rig.writeDeps)).toEqual({ kind: 'applied' })
    expect(rig.applied.map((c) => [c.request.kind, c.request.number, c.request.action])).toEqual([
      ['pull-request', 8, 'stage-adopt-pr-opened'],
      ['issue', 52, 'stage-adopt-pr-opened'],
    ])
    expect(rig.applied[1]?.request).toMatchObject({ add: ['prOpened'], remove: ['planApproved'] })
  })

  it('refuses pr-unverified, with no write, when the pull request is not open on the issue’s own branch', async () => {
    const rig = deps([issue(['plan approved']), pr(8, { headRefName: '53-other-thing' })])
    expect(await applyStageTransition(params, rig.writeDeps)).toMatchObject({ kind: 'refused', reason: 'pr-unverified', retryable: false })
    expect(rig.writeState).not.toHaveBeenCalled()
  })

  it('is moved, with no write, when the issue left plan approved since it was observed', async () => {
    const rig = deps([issue(['in progress', 'blocked']), pr(8)])
    expect(await applyStageTransition(params, rig.writeDeps)).toMatchObject({ reason: 'moved' })
    expect(rig.writeState).not.toHaveBeenCalled()
  })
})

describe('applyStageTransition — other events', () => {
  it('a rollback re-reads the item and restores the trigger', async () => {
    const rig = deps([issue(['in progress'])])
    const result = await applyStageTransition({ entry: entry(), record: IMPL, event: { kind: 'rollback' }, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    expect(result).toEqual({ kind: 'applied' })
    expect(rig.fetchItemsByNumber).toHaveBeenCalledTimes(1)
    expect(rig.applied[0]?.request).toMatchObject({ add: ['planApproved'], remove: ['inProgress'], action: 'stage-rollback' })
  })

  it('a review hand-back writes the pull request itself', async () => {
    const rig = deps([pr(52, { labels: ['reviewing'] })])
    const record = { number: 52, kind: 'pull-request', agent: 'review', trigger: 'readyForReview' } as const
    const event: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token: 'approved', arg: null }, plan: null }
    expect(await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)).toEqual({ kind: 'applied' })
    expect(rig.applied[0]?.request).toMatchObject({ kind: 'pull-request', number: 52, add: ['approved'], remove: ['reviewing'] })
  })

  it('a refresh hand-back keeps approved in the precondition', async () => {
    const rig = deps([pr(52, { labels: ['refreshing', 'approved'] })])
    const record = { number: 52, kind: 'pull-request', agent: 'revise', trigger: 'refreshBranch' } as const
    const event: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token: 'refreshed', arg: 'clean' }, plan: null }
    await applyStageTransition({ entry: entry(), record, event, auditDir: '/audit', scratchDir: '/scratch' }, rig.writeDeps)
    const present = rig.applied[0]?.request.expect.present ?? []
    expect(present).toHaveLength(2)
    expect(present).toEqual(expect.arrayContaining(['refreshing', 'approved']))
    expect(rig.applied[0]?.request).toMatchObject({ add: [], remove: ['refreshing'] })
  })
})
