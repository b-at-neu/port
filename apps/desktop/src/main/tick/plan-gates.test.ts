// Split out of plan.test.ts to keep that file under the file-size limit: the cycle-cap/zero-diff
// and refresh-wins/mergeability gate coverage, which shares no state with the rest of that file.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { ReconciledItem, RepositoryState } from '../../shared/state/types'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from './ledger'
import { planTick } from './plan'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const NEXT_DECISION_AT = new Date('2026-01-01T01:01:00.000Z')
const REPO = 'repo-a' as RepoId
const NO_CHECK_DISPOSITIONS = {}

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO,
    repo: 'o/a',
    kind: 'issue',
    number: 1,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/1',
    assignees: ['op'],
    stage: 'trigger',
    stages: [{ key: 'ready', name: 'ready', role: 'trigger' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'waiting',
    statusEvidence: null,
    waitingOn: 'cockpit',
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: ['ready'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    ...overrides,
  }
}

function readyRepo(items: readonly ReconciledItem[], overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: REPO,
    repo: 'o/a',
    displayName: 'o/a',
    items,
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z' },
    freshness: {
      github: { at: NOW.toISOString() },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
    ...overrides,
  }
}

describe('planTick — cycle-cap and zero-diff gates (#108)', () => {
  function reviseItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 204,
      kind: 'pull-request',
      stages: [{ key: 'needsRevision', name: 'needs revision', role: 'trigger' }],
      headRefOid: 'sha1',
      reviews: [],
      comments: [],
      reviewCycleCount: 0,
      ...overrides,
    })
  }

  function reviewItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 157,
      kind: 'pull-request',
      stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }],
      headRefOid: 'sha1',
      mergeable: 'MERGEABLE',
      reviews: [],
      comments: [],
      reviewCycleCount: 0,
      ...overrides,
    })
  }

  it('a revise candidate below the cap is actionable, carrying its cycle count', () => {
    const reviews = [{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }]
    const repo = readyRepo([reviseItem({ reviews, reviewCycleCount: 1 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 204, kind: 'pull-request', trigger: 'needsRevision', agent: 'revise', unchecked: false, cycle: { count: 1, cap: 5 } }])
    expect(report.held).toEqual([])
  })

  it('a revise candidate at or above the cap is held, cycle-cap, unconditionally', () => {
    const reviews = Array.from({ length: 5 }, (_, i) => ({ body: `## Code Review — Cycle ${String(i + 1)}`, submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }))
    const repo = readyRepo([reviseItem({ reviews, reviewCycleCount: 5 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([
      { number: 204, kind: 'pull-request', trigger: 'needsRevision', reason: 'cycle-cap', contention: null, escalation: { kind: 'cycle-cap', count: 5, cap: 5 } },
    ])
  })

  it('a revise candidate at cap with one grant comment dispatches, cap folded into cycle', () => {
    const reviews = Array.from({ length: 5 }, (_, i) => ({ body: `## Code Review — Cycle ${String(i + 1)}`, submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }))
    const comments = [{ body: '## Gate cleared\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' }]
    const repo = readyRepo([reviseItem({ reviews, comments, reviewCycleCount: 5 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 204, kind: 'pull-request', trigger: 'needsRevision', agent: 'revise', unchecked: false, cycle: { count: 5, cap: 6 } }])
    expect(report.held).toEqual([])
  })

  it('a revise candidate at cap+1 with one grant is held, cycle-cap, with cap: 6', () => {
    const reviews = Array.from({ length: 6 }, (_, i) => ({ body: `## Code Review — Cycle ${String(i + 1)}`, submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }))
    const comments = [{ body: '## Gate cleared\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' }]
    const repo = readyRepo([reviseItem({ reviews, comments, reviewCycleCount: 6 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([
      { number: 204, kind: 'pull-request', trigger: 'needsRevision', reason: 'cycle-cap', contention: null, escalation: { kind: 'cycle-cap', count: 6, cap: 6 } },
    ])
  })

  it('a review candidate with no prior Code Review dispatches, cycle null (no reviews yet)', () => {
    const repo = readyRepo([reviewItem()])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', agent: 'review', unchecked: false, cycle: { count: 0, cap: 5 } }])
    expect(report.held).toEqual([])
  })

  it('a review candidate whose newest review already covers the current head is held, zero-diff', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }]
    const repo = readyRepo([reviewItem({ headRefOid: 'sha1', reviews, reviewCycleCount: 1 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'zero-diff', contention: null, escalation: { kind: 'zero-diff' } }])
  })

  it('a review candidate whose head moved since the review dispatches again', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'old-sha' }]
    const repo = readyRepo([reviewItem({ headRefOid: 'new-sha', reviews, reviewCycleCount: 1 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', agent: 'review', unchecked: false, cycle: { count: 1, cap: 5 } }])
    expect(report.held).toEqual([])
  })

  it('a review candidate with a Gate cleared comment newer than the review dispatches once more', () => {
    const reviews = [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' }]
    const comments = [{ body: '## Gate cleared', createdAt: '2026-01-02T00:00:00Z' }]
    const repo = readyRepo([reviewItem({ headRefOid: 'sha1', reviews, comments, reviewCycleCount: 1 })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', agent: 'review', unchecked: false, cycle: { count: 1, cap: 5 } }])
    expect(report.held).toEqual([])
  })

  it('a non-revise/review actionable item never carries a cycle count', () => {
    const repo = readyRepo([item()])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable[0]?.cycle).toBeNull()
  })
})

describe('planTick — refresh-wins veto and mergeability gate (#265)', () => {
  function reviewItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 157,
      kind: 'pull-request',
      stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }],
      headRefOid: 'sha1',
      mergeable: 'MERGEABLE',
      reviews: [],
      comments: [],
      reviewCycleCount: 0,
      ...overrides,
    })
  }

  function reviseItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 204,
      kind: 'pull-request',
      stages: [{ key: 'needsRevision', name: 'needs revision', role: 'trigger' }],
      headRefOid: 'sha1',
      reviews: [],
      comments: [],
      reviewCycleCount: 0,
      ...overrides,
    })
  }

  it('a readyForReview item that also carries refreshBranch is vetoed, never dispatched to review — the refresh itself still dispatches (#292)', () => {
    const repo = readyRepo([reviewItem({ stages: [...reviewItem().stages, { key: 'refreshBranch', name: 'refresh branch', role: 'trigger' }] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 157, kind: 'pull-request', trigger: 'refreshBranch', agent: 'revise', unchecked: false, cycle: null }])
    expect(report.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'refresh-wins', contention: null, escalation: null }])
  })

  it('a needsRevision item that also carries refreshBranch is vetoed, never dispatched to revise — the refresh itself still dispatches (#292)', () => {
    // Both are trigger-role, so this stays in triggerItems. needsRevision listed first so
    // stageKeyOf resolves to it, matching the realistic case the veto exists for.
    const repo = readyRepo([reviseItem({ stages: [...reviseItem().stages, { key: 'refreshBranch', name: 'refresh branch', role: 'trigger' }] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([{ number: 204, kind: 'pull-request', trigger: 'refreshBranch', agent: 'revise', unchecked: false, cycle: null }])
    expect(report.held).toEqual([{ number: 204, kind: 'pull-request', trigger: 'needsRevision', reason: 'refresh-wins', contention: null, escalation: null }])
  })

  it('a refreshBranch trigger is never vetoed against its own label', () => {
    const repo = readyRepo([item({ number: 9, kind: 'pull-request', stages: [{ key: 'refreshBranch', name: 'refresh branch', role: 'trigger' }] })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.held).toEqual([])
    expect(report.actionable).toEqual([{ number: 9, kind: 'pull-request', trigger: 'refreshBranch', agent: 'revise', unchecked: false, cycle: null }])
  })

  it('CONFLICTING holds as conflicting, no write, never reaching the zero-diff gate', () => {
    const repo = readyRepo([reviewItem({ mergeable: 'CONFLICTING' })])
    const report = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks: createUnknownStreaks(), nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'conflicting', contention: null, escalation: null }])
  })

  it('UNKNOWN holds the first poll, then dispatches the second consecutive poll', () => {
    const repo = readyRepo([reviewItem({ mergeable: 'UNKNOWN' })])
    const unknownStreaks = createUnknownStreaks()
    const first = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(first.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'mergeability-unknown', contention: null, escalation: null }])

    const second = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(second.held).toEqual([])
    expect(second.actionable).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', agent: 'review', unchecked: false, cycle: { count: 0, cap: 5 } }])
  })

  it('null holds every poll — fail closed on action, never guessed', () => {
    const repo = readyRepo([reviewItem({ mergeable: null })])
    const unknownStreaks = createUnknownStreaks()
    const first = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    const second = planTick({ repository: repo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(first.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'mergeability-unknown', contention: null, escalation: null }])
    expect(second.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'mergeability-unknown', contention: null, escalation: null }])
  })

  it('the streak memo clears once an item reads MERGEABLE again, so a later UNKNOWN holds afresh', () => {
    const unknownStreaks = createUnknownStreaks()
    const unknownRepo = readyRepo([reviewItem({ mergeable: 'UNKNOWN' })])
    planTick({ repository: unknownRepo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true }) // streak -> 1

    const mergeableRepo = readyRepo([reviewItem({ mergeable: 'MERGEABLE' })])
    planTick({ repository: mergeableRepo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true }) // clears

    const again = planTick({ repository: unknownRepo, ledger: createDispatchLedger(), unknownStreaks, nextDecisionAt: NEXT_DECISION_AT, now: () => NOW, reviewCycleCap: 5, startedTasks: [], refreshMemo: createRefreshMemo(), checkDispositions: NO_CHECK_DISPOSITIONS, holdSessionRequired: true })
    expect(again.held).toEqual([{ number: 157, kind: 'pull-request', trigger: 'readyForReview', reason: 'mergeability-unknown', contention: null, escalation: null }])
  })
})

