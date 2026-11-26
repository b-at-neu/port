// The cycle-cap/zero-diff and mergeability gate coverage.
import { describe, expect, it } from 'vitest'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import { createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import { reconciledItem as item, repositoryState } from '../../../../support/board-snapshot'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const NEXT_DECISION_AT = new Date('2026-01-01T01:01:00.000Z')

function readyRepo(items: readonly ReconciledItem[], overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return repositoryState(items, overrides, NOW.toISOString())
}

function plan(repository: Extract<RepositoryState, { ok: true }>, extra: { readonly unknownStreaks?: ReturnType<typeof createUnknownStreaks>; readonly checkDispositions?: Parameters<typeof planTick>[0]['checkDispositions'] } = {}) {
  return planTick({ repository, unknownStreaks: extra.unknownStreaks ?? createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: extra.checkDispositions ?? {}, holdSessionRequired: true })
}

const reviewsOf = (count: number, sha = 'sha1') => Array.from({ length: count }, (_, i) => ({ body: `## Code Review — Cycle ${String(i + 1)}`, submittedAt: '2026-01-01T00:00:00Z', commitOid: sha }))
const GRANT = { body: '## Gate cleared\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' }

const reviseItem = (overrides: Partial<ReconciledItem> = {}): ReconciledItem =>
  item({ number: 204, kind: 'pull-request', stages: [{ key: 'needsRevision', name: 'needs revision', role: 'trigger' }], headRefOid: 'sha1', reviews: [], comments: [], reviewCycleCount: 0, ...overrides })

const reviewItem = (overrides: Partial<ReconciledItem> = {}): ReconciledItem =>
  item({ number: 157, kind: 'pull-request', stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }], headRefOid: 'sha1', mergeable: 'MERGEABLE', reviews: [], comments: [], reviewCycleCount: 0, ...overrides })

const REVISE = { number: 204, kind: 'pull-request', stage: 'revise', trigger: 'needsRevision' } as const
const REVIEW = { number: 157, kind: 'pull-request', stage: 'review', trigger: 'readyForReview' } as const
const dispatchReview = (count: number) => ({ ...REVIEW, agent: 'review', unchecked: false, cycle: { count, cap: 5 } })
const held = (base: typeof REVISE | typeof REVIEW, reason: string, escalation: unknown = null) => ({ ...base, reason, contention: null, escalation })

describe('planTick — cycle-cap and zero-diff gates (#108)', () => {
  it('a revise candidate below the cap is actionable, carrying its cycle count', () => {
    const report = plan(readyRepo([reviseItem({ reviews: reviewsOf(1), reviewCycleCount: 1 })]))
    expect(report.actionable).toEqual([{ ...REVISE, agent: 'revise', unchecked: false, cycle: { count: 1, cap: 5 } }])
    expect(report.held).toEqual([])
  })

  it('a revise candidate at or above the cap is held, cycle-cap, unconditionally', () => {
    const report = plan(readyRepo([reviseItem({ reviews: reviewsOf(5), reviewCycleCount: 5 })]))
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([held(REVISE, 'cycle-cap', { kind: 'cycle-cap', count: 5, cap: 5 })])
  })

  it('the cap reads the item\'s review count, so a stored high-water mark holds a revise that GitHub\'s reviews alone would not', () => {
    const report = plan(readyRepo([reviseItem({ reviews: reviewsOf(1), reviewCycleCount: 5 })]))
    expect(report.actionable).toEqual([])
    expect(report.held).toMatchObject([{ number: 204, reason: 'cycle-cap', escalation: { kind: 'cycle-cap', count: 5, cap: 5 } }])
  })

  it('a revise candidate at cap with one grant comment dispatches, cap folded into cycle', () => {
    const report = plan(readyRepo([reviseItem({ reviews: reviewsOf(5), comments: [GRANT], reviewCycleCount: 5 })]))
    expect(report.actionable).toEqual([{ ...REVISE, agent: 'revise', unchecked: false, cycle: { count: 5, cap: 6 } }])
    expect(report.held).toEqual([])
  })

  it('a revise candidate at cap+1 with one grant is held, cycle-cap, with cap: 6', () => {
    const report = plan(readyRepo([reviseItem({ reviews: reviewsOf(6), comments: [GRANT], reviewCycleCount: 6 })]))
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([held(REVISE, 'cycle-cap', { kind: 'cycle-cap', count: 6, cap: 6 })])
  })

  it('a lone refreshBranch PR at the cap is actionable, never held on the cycle cap', () => {
    const report = plan(readyRepo([reviseItem({ stages: [{ key: 'refreshBranch', name: 'refresh branch', role: 'trigger' }], reviewCycleCount: 5 })]))
    expect(report.actionable).toEqual([{ number: 204, kind: 'pull-request', stage: 'refresh', trigger: 'refreshBranch', agent: 'revise', unchecked: false, cycle: null }])
    expect(report.held).toEqual([])
  })

  it('a review candidate with no prior Code Review dispatches, cycle count 0', () => {
    const report = plan(readyRepo([reviewItem()]))
    expect(report.actionable).toEqual([dispatchReview(0)])
    expect(report.held).toEqual([])
  })

  it('a review candidate whose newest review needs revision on the unchanged head gets one more review, never an escalation', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }]
    const report = plan(readyRepo([reviewItem({ reviews, reviewCycleCount: 1 })]))
    expect(report.held).toEqual([])
    expect(report.actionable).toEqual([dispatchReview(1)])
    expect(report.observations).toEqual([])
  })

  it('two reviews on one head still escalate as sha-cap, because that is a decision for a person', () => {
    const reviews = [
      { body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' },
      { body: '## Code Review — Cycle 2 · needs revision', submittedAt: '2026-01-01T00:30:00Z', commitOid: 'sha1' },
    ]
    const report = plan(readyRepo([reviewItem({ reviews, reviewCycleCount: 2 })]))
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([held(REVIEW, 'zero-diff', { kind: 'zero-diff' })])
  })

  it('a review candidate whose head already has an approving review adopts it: no hold, no second review', () => {
    const reviews = [{ body: '## Code Review — Cycle 2 · approved', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }]
    const report = plan(readyRepo([reviewItem({ reviews, reviewCycleCount: 2 })]))
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([])
    expect(report.observations).toEqual([{ kind: 'adopt', number: 157, itemKind: 'pull-request', agent: 'review', stage: 'review', trigger: 'readyForReview', handback: { token: 'approved', arg: null }, evidence: 'held-verdict' }])
  })

  it('an approving review on an older head is not adopted for the new head', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · approved', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'old-sha' }]
    const report = plan(readyRepo([reviewItem({ headRefOid: 'new-sha', reviews, reviewCycleCount: 1 })]))
    expect(report.observations).toEqual([])
    expect(report.actionable).toHaveLength(1)
  })

  it('a review candidate whose head moved since the review dispatches again', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'old-sha' }]
    const report = plan(readyRepo([reviewItem({ headRefOid: 'new-sha', reviews, reviewCycleCount: 1 })]))
    expect(report.actionable).toEqual([dispatchReview(1)])
    expect(report.held).toEqual([])
  })

  it('a review candidate with a Gate cleared comment newer than the review dispatches once more', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }]
    const comments = [{ body: '## Gate cleared', createdAt: '2026-01-02T00:00:00Z' }]
    const report = plan(readyRepo([reviewItem({ reviews, comments, reviewCycleCount: 1 })]))
    expect(report.actionable).toEqual([dispatchReview(1)])
    expect(report.held).toEqual([])
  })

  it('a non-revise/review actionable item never carries a cycle count', () => {
    expect(plan(readyRepo([item()])).actionable[0]?.cycle).toBeNull()
  })
})

