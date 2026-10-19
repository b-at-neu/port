import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem, RepositoryState, StageLabel } from '@/types/state'
import type { ItemsByNumberFetch, ResolvedItem } from '@/types/github'
import type { AuditEntry, LabelAuditEntry, WriteOutcome } from '@/types/writes'
import { isLabelAuditEntry } from '@/types/writes'
import { readAuditLog } from '@/main/writes/audit'
import type { GhRunner, GitRunner } from '@/types/platform'
import { applyItemDecision, defaultApplyItemDecisionDeps } from '@/main/actions/decide'
import type { ApplyItemDecisionDeps } from '@/main/actions/decide'
import { boardSnapshot as snapshotOf, readyEntry, reconciledItem, repositoryState } from '../../../fixtures/board-state'

const REPO_ID = 'repo-1' as unknown as RepoId
const NOW = () => new Date('2026-01-01T00:00:00.000Z')

function stageLabel(key: StageLabel['key'], role: StageLabel['role']): StageLabel {
  return { key, name: key, role }
}

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({
    repoId: REPO_ID,
    kind: 'pull-request',
    number: 300,
    title: 'a pull request',
    url: 'https://github.com/o/a/pull/300',
    stage: 'gate',
    stages: [stageLabel('needsHuman', 'gate')],
    status: 'gated',
    waitingOn: null,
    matchedKeys: ['needsHuman'],
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    reviewCycleCount: 0,
    ...overrides,
  })
}

function repoState(items: readonly ReconciledItem[], overrides: Partial<Extract<RepositoryState, { readonly ok: true }>> = {}): Extract<RepositoryState, { readonly ok: true }> {
  return repositoryState(items, { repoId: REPO_ID, ...overrides })
}

function entry(overrides: Partial<Parameters<typeof readyEntry>[0]> = {}): ReturnType<typeof readyEntry> {
  return readyEntry({ id: REPO_ID, ...overrides })
}

function resolvedItem(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return { number: 300, kind: 'pull-request', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['needs human'], assignees: ['op'], ...overrides }
}

function fetchReturning(fetch: ItemsByNumberFetch): ApplyItemDecisionDeps['fetchItemsByNumber'] {
  return () => Promise.resolve(fetch)
}

function depsWith(overrides: Partial<ApplyItemDecisionDeps>): ApplyItemDecisionDeps {
  return {
    applyLabels: () => {
      throw new Error('applyLabels should not be invoked in this case')
    },
    postComment: () => {
      throw new Error('postComment should not be invoked in this case')
    },
    fetchItemsByNumber: () => {
      throw new Error('fetchItemsByNumber should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('applyItemDecision — moved', () => {
  it('refuses moved when the item is gone from the snapshot', async () => {
    const snapshot = snapshotOf([repoState([])])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'moved', expected: 'needs human', observed: 'no longer tracked' })
  })

  it('refuses moved when the current stage disagrees with expectedStage', async () => {
    const snapshot = snapshotOf([repoState([item({ stages: [stageLabel('approved', 'terminal')], stage: 'terminal' })])])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'moved', expected: 'needs human', observed: 'approved' })
  })

  it('refuses moved when the fresh re-read disagrees, and posts no comment', async () => {
    const snapshot = snapshotOf([repoState([item()])])
    let commentCalls = 0
    const deps = depsWith({
      postComment: () => {
        commentCalls++
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem({ labels: ['needs revision'] })], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      deps,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('moved')
    expect(commentCalls).toBe(0)
  })
})

