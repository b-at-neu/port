import { describe, expect, it } from 'vitest'
import { createPathOps } from '@/main/platform/paths'
import { deleteMergedBranch, pruneWorktrees, removeWorktree, unlockWorktree } from '@/main/reclaimer/remove'
import type { CommandResult } from '@/types/platform'
import type { ReclaimerFs, ResolvedSeams } from '@/types/reclaimer'

const TARGET = '/repo/.claude/worktrees/impl-36'
const ok = (stdout = ''): CommandResult => ({ ok: true, stdout, stderr: '' })
const nonzero = (stderr: string): CommandResult => ({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr })

function listing(head: string | null): string {
  const target = head === null ? '' : `\n\nworktree ${TARGET}\nHEAD ${head}\nbranch refs/heads/36-x`
  return `worktree /repo\nHEAD main-head\nbranch refs/heads/dev${target}\n`
}

interface Scenario {
  /** HEAD the re-list reports for the target, or `null` when it is no longer registered. */
  readonly relistHead: string | null
  readonly dirExists: boolean
  readonly relistFails?: boolean
  readonly removal?: Awaited<ReturnType<ReclaimerFs['removeDirectory']>>
  readonly remove?: CommandResult
}

function scenario(s: Scenario) {
  const calls: string[][] = []
  const removed: string[] = []
  const fs: ReclaimerFs = {
    listDirectory: () => Promise.reject(new Error('unexpected listDirectory')),
    statPath: () => Promise.reject(new Error('unexpected statPath')),
    readTextFile: () => Promise.reject(new Error('unexpected readTextFile')),
    pathExists: () => Promise.resolve(s.dirExists),
    removeDirectory: (path) => {
      removed.push(path)
      return Promise.resolve(s.removal ?? { ok: true })
    },
  }
  const git: ResolvedSeams['git'] = (args) => {
    calls.push([...args])
    if (args[1] === 'list') return Promise.resolve(s.relistFails === true ? nonzero('fatal: broken') : ok(listing(s.relistHead)))
    if (args[1] === 'remove') return Promise.resolve(s.remove ?? ok())
    if (args[0] === 'config') return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
    if (args[0] === 'log') return Promise.resolve(ok(''))
    return Promise.resolve(ok())
  }
  const seams: ResolvedSeams = { git, fs, pathOps: createPathOps('posix', { home: '/home/u' }), now: () => new Date(0) }
  return { seams, calls, removed }
}

const candidate = { path: TARGET, head: 'aaa' }

describe('removeWorktree', () => {
  it('is done when git removed the directory, without touching the filesystem', async () => {
    const { seams, calls, removed } = scenario({ relistHead: null, dirExists: false })
    expect(await removeWorktree(seams, '/repo', candidate)).toEqual({ removed: true, error: null, cause: null })
    expect(calls[0]).toEqual(['worktree', 'remove', '--force', TARGET])
    expect(removed).toEqual([])
  })

  it('falls back to the filesystem when git deregistered the worktree but left the directory', async () => {
    const { seams, removed } = scenario({ relistHead: null, dirExists: true })
    expect(await removeWorktree(seams, '/repo', candidate)).toEqual({ removed: true, error: null, cause: null })
    expect(removed).toEqual([TARGET])
  })

  it('falls back when git refused and HEAD is where it was classified', async () => {
    const { seams, removed } = scenario({ relistHead: 'aaa', dirExists: true, remove: nonzero('fatal: cannot remove') })
    expect((await removeWorktree(seams, '/repo', candidate)).removed).toBe(true)
    expect(removed).toEqual([TARGET])
  })

  it('aborts, deleting nothing, when HEAD moved while it was being removed', async () => {
    const { seams, removed } = scenario({ relistHead: 'bbb', dirExists: true })
    expect(await removeWorktree(seams, '/repo', candidate)).toEqual({ removed: false, error: 'HEAD moved while it was being removed; not deleted.', cause: null })
    expect(removed).toEqual([])
  })

  it('keeps the directory when the worktree list cannot be re-read', async () => {
    const { seams, removed } = scenario({ relistHead: 'aaa', dirExists: true, relistFails: true })
    expect(await removeWorktree(seams, '/repo', candidate)).toEqual({ removed: false, error: "couldn't re-read the worktree list after removal; not deleted.", cause: null })
    expect(removed).toEqual([])
  })

  it('classifies a filesystem failure by its errno', async () => {
    const { seams } = scenario({ relistHead: null, dirExists: true, removal: { ok: false, code: 'ENAMETOOLONG', message: 'too long' } })
    expect(await removeWorktree(seams, '/repo', candidate)).toEqual({ removed: false, error: 'too long', cause: 'long-path' })
  })
})

describe('unlockWorktree, deleteMergedBranch, pruneWorktrees', () => {
  it('unlocks one path, naming git’s first line when it refuses', async () => {
    const good = scenario({ relistHead: null, dirExists: false })
    expect(await unlockWorktree(good.seams, '/repo', TARGET)).toEqual({ ok: true })
    expect(good.calls).toEqual([['worktree', 'unlock', TARGET]])

    const bad = scenario({ relistHead: null, dirExists: false })
    const refusing = { ...bad.seams, git: () => Promise.resolve(nonzero('fatal: not locked\nhint: x')) }
    expect(await unlockWorktree(refusing, '/repo', TARGET)).toEqual({ ok: false, message: 'unlock failed: fatal: not locked' })

    const spawn = { ...bad.seams, git: () => Promise.resolve<CommandResult>({ ok: false, kind: 'spawn-failed', message: 'EMFILE' }) }
    expect(await unlockWorktree(spawn, '/repo', TARGET)).toEqual({ ok: false, message: 'unlock failed: EMFILE' })
  })

  it('deletes a branch with -d, never -D, and reports a refusal', async () => {
    const good = scenario({ relistHead: null, dirExists: false })
    expect(await deleteMergedBranch(good.seams, '/repo', '36-x')).toBe(true)
    expect(good.calls).toEqual([['branch', '-d', '36-x']])
    const refusing = { ...good.seams, git: () => Promise.resolve(nonzero('error: not fully merged')) }
    expect(await deleteMergedBranch(refusing, '/repo', '36-x')).toBe(false)
  })

  it('prunes', async () => {
    const s = scenario({ relistHead: null, dirExists: false })
    await pruneWorktrees(s.seams, '/repo')
    expect(s.calls).toEqual([['worktree', 'prune']])
  })
})
