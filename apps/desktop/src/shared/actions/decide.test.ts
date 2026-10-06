import { describe, expect, it } from 'vitest'
import type { RepoId } from '../repos'
import type { PullRequestCommentNode } from '../github/types'
import type { ReconciledItem, StageLabel } from '../state/types'
import { decisionPlan, decisionsFor, escalationOf, reviseNoteProblem } from './decide'

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: 'pull-request',
    number: 300,
    title: 'a pull request',
    url: 'https://github.com/o/a/pull/300',
    assignees: ['op'],
    stage: 'gate',
    stages: [],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'gated',
    statusEvidence: null,
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: [],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    reviews: null,
    comments: null,
    reviewCycleCount: 0,
    checkRollup: null,
    ...overrides,
  }
}

function stageLabel(key: StageLabel['key'], role: StageLabel['role']): StageLabel {
  return { key, name: key, role }
}

describe('decisionsFor — unblock', () => {
  it('is available on a pull request whose only role-bearing label is needsHuman', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 })
    expect(result.unblock).toEqual({ available: true, context: { reason: null, cyclesUsed: 0, cap: 5 } })
  })

  it('carries the newest escalation reason', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Pipeline Escalation\nolder reason', createdAt: '2026-01-01T00:00:00Z' },
      { body: '## Pipeline Escalation\nnewer reason', createdAt: '2026-01-02T00:00:00Z' },
    ]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 })
    expect(result.unblock).toEqual({ available: true, context: { reason: 'newer reason', cyclesUsed: 0, cap: 5 } })
  })

  it('refuses rebase-decisions when the escalation carries open D<n> blocks', () => {
    const comments: readonly PullRequestCommentNode[] = [{ body: '## Pipeline Escalation\n2 conflicts\n### D1 — `a.ts`\n### D2 — `b.ts`', createdAt: '2026-01-01T00:00:00Z' }]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 }).unblock).toEqual({ available: false, reason: 'rebase-decisions' })
  })

  it('raises the cap by one grant comment', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 })
    expect(result.unblock).toEqual({ available: true, context: { reason: null, cyclesUsed: 0, cap: 6 } })
  })

  it('is not-applicable on an issue, or with a second role-bearing label present', () => {
    const issue = item({ kind: 'issue', stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionsFor({ item: issue, viewer: 'op', reviewCycleCap: 5 }).unblock).toEqual({ available: false, reason: 'not-applicable' })

    const second = item({ stages: [stageLabel('needsHuman', 'gate'), stageLabel('refreshing', 'in-flight')] })
    expect(decisionsFor({ item: second, viewer: 'op', reviewCycleCap: 5 }).unblock).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — revise', () => {
  it('is available on an approved pull request with a headRefOid', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 2 })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 }).revise).toEqual({
      available: true,
      context: { headRefOid: 'a'.repeat(40), cyclesUsed: 2, cap: 5 },
    })
  })

  it('refuses cycle-cap once cyclesUsed reaches the cap', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 5 })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 }).revise).toEqual({ available: false, reason: 'cycle-cap' })
  })

  it('is not-applicable with a null headRefOid', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], headRefOid: null })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 }).revise).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — ownership', () => {
  it('refuses viewer-unknown for both decisions', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    const result = decisionsFor({ item: it1, viewer: null, reviewCycleCap: 5 })
    expect(result.unblock).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.revise).toEqual({ available: false, reason: 'viewer-unknown' })
  })

  it('refuses not-owned for an unassigned item — unlike actionsFor, there is no unassigned exception', () => {
    const it1 = item({ assignees: [], stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 }).unblock).toEqual({ available: false, reason: 'not-owned' })
  })

  it('refuses not-owned when assigned to someone else', () => {
    const it1 = item({ assignees: ['other'], stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5 }).unblock).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('escalationOf', () => {
  it('returns null reason and zero rebaseDecisions with no comments', () => {
    expect(escalationOf(null)).toEqual({ reason: null, rebaseDecisions: 0 })
  })

  it('counts D<n> blocks in the newest escalation only', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Pipeline Escalation\nreason\n### D1 — `a.ts`', createdAt: '2026-01-01T00:00:00Z' },
      { body: '## Pipeline Escalation\nnewer reason', createdAt: '2026-01-02T00:00:00Z' },
    ]
    expect(escalationOf(comments)).toEqual({ reason: 'newer reason', rebaseDecisions: 0 })
  })
})

describe('reviseNoteProblem', () => {
  const sha = 'a'.repeat(40)

  it('reports empty before too-long or only-sha', () => {
    expect(reviseNoteProblem('', sha)).toBe('empty')
    expect(reviseNoteProblem('   \n  ', sha)).toBe('empty')
  })

  it('reports too-long past the character ceiling', () => {
    expect(reviseNoteProblem('x'.repeat(10_001), sha)).toBe('too-long')
  })

  it('reports only-sha when every non-empty line names the SHA', () => {
    expect(reviseNoteProblem(sha, sha)).toBe('only-sha')
  })

  it('returns null for a genuine request', () => {
    expect(reviseNoteProblem('rename the --limit flag to --max', sha)).toBeNull()
  })
})

describe('decisionPlan', () => {
  it('unblock to revision', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionPlan('unblock', it1, 'revision', 'op')).toEqual({
      add: ['needsRevision'],
      remove: ['needsHuman'],
      expect: { present: ['needsHuman'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
      action: 'unblock',
    })
  })

  it('unblock to review', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionPlan('unblock', it1, 'review', 'op').add).toEqual(['readyForReview'])
  })

  it('revise', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')] })
    expect(decisionPlan('revise', it1, null, 'op')).toEqual({
      add: ['needsRevision'],
      remove: ['approved'],
      expect: { present: ['approved'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
      action: 'revise',
    })
  })
})