describe('planTick — mergeability gate (#265)', () => {
  it('CONFLICTING holds as conflicting, no write, never reaching the zero-diff gate', () => {
    const report = plan(readyRepo([reviewItem({ mergeable: 'CONFLICTING' })]))
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([held(REVIEW, 'conflicting')])
  })

  it('UNKNOWN holds the first poll, then dispatches the second consecutive poll', () => {
    const repo = readyRepo([reviewItem({ mergeable: 'UNKNOWN' })])
    const unknownStreaks = createUnknownStreaks()
    expect(plan(repo, { unknownStreaks }).held).toEqual([held(REVIEW, 'mergeability-unknown')])

    const second = plan(repo, { unknownStreaks })
    expect(second.held).toEqual([])
    expect(second.actionable).toEqual([dispatchReview(0)])
  })

  it('null holds every poll — fail closed on action, never guessed', () => {
    const repo = readyRepo([reviewItem({ mergeable: null })])
    const unknownStreaks = createUnknownStreaks()
    expect(plan(repo, { unknownStreaks }).held).toEqual([held(REVIEW, 'mergeability-unknown')])
    expect(plan(repo, { unknownStreaks }).held).toEqual([held(REVIEW, 'mergeability-unknown')])
  })

  it('the streak memo clears once an item reads MERGEABLE again, so a later UNKNOWN holds afresh', () => {
    const unknownStreaks = createUnknownStreaks()
    const unknownRepo = readyRepo([reviewItem({ mergeable: 'UNKNOWN' })])
    plan(unknownRepo, { unknownStreaks })
    plan(readyRepo([reviewItem({ mergeable: 'MERGEABLE' })]), { unknownStreaks })
    expect(plan(unknownRepo, { unknownStreaks }).held).toEqual([held(REVIEW, 'mergeability-unknown')])
  })
})

describe('planTick — approval withdrawal and CLAUDE.md-excused checks (#300)', () => {
  const approvedItem = (): ReconciledItem =>
    item({
      number: 81,
      kind: 'pull-request',
      stages: [{ key: 'approved', name: 'approved', role: 'terminal' }],
      headRefOid: 'sha1',
      mergeable: 'MERGEABLE',
      checkRollup: [{ __typename: 'CheckRun', name: 'deploy-preview', conclusion: 'FAILURE', status: 'COMPLETED', state: null, startedAt: '2026-01-01T00:00:00Z', completedAt: null, createdAt: null, url: null }],
    })

  it('a red check excused by a CLAUDE.md override (source: CLAUDE.md) never withdraws approval', () => {
    const report = plan(readyRepo([approvedItem()]), { checkDispositions: { 'deploy-preview': { disposition: 'infrastructure', source: 'CLAUDE.md' } } })
    expect(report.observations.some((o) => o.kind === 'withdraw-approval')).toBe(false)
  })

  it('the same check under blocking (no excusal) still withdraws approval', () => {
    expect(plan(readyRepo([approvedItem()])).observations.some((o) => o.kind === 'withdraw-approval')).toBe(true)
  })
})
