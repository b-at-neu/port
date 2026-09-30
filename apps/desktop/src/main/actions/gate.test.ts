import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { GatePreflightFetch } from '../../shared/github/types'
import type { ClaimRead, LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import type { ReposListResponse } from '../../shared/ipc'
import { gateAnswer, gateClaimRead, gateClaimSet, gatePreflight } from './gate'
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
    commands: { worktrees: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
  },
  diagnostics: [],
}

const ABSENT_CLAIM: ClaimRead = { state: 'absent', path: '/repo/.agents/gate-claim.json', readAt: '2026-01-01T00:00:00.000Z' }

function depsWith(overrides: Partial<GateDeps>): GateDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] } as ReposListResponse),
    fetchGatePreflight: () => {
      throw new Error('fetchGatePreflight should not be invoked in this case')
    },
    readGateClaim: () => Promise.resolve(ABSENT_CLAIM),
    takeGateClaim: () => {
      throw new Error('takeGateClaim should not be invoked in this case')
    },
    releaseGateClaim: () => {
      throw new Error('releaseGateClaim should not be invoked in this case')
    },
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

  it('carries the claim on a fetch failure', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve({ ok: false, kind: 'network', message: 'dial tcp', fetchedAt: 't' }) })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 148 }, deps)
    expect(result).toEqual({ kind: 'failed', message: 'dial tcp', claim: ABSENT_CLAIM })
  })

  it('reports unresolved for a number that does not exist, carrying the claim', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve(preflightFetch({ item: null })) })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 999999 }, deps)
    expect(result).toEqual({ kind: 'unresolved', claim: ABSENT_CLAIM })
  })

  it('resolves an answerable item, splitting ticket and plan markdown at the heading', async () => {
    const deps = depsWith({ fetchGatePreflight: () => Promise.resolve(preflightFetch()) })
    const result = await gatePreflight({ registryDeps, repoId: REPO_ID, number: 148 }, deps)
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.preflight.ticketMarkdown).toBe('Ticket body.')
    expect(result.preflight.planMarkdown).toBe('## Implementation Plan\n\nPlan text.')
    expect(result.preflight.sessionRequired).toBe(false)
    expect(result.verdict).toEqual({ kind: 'answerable', noPlanBlock: false, assignedElsewhere: [] })
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

describe('gateClaimRead', () => {
  it('resolves the entry and reads the claim', async () => {
    let seenRepoRoot: string | undefined
    const deps = depsWith({
      readGateClaim: (p) => {
        seenRepoRoot = p.repoRoot
        return Promise.resolve(ABSENT_CLAIM)
      },
    })
    const result = await gateClaimRead({ registryDeps, repoId: REPO_ID }, deps)
    expect(result).toEqual(ABSENT_CLAIM)
    expect(seenRepoRoot).toBe('/repo')
  })
})

describe('gateClaimSet', () => {
  it('takes the claim and re-reads afterwards', async () => {
    let took = false
    const held: ClaimRead = { state: 'held', owner: 'port-desktop', scopes: ['plan-gate'], unknownScopes: [], claimedAt: '2026-01-01T00:00:00.000Z', path: 'p', readAt: 'r' }
    const deps = depsWith({
      takeGateClaim: (p) => {
        took = true
        expect(p.owner).toBe('port-desktop')
        expect(p.scopes).toEqual(['plan-gate'])
        return Promise.resolve({ ok: true, path: 'p' })
      },
      readGateClaim: () => Promise.resolve(held),
    })
    const result = await gateClaimSet({ registryDeps, repoId: REPO_ID, held: true }, deps)
    expect(took).toBe(true)
    expect(result).toEqual({ kind: 'ok', claim: held })
  })

  it('releases the claim and re-reads afterwards', async () => {
    const deps = depsWith({ releaseGateClaim: () => Promise.resolve({ ok: true, path: 'p' }), readGateClaim: () => Promise.resolve(ABSENT_CLAIM) })
    const result = await gateClaimSet({ registryDeps, repoId: REPO_ID, held: false }, deps)
    expect(result).toEqual({ kind: 'ok', claim: ABSENT_CLAIM })
  })

  it('reports failed without re-reading when the write itself fails', async () => {
    let reread = false
    const deps = depsWith({
      takeGateClaim: () => Promise.resolve({ ok: false, kind: 'permission-denied', message: 'nope', path: 'p' }),
      readGateClaim: () => {
        reread = true
        return Promise.resolve(ABSENT_CLAIM)
      },
    })
    const result = await gateClaimSet({ registryDeps, repoId: REPO_ID, held: true }, deps)
    expect(result).toEqual({ kind: 'failed', result: { ok: false, kind: 'permission-denied', message: 'nope', path: 'p' } })
    expect(reread).toBe(false)
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
