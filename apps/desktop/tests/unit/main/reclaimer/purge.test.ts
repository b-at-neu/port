import { describe, expect, it } from 'vitest'
import { createFakeRepo, MAIN, WORKTREES } from '../../../fixtures/reclaimer-harness'
import type { FakeRepoOptions } from '../../../fixtures/reclaimer-harness'
import { runPurge } from '@/main/reclaimer/purge'

const STALE = `${WORKTREES}/impl-29-stale`

async function purge(options: FakeRepoOptions, path: string) {
  const repo = createFakeRepo(options)
  const result = await runPurge({ repoRoot: MAIN, path, ...repo.seams })
  return { result, repo }
}

describe('runPurge', () => {
  it('deletes an orphan directory that is a member of this run’s own set', async () => {
    const { result, repo } = await purge({ orphanDirs: [STALE] }, STALE)
    expect(result).toMatchObject({ ok: true, outcome: 'deleted', pathBasename: 'impl-29-stale', message: null, cause: null, call: ['purge', '--orphan', STALE] })
    expect(repo.nodes.has(STALE)).toBe(false)
  })

  it('refuses a directory that is not an orphan and deletes nothing', async () => {
    const live = `${WORKTREES}/impl-36`
    const { result, repo } = await purge({ worktrees: [{ path: live, branch: '36-x' }], orphanDirs: [STALE] }, live)
    expect(result).toMatchObject({ ok: true, outcome: 'refused', message: "not an orphan directory in this run's report; never deleted" })
    expect(repo.nodes.has(live)).toBe(true)
  })

  it('refuses a path nothing scanned, such as the repository root', async () => {
    const { result, repo } = await purge({ orphanDirs: [STALE] }, MAIN)
    expect(result).toMatchObject({ ok: true, outcome: 'refused' })
    expect(repo.nodes.has(MAIN)).toBe(true)
  })

  it('refuses an independent repository whose .git is a directory', async () => {
    const independent = `${WORKTREES}/clone`
    const repo = createFakeRepo({ orphanDirs: [independent] })
    repo.nodes.set(`${independent}/.git`, { kind: 'directory', text: '', modifiedAt: 't' })
    const result = await runPurge({ repoRoot: MAIN, path: independent, ...repo.seams })
    expect(result).toMatchObject({ ok: true, outcome: 'refused' })
    expect(repo.nodes.has(independent)).toBe(true)
  })

  it('reports a file in use as a failure with its cause', async () => {
    const { result } = await purge({ orphanDirs: [STALE], fsRemoveFails: { [STALE]: 'EBUSY' } }, STALE)
    expect(result).toMatchObject({ ok: true, outcome: 'failed', cause: 'file-in-use' })
    expect(result.ok && result.message).toContain('EBUSY')
  })

  it('reports an unknown errno as an unknown cause', async () => {
    const { result } = await purge({ orphanDirs: [STALE], fsRemoveFails: { [STALE]: 'EIO' } }, STALE)
    expect(result).toMatchObject({ ok: true, outcome: 'failed', cause: 'unknown' })
  })

  it('fails with the git kind when the repository cannot be read, deleting nothing', async () => {
    const repo = createFakeRepo({ orphanDirs: [STALE] })
    const result = await runPurge({
      repoRoot: MAIN,
      path: STALE,
      ...repo.seams,
      git: () => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    })
    expect(result).toMatchObject({ ok: false, kind: 'not-a-repository', call: ['purge', '--orphan', STALE] })
    expect(repo.nodes.has(STALE)).toBe(true)
  })

  it('needs neither GitHub nor an integration ref', async () => {
    const { result, repo } = await purge({ orphanDirs: [STALE], remoteRef: false, localRef: false }, STALE)
    expect(result).toMatchObject({ ok: true, outcome: 'deleted' })
    expect(repo.calls.some((c) => c[0] === 'rev-parse')).toBe(false)
  })
})