describe('planTick — approval withdrawal and CLAUDE.md-excused checks (#300)', () => {
  function approvedItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({
      number: 81,
      kind: 'pull-request',
      stages: [{ key: 'approved', name: 'approved', role: 'terminal' }],
      headRefOid: 'sha1',
      mergeable: 'MERGEABLE',
      checkRollup: [
        { __typename: 'CheckRun', name: 'deploy-preview', conclusion: 'FAILURE', status: 'COMPLETED', state: null, startedAt: '2026-01-01T00:00:00Z', completedAt: null, createdAt: null, url: null },
      ],
      ...overrides,
    })
  }

  it('a red check excused by a CLAUDE.md override (source: CLAUDE.md) never withdraws approval', () => {
    const repo = readyRepo([approvedItem()])
    const report = planTick({
      repository: repo,
      ledger: createDispatchLedger(),
      unknownStreaks: createUnknownStreaks(),
      nextDecisionAt: NEXT_DECISION_AT,
      now: () => NOW,
      reviewCycleCap: 5,
      startedTasks: [],
      refreshMemo: createRefreshMemo(),
      checkDispositions: { 'deploy-preview': { disposition: 'infrastructure', source: 'CLAUDE.md' } },
      holdSessionRequired: true,
    })
    expect(report.observations.some((o) => o.kind === 'withdraw-approval')).toBe(false)
  })

  it('the same check under blocking (no excusal) still withdraws approval', () => {
    const repo = readyRepo([approvedItem()])
    const report = planTick({
      repository: repo,
      ledger: createDispatchLedger(),
      unknownStreaks: createUnknownStreaks(),
      nextDecisionAt: NEXT_DECISION_AT,
      now: () => NOW,
      reviewCycleCap: 5,
      startedTasks: [],
      refreshMemo: createRefreshMemo(),
      checkDispositions: NO_CHECK_DISPOSITIONS,
      holdSessionRequired: true,
    })
    expect(report.observations.some((o) => o.kind === 'withdraw-approval')).toBe(true)
  })
})
