import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { GatePreflightFetch } from '../../shared/github/types'
import type { LabelWriteRequest, OwnershipSummary, WriteOutcome } from '../../shared/writes/types'
import type { OwnershipRead } from '../dispatch/ownership'
import type { ReposListResponse } from '../../shared/ipc'
import { autoApprovePlan, gateAnswer, gatePreflight } from './gate'
import type { GateDeps } from './gate'
import type { RegistryDeps } from '../registry'

const REPO_ID = 'repo-1' as unknown as RepoId
const VOCABULARY: LabelVocabulary = resolveVocabulary({})
const NOW = () => new Date('2026-01-01T00:00:00.000Z')

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by gate.ts')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: VOCABULARY,
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

const ABSENT_OWNERSHIP: OwnershipRead = { kind: 'absent', path: '/repo/.agents/cockpit.json', readAt: '2026-01-01T00:00:00.000Z' }
const ABSENT_OWNERSHIP_SUMMARY: OwnershipSummary = { kind: 'absent' }

function depsWith(overrides: Partial<GateDeps>): GateDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] } as ReposListResponse),
    fetchGatePreflight: () => {
      throw new Error('fetchGatePreflight should not be invoked in this case')
    },
    readOwnership: () => Promise.resolve(ABSENT_OWNERSHIP),
    applyLabels: () => {
      throw new Error('applyLabels should not be invoked in this case')
    },
    postComment: () => {
      throw new Error('postComment should not be invoked in this case')
    },
    now: NOW,
    ...overrides,
  }
}

function preflightFetch(overrides: Partial<Extract<GatePreflightFetch, { ok: true }>> = {}): Extract<GatePreflightFetch, { ok: true }> {
  return {
    ok: true,
    viewer: 'alice',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    item: {
      kind: 'issue',
      number: 148,
      title: 'E3 · Plan review gate',
      url: 'u',
      state: 'OPEN',
      body: 'Ticket body.\n\n## Implementation Plan\n\nPlan text.',
      labels: ['plan review'],
      assignees: [],
    },
    ...overrides,
  }
}

describe('gatePreflight', () => {
  it('rejects a repository that is not ready', async () => {
    const notReady = { id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [notReady] }) })
    await expect(gatePreflight({ registryDeps, repoId: REPO_ID, number: 148 }, deps)).rejects.toThrow("gate requires a 'ready' repository, got 'directory-missing'")
  })

  it('carries ownership on a fetch failure', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve({ ok: false, kind: 'network', message: 'dial tcp', fetchedAt: 't' }) })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 148 }, deps)
    expect(result).toEqual({ kind: 'failed', message: 'dial tcp', ownership: ABSENT_OWNERSHIP_SUMMARY })
  })

  it('reports unresolved for a number that does not exist, carrying ownership', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve(preflightFetch({ item: null })) })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 999999 }, deps)
    expect(result).toEqual({ kind: 'unresolved', ownership: ABSENT_OWNERSHIP_SUMMARY })
  })

  it('resolves an answerable item, splitting ticket and plan markdown at the heading, and summarizes ownership', async () => {
    const deps = depsWith({
      fetchGatePreflight: () => Promise.resolve(preflightFetch()),
      readOwnership: () => Promise.resolve({ kind: 'app', since: '2026-01-01T00:00:00.000Z', path: 'p', readAt: 'r' }),
    })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 148 }, deps)
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.ticketMarkdown).toBe('Ticket body.')
    expect(result.preflight.planMarkdown).toBe('## Implementation Plan\n\nPlan text.')
    expect(result.preflight.sessionRequired).toBe(false)
    expect(result.verdict).toEqual({ kind: 'answerable', noPlanBlock: false, assignedElsewhere: [] })
    expect(result.ownership).toEqual({ kind: 'app', since: '2026-01-01T00:00:00.000Z' })
  })

  it('reports noPlanBlock when the body carries no Implementation Plan heading', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve(preflightFetch({ item: { ...preflightFetch().item!, body: 'Just a ticket body.' } })) })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 148 }, deps)
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.planMarkdown).toBeNull()
    expect(result.verdict).toEqual({ kind: 'answerable', noPlanBlock: true, assignedElsewhere: [] })
  })
})

