import { describe, expect, it } from 'vitest'
import { createFakeRepo, MAIN, WORKTREES } from '../../../fixtures/reclaimer-harness'
import type { FakeRepoOptions } from '../../../fixtures/reclaimer-harness'
import { findOrphanDirs } from '@/main/features/worktrees/orphans'
import type { OrphanCandidate } from '@/main/features/worktrees/orphans'
import type { PlatformFs } from '@/types/platform'

const node = (kind: 'directory' | 'file', text = '') => ({ kind, text, modifiedAt: 't' })

function setup(options: FakeRepoOptions = {}) {
  const repo = createFakeRepo(options)
  const { fs } = repo.ctx
  const find = (candidates: readonly OrphanCandidate[] = [], over: Partial<PlatformFs> = {}) => findOrphanDirs({ fs: { ...fs, ...over } }, MAIN, candidates)
  return { repo, find }
}

describe('findOrphanDirs', () => {
  it('finds a directory with no .git entry in .claude/worktrees', async () => {
    const { find } = setup({ orphanDirs: [`${WORKTREES}/stale`] })
    expect(await find()).toEqual([`${WORKTREES}/stale`])
  })

  it('skips every registered worktree', async () => {
    const live = `${WORKTREES}/impl-36`
    const { find } = setup({ worktrees: [{ path: live, branch: '36-x' }] })
    expect(await find([{ path: live, isOutside: false }])).toEqual([])
  })

  it('finds a worktree directory whose gitdir target is gone', async () => {
    const dead = `${WORKTREES}/impl-7`
    const { repo, find } = setup({ worktrees: [{ path: dead, branch: '7-x' }] })
    repo.nodes.delete(`${MAIN}/.git/worktrees/impl-7`)
    expect(await find()).toEqual([dead])
  })

  it('skips a .git directory and a .git file whose target exists', async () => {
    const { repo, find } = setup({ orphanDirs: [`${WORKTREES}/clone`, `${WORKTREES}/linked`] })
    repo.nodes.set(`${WORKTREES}/clone/.git`, node('directory'))
    repo.nodes.set(`${WORKTREES}/linked/.git`, node('file', `gitdir: ${MAIN}/.git\n`))
    expect(await find()).toEqual([])
  })

  it('skips a directory whose .git entry cannot be read', async () => {
    const { repo, find } = setup({ orphanDirs: [`${WORKTREES}/odd`] })
    const real = repo.ctx.fs
    const denied = (p: string) => (p === `${WORKTREES}/odd/.git` ? Promise.resolve({ ok: false, kind: 'permission-denied', message: 'EACCES' } as const) : real.stat(p))
    expect(await find([], { stat: denied })).toEqual([])
  })

  it('skips a plain file and an unreadable parent', async () => {
    const { repo, find } = setup()
    repo.nodes.set(`${WORKTREES}/notes.txt`, node('file'))
    expect(await find()).toEqual([])
    expect(await find([], { list: () => Promise.resolve({ ok: false, kind: 'permission-denied', message: 'EACCES' }) })).toEqual([])
  })

  it('scans a worktree’s parent only when the worktree is not fenced off', async () => {
    const { repo, find } = setup()
    repo.nodes.set('/elsewhere', node('directory'))
    repo.nodes.set('/elsewhere/stray', node('directory'))
    expect(await find([{ path: '/elsewhere/impl-9', isOutside: true }])).toEqual([])
    expect(await find([{ path: '/elsewhere/impl-9', isOutside: false }])).toEqual(['/elsewhere/stray'])
  })

  it('reports each directory once when candidates share a parent', async () => {
    const a = `${WORKTREES}/impl-1`
    const b = `${WORKTREES}/impl-2`
    const { find } = setup({ worktrees: [{ path: a }, { path: b }], orphanDirs: [`${WORKTREES}/stale`] })
    expect(
      await find([
        { path: a, isOutside: false },
        { path: b, isOutside: false },
      ]),
    ).toEqual([`${WORKTREES}/stale`])
  })
})
