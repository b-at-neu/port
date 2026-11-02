import { describe, expect, it } from 'vitest'
import { createFakeGh, createFakeRepo, MAIN, WORKTREES } from '../../../fixtures/reclaimer-harness'
import type { FakeGhOptions, FakeRepoOptions } from '../../../fixtures/reclaimer-harness'
import { readWorktreeReport } from '@/main/reclaimer/report'
import type { WorktreesReport } from '@/types/reclaimer'

const MERGED = `${WORKTREES}/impl-36`
const OPEN = `${WORKTREES}/impl-41`

async function report(repoOptions: FakeRepoOptions, ghOptions: FakeGhOptions = {}) {
  const repo = createFakeRepo(repoOptions)
  const gh = createFakeGh(ghOptions)
  const result = await readWorktreeReport({ repoRoot: MAIN, repo: 'acme/widgets', integration: 'dev', gh: gh.gh, ...repo.seams })
  return { result, repo, gh }
}

function ok(result: WorktreesReport): Extract<WorktreesReport, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.kind}`)
  return result
}

describe('readWorktreeReport', () => {
  it('classifies a merged, an open, a no-work and an unresolved worktree', async () => {
    const { result, gh } = await report(
      {
        worktrees: [
          { path: MERGED, branch: '36-paginate' },
          { path: OPEN, branch: '41-csv' },
          { path: `${WORKTREES}/scratch`, branch: 'scratch', ancestor: true },
          { path: `${WORKTREES}/stray`, branch: 'stray', ancestor: false },
        ],
      },
      { states: { 36: 'MERGED', 41: 'OPEN' } },
    )
    const value = ok(result)
    expect(value.worktrees.map((w) => [w.pathBasename, w.state, w.reclaimable])).toEqual([
      ['impl-36', 'done', true],
      ['impl-41', 'active', false],
      ['scratch', 'no-work', true],
      ['stray', 'unresolved', false],
    ])
    expect(value).toMatchObject({ mainRoot: MAIN, integrationRef: 'origin/dev', registered: 4, githubResolution: 'resolved', porcelainJoin: 'joined' })
    expect(value.byState).toEqual({ done: 1, active: 1, 'no-work': 1, unresolved: 1 })
    expect(value.worktrees[0]).toMatchObject({ issue: 36, rung: 'branch-name', reason: '#36 merged (branch-name)', producer: 'operator', prunable: false })
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]?.join(' ')).toContain('n36: issueOrPullRequest(number: 36)')
    expect(gh.calls[0]?.join(' ')).toContain('n41: issueOrPullRequest(number: 41)')
  })

  it('makes no GitHub call when no worktree correlates to an item', async () => {
    const { result, gh } = await report({ worktrees: [{ path: `${WORKTREES}/scratch`, branch: 'scratch', ancestor: true }] })
    expect(ok(result).githubResolution).toBe('resolved')
    expect(gh.calls).toEqual([])
  })

  it('reports a correlated worktree as unresolved, never done, when GitHub cannot be read', async () => {
    const { result } = await report(
      { worktrees: [{ path: MERGED, branch: '36-paginate', ancestor: true }] },
      { failure: { ok: false, kind: 'network', stdout: '', stderr: 'no route to host' } },
    )
    const value = ok(result)
    expect(value.githubResolution).toBe('unavailable')
    expect(value.worktrees[0]).toMatchObject({ state: 'unresolved', reclaimable: false, reason: '#36 could not be resolved' })
  })

  it('treats an alias GitHub errored on as unknown, not done', async () => {
    const { result } = await report({ worktrees: [{ path: MERGED, branch: '36-paginate' }] }, { states: { 36: 'MERGED' }, erroredAliases: [36] })
    expect(ok(result).worktrees[0]?.state).toBe('unresolved')
  })

  it('offers an unlock on a finished locked worktree but not on a live one', async () => {
    const { result } = await report(
      {
        worktrees: [
          { path: MERGED, branch: '36-paginate', locked: true, lockReason: 'review attached' },
          { path: OPEN, branch: '41-csv', locked: true },
        ],
      },
      { states: { 36: 'MERGED', 41: 'OPEN' } },
    )
    const [finished, live] = ok(result).worktrees
    expect(finished).toMatchObject({ state: 'locked', otherwiseReclaimable: true, reclaimable: false, lockReason: 'review attached' })
    expect(finished?.reason).toContain('reclaimable once unlocked')
    expect(live).toMatchObject({ state: 'locked', otherwiseReclaimable: false, reason: 'locked' })
  })

  it('counts uncommitted files, and counts an unreadable status as dirty', async () => {
    const { result } = await report(
      {
        worktrees: [
          { path: MERGED, branch: '36-paginate', status: [' M a.ts', '?? b.ts'] },
          { path: `${WORKTREES}/impl-37`, branch: '37-other', status: 'fails' },
        ],
      },
      { states: { 36: 'MERGED', 37: 'CLOSED' } },
    )
    const [counted, failed] = ok(result).worktrees
    expect(counted).toMatchObject({ state: 'dirty', dirtyFiles: 2, otherwiseReclaimable: true, reclaimable: false })
    expect(failed).toMatchObject({ state: 'dirty', dirtyFiles: -1 })
    expect(failed?.reason).toBe('#37 otherwise reclaimable, but an unknown number of uncommitted file(s)')
  })

  it('never checks the status of a worktree that could not be reclaimed anyway', async () => {
    const { repo } = await report({ worktrees: [{ path: OPEN, branch: '41-csv' }] }, { states: { 41: 'OPEN' } })
    expect(repo.calls.some((call) => call[0] === 'status')).toBe(false)
  })

  it('fences off a worktree outside the main one and never correlates it', async () => {
    const { result, gh } = await report({ worktrees: [{ path: '/elsewhere/impl-9', branch: '9-x' }] })
    expect(ok(result).worktrees[0]).toMatchObject({ state: 'outside', issue: null, reclaimable: false, otherwiseReclaimable: false })
    expect(gh.calls).toEqual([])
  })

  it('treats a failed ancestry check as not an ancestor', async () => {
    const { result } = await report({ worktrees: [{ path: `${WORKTREES}/scratch`, branch: 'scratch' }] })
    expect(ok(result).worktrees[0]?.state).toBe('unresolved')
  })

  it('falls back to a local integration branch when there is no remote-tracking ref', async () => {
    const { result } = await report({ worktrees: [], remoteRef: false, localRef: true })
    expect(ok(result).integrationRef).toBe('dev')
  })

  it('fails the whole read when neither integration ref exists', async () => {
    const { result } = await report({ worktrees: [], remoteRef: false, localRef: false })
    expect(result).toMatchObject({ ok: false, kind: 'no-integration-ref', integration: 'dev' })
  })

  it('reports an orphan directory beside the worktrees', async () => {
    const { result } = await report({ worktrees: [{ path: MERGED, branch: '36-paginate' }], orphanDirs: [`${WORKTREES}/stale`] }, { states: { 36: 'MERGED' } })
    expect(ok(result).orphanDirs).toEqual([`${WORKTREES}/stale`])
  })

  it('passes every git call through core.longpaths', async () => {
    const { repo } = await report({ worktrees: [{ path: MERGED, branch: '36-paginate' }] }, { states: { 36: 'MERGED' } })
    expect(repo.rawCalls.length).toBeGreaterThan(0)
    expect(repo.rawCalls.every((call) => call[0] === '-c' && call[1] === 'core.longpaths=true')).toBe(true)
  })

  it('maps a failed worktree list straight through', async () => {
    const repo = createFakeRepo()
    const failing = { ...repo.seams, git: () => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' } as const) }
    const result = await readWorktreeReport({ repoRoot: MAIN, repo: 'acme/widgets', integration: 'dev', ...failing })
    expect(result).toMatchObject({ ok: false, kind: 'not-a-repository', message: 'fatal: not a git repository' })

    const missing = await readWorktreeReport({ repoRoot: MAIN, repo: 'acme/widgets', integration: 'dev', ...repo.seams, git: () => Promise.resolve({ ok: false, kind: 'timeout', timeoutMs: 5, stderr: '' }) })
    expect(missing).toMatchObject({ ok: false, kind: 'timeout' })
  })
})
