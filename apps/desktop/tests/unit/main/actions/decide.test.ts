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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'moved', expected: 'needs human', observed: 'no longer tracked' })
  })

  it('refuses moved when the current stage disagrees with expectedStage', async () => {
    const snapshot = snapshotOf([repoState([item({ stages: [stageLabel('approved', 'terminal')], stage: 'terminal' })])])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'not-owned', owners: ['other'] })
  })

  it('refuses cycle-cap for revise at the cap', async () => {
    const snapshot = snapshotOf([repoState([item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 5 })], { reviewCycleCap: 5 })])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'revise', expectedStage: 'approved', route: null, note: 'change it', skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
      depsWith({}),
    )
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'cycle-cap' })
  })

  it('refuses note-invalid for an empty revise note, before any read or write', async () => {
    const snapshot = snapshotOf([repoState([item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')] })])])
    const result = await applyItemDecision(
      { request: { repoId: REPO_ID, number: 300, decision: 'revise', expectedStage: 'approved', route: null, note: '  ', skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: true }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
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
      { request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false }, snapshot, entry: entry(), auditDir: '/audit', scratchDir: '/scratch' },
      deps,
    )
    expect(body).not.toContain('### Cycle grant')
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
        request: { repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false },
        snapshot,
        entry: entry({ path: repoRoot }),
        auditDir,
        scratchDir,
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