describe('gateAnswer', () => {
  it('refuses without any write when the fresh verdict is no longer answerable', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve(preflightFetch({ item: { ...preflightFetch().item!, labels: ['plan approved'] } })) })
    const result = await gateAnswer(
      { registryDeps, repoId: REPO_ID, number: 148, decision: 'approve', feedback: null, skipComment: false, auditDir: '/audit', scratchDir: '/scratch' },
      deps,
    )
    expect(result).toEqual({ kind: 'refused', verdict: { kind: 'not-at-plan-review', observed: ['plan approved'] } })
  })

  it('surfaces an unreachable preflight as preflight-failed, without writing', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve({ ok: false, kind: 'unauthenticated', message: 'gh: 401', fetchedAt: 't' }) })
    const result = await gateAnswer(
      { registryDeps, repoId: REPO_ID, number: 148, decision: 'approve', feedback: null, skipComment: false, auditDir: '/audit', scratchDir: '/scratch' },
      deps,
    )
    expect(result).toEqual({ kind: 'preflight-failed', message: 'gh: 401' })
  })

  it('approve: never posts a comment, applies planApproved/planReview', async () => {
    let received: LabelWriteRequest | undefined
    const outcome: WriteOutcome = { kind: 'applied', argv: ['issue', 'edit', '148'] }
    const deps = depsWith({
      fetchGatePreflight: () => Promise.resolve(preflightFetch()),
      applyLabels: (p) => {
        received = p.request
        return Promise.resolve(outcome)
      },
    })
    const result = await gateAnswer(
      { registryDeps, repoId: REPO_ID, number: 148, decision: 'approve', feedback: null, skipComment: false, auditDir: '/audit', scratchDir: '/scratch' },
      deps,
    )
    expect(result).toEqual({ kind: 'answered', comment: null, labels: outcome })
    expect(received?.add).toEqual(['planApproved'])
    expect(received?.remove).toEqual(['planReview'])
    expect(received?.action).toBe('approve-plan')
  })

  it('request-changes: posts the comment before the label swap, in that order', async () => {
    const order: string[] = []
    const commentOutcome: WriteOutcome = { kind: 'applied', argv: ['issue', 'comment', '148'] }
    const labelOutcome: WriteOutcome = { kind: 'applied', argv: ['issue', 'edit', '148'] }
    const deps = depsWith({
      fetchGatePreflight: () => Promise.resolve(preflightFetch()),
      postComment: (p) => {
        order.push('comment')
        expect(p.request.body).toBe('please rework the risks section')
        expect(p.request.action).toBe('request-plan-changes')
        return Promise.resolve(commentOutcome)
      },
      applyLabels: () => {
        order.push('labels')
        return Promise.resolve(labelOutcome)
      },
    })
    const result = await gateAnswer(
      {
        registryDeps,
        repoId: REPO_ID,
        number: 148,
        decision: 'request-changes',
        feedback: 'please rework the risks section',
        skipComment: false,
        auditDir: '/audit',
        scratchDir: '/scratch',
      },
      deps,
    )
    expect(order).toEqual(['comment', 'labels'])
    expect(result).toEqual({ kind: 'answered', comment: commentOutcome, labels: labelOutcome })
  })

  it('aborts as comment-failed before touching any label when the comment does not land', async () => {
    const commentOutcome: WriteOutcome = { kind: 'write-failed', classification: 'network', stderr: 'boom', reread: null }
    let labelsCalled = false
    const deps = depsWith({
      fetchGatePreflight: () => Promise.resolve(preflightFetch()),
      postComment: () => Promise.resolve(commentOutcome),
      applyLabels: () => {
        labelsCalled = true
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
    })
    const result = await gateAnswer(
      { registryDeps, repoId: REPO_ID, number: 148, decision: 'request-changes', feedback: 'x', skipComment: false, auditDir: '/audit', scratchDir: '/scratch' },
      deps,
    )
    expect(result).toEqual({ kind: 'comment-failed', comment: commentOutcome })
    expect(labelsCalled).toBe(false)
  })

  it('skipComment suppresses the comment and nothing else — only the label swap retries', async () => {
    let commentCalled = false
    const labelOutcome: WriteOutcome = { kind: 'applied', argv: [] }
    const deps = depsWith({
      fetchGatePreflight: () => Promise.resolve(preflightFetch()),
      postComment: () => {
        commentCalled = true
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      applyLabels: () => Promise.resolve(labelOutcome),
    })
    const result = await gateAnswer(
      { registryDeps, repoId: REPO_ID, number: 148, decision: 'request-changes', feedback: 'x', skipComment: true, auditDir: '/audit', scratchDir: '/scratch' },
      deps,
    )
    expect(commentCalled).toBe(false)
    expect(result).toEqual({ kind: 'answered', comment: null, labels: labelOutcome })
  })
})

describe('autoApprovePlan', () => {
  it('writes planApproved/planReview with the auto-approve-plan action, posting no comment', async () => {
    let received: LabelWriteRequest | undefined
    const outcome: WriteOutcome = { kind: 'applied', argv: ['issue', 'edit', '148'] }
    const deps = depsWith({
      applyLabels: (p) => {
        received = p.request
        return Promise.resolve(outcome)
      },
    })
    const result = await autoApprovePlan({ entry: READY_ENTRY, item: { number: 148, assignees: ['alice'] }, auditDir: '/audit' }, deps)
    expect(result).toEqual(outcome)
    expect(received?.add).toEqual(['planApproved'])
    expect(received?.remove).toEqual(['planReview'])
    expect(received?.action).toBe('auto-approve-plan')
    expect(received?.expect).toEqual({
      present: ['planReview', 'autoPlan'],
      absent: VOCABULARY.labels.filter((l) => l.role !== 'marker' && l.key !== 'planReview').map((l) => l.key),
      assignees: { kind: 'exactly', logins: ['alice'] },
    })
  })
})
