import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import type { GitRunner } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'
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

// Drive-qualified on win32, because `resolveGitBaseRoot` resolves `.git` through `path.win32.resolve`, which adds the drive.
const absolute = (relative: string): string => pathOps.resolveFrom(pathOps.toNative('/'), relative)

const REPO = absolute('repo')
const PLAIN = absolute('tmp/not-a-repo')
const WORKTREE = pathOps.join(REPO, '.claude', 'worktrees', 'session-abc123')
const LINKED = {
  root: () => ok(`${WORKTREE}\n`),
  'rev-parse --git-dir': () => ok('/repo/.git/worktrees/session-abc123\n'),
  'rev-parse --git-common-dir': () => ok('/repo/.git\n'),
  'rev-parse --abbrev-ref': () => ok('session/abc123\n'),
}
const MAIN_CHECKOUT = {
  root: () => ok(`${REPO}\n`),
  'rev-parse --git-dir': () => ok('.git\n'),
  'rev-parse --git-common-dir': () => ok('.git\n'),
  'rev-parse --abbrev-ref': () => ok('main\n'),
  'rev-parse HEAD': () => ok('abc123\n'),
}
const DETACHED = { ...MAIN_CHECKOUT, 'rev-parse --abbrev-ref': () => ok('HEAD\n') }

const readyRepo = (path: string) => readyEntry({ id: path as RepoId, path, displayName: path })

describe('resolveWorkspace', () => {
  it.each([
    { name: 'a non-git folder', folder: PLAIN, git: {}, workspace: { folder: PLAIN, root: null, worktree: null, base: null }, repoId: null },
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
    { name: 'the main checkout', folder: REPO, git: MAIN_CHECKOUT, workspace: { folder: REPO, root: REPO, worktree: null, base: { sha: 'abc123', label: 'main' } }, repoId: null },
    { name: 'a detached HEAD', folder: REPO, git: DETACHED, workspace: { folder: REPO, root: REPO, worktree: null, base: { sha: 'abc123', label: 'abc123' } }, repoId: null },
    { name: 'a registered repository', folder: REPO, git: MAIN_CHECKOUT, repositories: [readyRepo(REPO)], workspace: { folder: REPO, root: REPO, worktree: null, base: { sha: 'abc123', label: 'main' } }, repoId: REPO },
  ])('resolves $name', async ({ folder, git, repositories, workspace, repoId }) => {
    const resolved = await resolveWorkspace({ git: fakeGit(git) }, folder, repositories ?? [])
    expect(resolved).toEqual({ workspace, repoId })
  })
})

describe('toFolderEntry', () => {
  it('returns git: null for a non-git folder', async () => {
    const plain = absolute('tmp/plain')
    const entry = await toFolderEntry({ git: fakeGit({}) }, plain, [], null)
    expect(entry).toMatchObject({ git: null, repoId: null, path: plain })
    expect(entry.id.startsWith('folder-')).toBe(true)
  })

  it('returns git head/branch and repoId for a registered git repo', async () => {
    const entry = await toFolderEntry({ git: fakeGit(MAIN_CHECKOUT) }, REPO, [readyRepo(REPO)], '2026-01-01T00:00:00.000Z')
    expect(entry).toMatchObject({ git: { root: REPO, head: { sha: 'abc123', branch: 'main' } }, repoId: REPO, lastUsedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('produces a stable id for the same path', async () => {
    const ctx = { git: fakeGit({}) }
    const same = absolute('tmp/same')
    expect((await toFolderEntry(ctx, same, [], null)).id).toBe((await toFolderEntry(ctx, same, [], null)).id)
  })
})