describe('applyItemDecision — refusals', () => {
  it('refuses not-owned', async () => {
    const snapshot = snapshotOf([repoState([item({ assignees: ['other'] })], { viewer: 'op' })])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'not-owned', owners: ['other'] })
  })

  it('refuses cycle-cap for revise at the cap', async () => {
    const snapshot = snapshotOf([repoState([item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 5 })], { reviewCycleCap: 5 })])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'revise', expectedStage: 'approved', route: null, note: 'change it', skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'cycle-cap' })
  })

  it('refuses note-invalid for an empty revise note, before any read or write', async () => {
    const snapshot = snapshotOf([repoState([item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')] })])])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'revise', expectedStage: 'approved', route: null, note: '  ', skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'note-invalid', problem: 'empty' })
  })
})

describe('applyItemDecision — comment then swap', () => {
  it('aborts comment-failed and never calls applyLabels', async () => {
    const snapshot = snapshotOf([repoState([item()])])
    let labelCalls = 0
    const deps = depsWith({
      postComment: () => Promise.resolve({ kind: 'write-failed', classification: 'unknown', stderr: 'boom', reread: null }),
      applyLabels: () => {
        labelCalls++
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      deps,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('comment-failed')
    expect(labelCalls).toBe(0)
  })

  it('skipComment skips the comment and goes straight to the swap', async () => {
    const snapshot = snapshotOf([repoState([item()])])
    let commentCalls = 0
    const deps = depsWith({
      postComment: () => {
        commentCalls++
        throw new Error('should not be called')
      },
      applyLabels: () => Promise.resolve({ kind: 'applied', argv: [] }),
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: true, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      deps,
    )
    expect(result).toEqual({ ok: true, comment: null, labels: { kind: 'applied', argv: [] } })
    expect(commentCalls).toBe(0)
  })

  it('posts the comment then swaps the labels on an ordinary unblock', async () => {
    const snapshot = snapshotOf([repoState([item()])])
    const calls: string[] = []
    const deps = depsWith({
      postComment: () => {
        calls.push('comment')
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      applyLabels: () => {
        calls.push('labels')
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      deps,
    )
    expect(result).toEqual({ ok: true, comment: { kind: 'applied', argv: [] }, labels: { kind: 'applied', argv: [] } })
    expect(calls).toEqual(['comment', 'labels'])
  })

  it('posts a Cycle grant block when clearing a cycle-cap escalation back to revision', async () => {
    const comments = [{ body: '## Pipeline Escalation\n5 review cycles reached the cap of 5 without merging.', createdAt: '2026-01-01T00:00:00Z' }]
    const snapshot = snapshotOf([repoState([item({ comments })])])
    let body = ''
    const deps = depsWith({
      postComment: (params) => {
        body = params.request.body
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      applyLabels: () => Promise.resolve({ kind: 'applied', argv: [] }),
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      deps,
    )
    expect(body).toContain('### Cycle grant')
  })

  it('posts no Cycle grant block when clearing a rebase escalation back to revision', async () => {
    const comments = [{ body: '## Pipeline Escalation\n1 conflicts — 0 resolved automatically, 1 need a decision', createdAt: '2026-01-01T00:00:00Z' }]
    const snapshot = snapshotOf([repoState([item({ comments })])])
    let body = ''
    const deps = depsWith({
      postComment: (params) => {
        body = params.request.body
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      applyLabels: () => Promise.resolve({ kind: 'applied', argv: [] }),
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false },
      deps,
    )
    expect(body).not.toContain('### Cycle grant')
  })
})

const TWO_DECISION_ESCALATION = [
  '## Pipeline Escalation',
  '3 conflicts — 1 resolved automatically, 2 need a decision',
  '',
  '### D1 — `src/money.ts`',
  '**Ours:** half-up',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | half-up | half-even |',
  '| **B take theirs** | half-even | half-up |',
  '',
  '**Recommendation: B** — base ships half-even.',
  '',
  '### D2 — `src/format.ts`',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | two decimals | locale |',
  '| **B take theirs** | locale | two decimals |',
  '| **C keep both rounding modes** | a mode argument | one signature |',
].join('\n')

describe('applyItemDecision — rebase decisions', () => {
  const comments = [{ body: TWO_DECISION_ESCALATION, createdAt: '2026-01-01T00:00:00Z' }]
  const request = (overrides: Partial<Parameters<typeof applyItemDecision>[0]['request']>) => ({
    repoId: REPO_ID,
    number: 300,
    decision: 'unblock' as const,
    expectedStage: 'needsHuman' as const,
    route: 'revision' as const,
    note: null,
    skipComment: false,
    picks: [
      { id: 'D1', letter: 'B' },
      { id: 'D2', letter: 'C' },
    ],
    ...overrides,
  })

  it('posts the terminal path comment, then swaps needsHuman for needsRevision', async () => {
    const snapshot = snapshotOf([repoState([item({ comments })])])
    const calls: string[] = []
    let body = ''
    let labels: { readonly add: readonly string[]; readonly remove: readonly string[] } | null = null
    const deps = depsWith({
      postComment: (params) => {
        calls.push('comment')
        body = params.request.body
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      applyLabels: (params) => {
        calls.push('labels')
        labels = params.request
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    const result = await applyItemDecision({ request: request({}), snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false }, deps)
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['comment', 'labels'])
    expect(body).toBe(
      '## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Rebase decisions\n- D1 `src/money.ts` — **B take theirs**\n- D2 `src/format.ts` — **C keep both rounding modes**',
    )
    expect(labels).toMatchObject({ add: ['needsRevision'], remove: ['needsHuman'] })
  })

  it.each([
    ['a missing pick', { picks: [{ id: 'D1', letter: 'B' }] }, 'missing D2'],
    ['no picks at all', { picks: null }, 'missing D1'],
    ['an unknown id', { picks: [{ id: 'D1', letter: 'B' }, { id: 'D2', letter: 'C' }, { id: 'D9', letter: 'A' }] }, 'unknown D9'],
    ['an off-menu letter', { picks: [{ id: 'D1', letter: 'C' }, { id: 'D2', letter: 'C' }] }, 'off-menu D1'],
    ['the review route', { route: 'review' as const }, 'route'],
  ])('refuses %s with picks-invalid and writes nothing', async (_name, overrides, problem) => {
    const snapshot = snapshotOf([repoState([item({ comments })])])
    const result = await applyItemDecision({ request: request(overrides), snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false }, depsWith({}))
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'picks-invalid', problem })
  })

  it('refuses picks on an escalation that carries no decisions', async () => {
    const snapshot = snapshotOf([repoState([item({ comments: [{ body: '## Pipeline Escalation\nreason', createdAt: '2026-01-01T00:00:00Z' }] })])])
    const result = await applyItemDecision({ request: request({}), snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false }, depsWith({}))
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'picks-invalid', problem: 'unexpected' })
  })

  it('still refuses rebase-decisions when a block cannot be parsed', async () => {
    const unreadable = [{ body: '## Pipeline Escalation\n1 conflict\n### D1 — `a.ts`\nno table', createdAt: '2026-01-01T00:00:00Z' }]
    const snapshot = snapshotOf([repoState([item({ comments: unreadable })])])
    const result = await applyItemDecision({ request: request({}), snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch', liveStage: false }, depsWith({}))
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'rebase-decisions' })
  })
})

describe('applyItemDecision — blocked issue', () => {
  const blockedIssue = () => item({ kind: 'issue', number: 51, stage: 'gate', stages: [stageLabel('blocked', 'gate')], matchedKeys: ['blocked'], headRefOid: null })
  const request = (overrides: Partial<Parameters<typeof applyItemDecision>[0]['request']> = {}) => ({
    repoId: REPO_ID,
    number: 51,
    decision: 'unblock' as const,
    expectedStage: 'blocked' as const,
    route: 'implementation' as const,
    note: null,
    skipComment: false,
    picks: null,
    ...overrides,
  })
  const params = (liveStage: boolean, overrides: Partial<Parameters<typeof applyItemDecision>[0]['request']> = {}) => ({
    request: request(overrides),
    snapshot: snapshotOf([repoState([blockedIssue()])]),
    entry: entry(),
    auditDir: '/audit',
    scratchDir: '/scratch',
    liveStage,
  })

  it('posts on the issue, then swaps blocked for planApproved with kind issue', async () => {
    const calls: string[] = []
    let comment: { readonly kind: string; readonly body: string } | null = null
    let write: { readonly kind: string; readonly add: readonly string[]; readonly remove: readonly string[] } | null = null
    const deps = depsWith({
      postComment: (p) => {
        calls.push('comment')
        comment = p.request
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      applyLabels: (p) => {
        calls.push('labels')
        write = p.request
        return Promise.resolve({ kind: 'applied', argv: [] })
      },
      fetchItemsByNumber: fetchReturning({ ok: true, resolved: [resolvedItem({ number: 51, kind: 'issue', labels: ['blocked'] })], unavailable: [], fetchedAt: NOW().toISOString() }),
    })
    const result = await applyItemDecision(params(false), deps)
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['comment', 'labels'])
    expect(comment).toMatchObject({ kind: 'issue', body: '## Gate cleared\nCleared by the operator in port: back to implementation.' })
    expect(write).toMatchObject({ kind: 'issue', add: ['planApproved'], remove: ['blocked'] })
  })

  it('refuses agent-live and writes nothing while a stage session is live', async () => {
    const result = await applyItemDecision(params(true), depsWith({}))
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'agent-live' })
  })

  it('throws when an issue is unblocked with a pull-request route', async () => {
    await expect(applyItemDecision(params(false, { route: 'review' }), depsWith({}))).rejects.toThrow(/does not fit issue #51/)
  })

  it('throws when a pull request is unblocked with the implementation route', async () => {
    const pr = { ...params(false, { number: 300, expectedStage: 'needsHuman' as const }), snapshot: snapshotOf([repoState([item()])]) }
    await expect(applyItemDecision(pr, depsWith({}))).rejects.toThrow(/does not fit pull-request #300/)
  })
})

describe('applyItemDecision — real writers', () => {
  async function makeDirs(): Promise<{ readonly repoRoot: string; readonly auditDir: string; readonly git: GitRunner }> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'port-decide-repo-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-decide-audit-'))
    const git: GitRunner = () => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' })
    return { repoRoot, auditDir, git }
  }

  it('writes a comment entry then a label entry with action unblock, through the real applyLabels/postComment', async () => {
    const { repoRoot, auditDir } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-decide-scratch-'))
    const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: '', stderr: '' })
    const fetchItemsByNumber: ApplyItemDecisionDeps['fetchItemsByNumber'] = () =>
      Promise.resolve({ ok: true, resolved: [resolvedItem()], unavailable: [], fetchedAt: NOW().toISOString() })

    const snapshot = snapshotOf([repoState([item()])])
    const result = await applyItemDecision(
      {
        request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null },
        snapshot,
        entry: entry({ path: repoRoot }),
        auditDir,
        scratchDir,
        liveStage: false,
      },
      {
        applyLabels: (params) => defaultApplyItemDecisionDeps.applyLabels({ ...params, gh, now: NOW, fetchItemsByNumber }),
        postComment: (params) => defaultApplyItemDecisionDeps.postComment({ ...params, gh, now: NOW }),
        fetchItemsByNumber,
      },
    )

    expect(result.ok).toBe(true)
    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(2)
    const labelEntries: readonly LabelAuditEntry[] = log.entries.map((e: AuditEntry) => {
      if (!isLabelAuditEntry(e)) throw new Error('unreachable: expected a label audit entry')
      return e
    })
    expect(labelEntries[0]?.commentBytes).not.toBeNull()
    expect(labelEntries[0]?.action).toBe('unblock')
    expect(labelEntries[1]?.action).toBe('unblock')
    expect(labelEntries[1]?.commentBytes).toBeNull()
    const outcomes: readonly WriteOutcome[] = labelEntries.map((e) => e.result)
    expect(outcomes.every((o) => o.kind === 'applied')).toBe(true)
  })
})
