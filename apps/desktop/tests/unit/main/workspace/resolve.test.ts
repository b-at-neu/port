import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import type { GitRunner } from '@/types/platform'
import { resolveWorkspace, toFolderEntry } from '@/main/repos/worktree/resolve'
import type { RepoId } from '@/utils/repos'
import { readyEntry } from '../../../support/repo-config'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }

function fakeGit(overrides: Partial<Record<string, () => CommandResult>>): GitRunner {
  return (args) => {
    const key = args[0] === 'rev-parse' && args.includes('--show-toplevel') ? 'root' : args.join(' ')
    for (const [pattern, handler] of Object.entries(overrides)) {
      if ((key === pattern || key.startsWith(pattern)) && handler) return Promise.resolve(handler())
    }
    return Promise.resolve(NOT_A_REPO)
  }
}

const WORKTREE = '/repo/.claude/worktrees/session-abc123'
const LINKED = {
  root: () => ok(`${WORKTREE}\n`),
  'rev-parse --git-dir': () => ok('/repo/.git/worktrees/session-abc123\n'),
  'rev-parse --git-common-dir': () => ok('/repo/.git\n'),
  'rev-parse --abbrev-ref': () => ok('session/abc123\n'),
}
const MAIN_CHECKOUT = {
  root: () => ok('/repo\n'),
  'rev-parse --git-dir': () => ok('.git\n'),
  'rev-parse --git-common-dir': () => ok('.git\n'),
  'rev-parse --abbrev-ref': () => ok('main\n'),
  'rev-parse HEAD': () => ok('abc123\n'),
}
const DETACHED = { ...MAIN_CHECKOUT, 'rev-parse --abbrev-ref': () => ok('HEAD\n') }

const readyRepo = (path: string) => readyEntry({ id: path as RepoId, path, displayName: path })

describe('resolveWorkspace', () => {
  it.each([
    { name: 'a non-git folder', folder: '/tmp/not-a-repo', git: {}, workspace: { folder: '/tmp/not-a-repo', root: null, worktree: null, base: null }, repoId: null },
    {
      name: 'a linked worktree with its recorded portBase',
      folder: WORKTREE,
      git: { ...LINKED, 'config branch.session/abc123.portBase': () => ok('def456\n') },
      workspace: { folder: WORKTREE, root: WORKTREE, worktree: { path: WORKTREE, branch: 'session/abc123' }, base: { sha: 'def456', label: 'session/abc123' } },
      repoId: null,
    },
    {
      name: 'a linked worktree with no recorded portBase',
      folder: WORKTREE,
      git: LINKED,
      workspace: { folder: WORKTREE, root: WORKTREE, worktree: { path: WORKTREE, branch: 'session/abc123' }, base: null },
      repoId: null,
    },
    { name: 'the main checkout', folder: '/repo', git: MAIN_CHECKOUT, workspace: { folder: '/repo', root: '/repo', worktree: null, base: { sha: 'abc123', label: 'main' } }, repoId: null },
    { name: 'a detached HEAD', folder: '/repo', git: DETACHED, workspace: { folder: '/repo', root: '/repo', worktree: null, base: { sha: 'abc123', label: 'abc123' } }, repoId: null },
    { name: 'a registered repository', folder: '/repo', git: MAIN_CHECKOUT, repositories: [readyRepo('/repo')], workspace: { folder: '/repo', root: '/repo', worktree: null, base: { sha: 'abc123', label: 'main' } }, repoId: '/repo' },
  ])('resolves $name', async ({ folder, git, repositories, workspace, repoId }) => {
    const resolved = await resolveWorkspace({ git: fakeGit(git) }, folder, repositories ?? [])
    expect(resolved).toEqual({ workspace, repoId })
  })
})

describe('toFolderEntry', () => {
  it('returns git: null for a non-git folder', async () => {
    const entry = await toFolderEntry({ git: fakeGit({}) }, '/tmp/plain', [], null)
    expect(entry).toMatchObject({ git: null, repoId: null, path: '/tmp/plain' })
    expect(entry.id.startsWith('folder-')).toBe(true)
  })

  it('returns git head/branch and repoId for a registered git repo', async () => {
    const entry = await toFolderEntry({ git: fakeGit(MAIN_CHECKOUT) }, '/repo', [readyRepo('/repo')], '2026-01-01T00:00:00.000Z')
    expect(entry).toMatchObject({ git: { root: '/repo', head: { sha: 'abc123', branch: 'main' } }, repoId: '/repo', lastUsedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('produces a stable id for the same path', async () => {
    const ctx = { git: fakeGit({}) }
    expect((await toFolderEntry(ctx, '/tmp/same', [], null)).id).toBe((await toFolderEntry(ctx, '/tmp/same', [], null)).id)
  })
})
