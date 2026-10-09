import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform/run'
import type { GitRunner } from '../platform/git'
import { createPathOps } from '../platform/paths'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import { resolveWorkspace, toFolderEntry } from './resolve'

// Fixed posix flavour, never the host-bound default: these fixtures are posix-shaped paths, and
// `defaultPathOps` silently switches to win32 on a Windows runner, which no posix fixture matches.
const pathOps = createPathOps('posix', { home: '/home/u' })

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }

function fakeGit(overrides: Partial<Record<string, (args: readonly string[], cwd: string) => CommandResult>>): GitRunner {
  return (args, cwd) => {
    const key = args[0] === 'rev-parse' && args.includes('--show-toplevel') ? 'root' : args.join(' ')
    for (const [pattern, handler] of Object.entries(overrides)) {
      if ((key === pattern || key.startsWith(pattern)) && handler) return Promise.resolve(handler(args, cwd))
    }
    return Promise.resolve(NOT_A_REPO)
  }
}

function readyRepo(path: string): RepositoryEntry {
  return {
    id: path as RepoId,
    path,
    displayName: path,
    status: 'ready',
    config: {
      repo: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      branches: { integration: 'dev', production: 'main' },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: { labels: [], disabled: [], problems: [] },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      checkDispositions: {},
      overrides: [],
    },
    diagnostics: [],
  }
}

describe('resolveWorkspace', () => {
  it('resolves root: null for a non-git folder, with no worktree or base', async () => {
    const git = fakeGit({})
    const { workspace, repoId } = await resolveWorkspace('/tmp/not-a-repo', { git, repositories: [], pathOps })
    expect(workspace).toEqual({ folder: '/tmp/not-a-repo', root: null, worktree: null, base: null })
    expect(repoId).toBeNull()
  })

  it('resolves a non-worktree folder to a HEAD-sha base and no worktree', async () => {
    const git = fakeGit({
      root: () => ok('/repo\n'),
      'rev-parse --git-dir': () => ok('.git\n'),
      'rev-parse --git-common-dir': () => ok('.git\n'),
      'rev-parse --abbrev-ref': () => ok('main\n'),
      'rev-parse HEAD': () => ok('abc123\n'),
    })
    const { workspace, repoId } = await resolveWorkspace('/repo', { git, repositories: [], pathOps })
    expect(workspace.root).toBe('/repo')
    expect(workspace.worktree).toBeNull()
    expect(workspace.base).toEqual({ sha: 'abc123', label: 'main' })
    expect(repoId).toBeNull()
  })

  it('resolves a linked worktree with its recorded portBase', async () => {
    const git = fakeGit({
      root: () => ok('/repo/.claude/worktrees/session-abc123\n'),
      'rev-parse --git-dir': () => ok('/repo/.git/worktrees/session-abc123\n'),
      'rev-parse --git-common-dir': () => ok('/repo/.git\n'),
      'rev-parse --abbrev-ref': () => ok('session/abc123\n'),
      'config branch.session/abc123.portBase': () => ok('def456\n'),
    })
    const { workspace } = await resolveWorkspace('/repo/.claude/worktrees/session-abc123', { git, repositories: [], pathOps })
    expect(workspace.worktree).toEqual({ path: '/repo/.claude/worktrees/session-abc123', branch: 'session/abc123' })
    expect(workspace.base).toEqual({ sha: 'def456', label: 'session/abc123' })
  })

  it('reports base: null for a linked worktree with no recorded portBase', async () => {
    const git = fakeGit({
      root: () => ok('/repo/.claude/worktrees/session-abc123\n'),
      'rev-parse --git-dir': () => ok('/repo/.git/worktrees/session-abc123\n'),
      'rev-parse --git-common-dir': () => ok('/repo/.git\n'),
      'rev-parse --abbrev-ref': () => ok('session/abc123\n'),
      'config branch.session/abc123.portBase': () => NOT_A_REPO,
    })
    const { workspace } = await resolveWorkspace('/repo/.claude/worktrees/session-abc123', { git, repositories: [], pathOps })
    expect(workspace.base).toBeNull()
  })

  it('resolves repoId to the ready registry entry whose path matches the git base root', async () => {
    const git = fakeGit({
      root: () => ok('/repo\n'),
      'rev-parse --git-dir': () => ok('.git\n'),
      'rev-parse --git-common-dir': () => ok('.git\n'),
      'rev-parse --abbrev-ref': () => ok('main\n'),
      'rev-parse HEAD': () => ok('abc123\n'),
    })
    const repositories = [readyRepo('/repo')]
    const { repoId } = await resolveWorkspace('/repo', { git, repositories, pathOps })
    expect(repoId).toBe('/repo')
  })
})

describe('toFolderEntry', () => {
  it('returns git: null for a non-git folder', async () => {
    const git = fakeGit({})
    const entry = await toFolderEntry('/tmp/plain', { git, repositories: [], lastUsedAt: null, pathOps })
    expect(entry.git).toBeNull()
    expect(entry.repoId).toBeNull()
    expect(entry.path).toBe('/tmp/plain')
    expect(entry.id.startsWith('folder-')).toBe(true)
  })

  it('returns git head/branch and repoId for a registered git repo', async () => {
    const git = fakeGit({
      root: () => ok('/repo\n'),
      'rev-parse HEAD': () => ok('abc123\n'),
      'rev-parse --abbrev-ref': () => ok('main\n'),
      'rev-parse --git-common-dir': () => ok('.git\n'),
    })
    const repositories = [readyRepo('/repo')]
    const entry = await toFolderEntry('/repo', { git, repositories, lastUsedAt: '2026-01-01T00:00:00.000Z', pathOps })
    expect(entry.git).toEqual({ root: '/repo', head: { sha: 'abc123', branch: 'main' } })
    expect(entry.repoId).toBe('/repo')
    expect(entry.lastUsedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('produces a stable id for the same path', async () => {
    const git = fakeGit({})
    const first = await toFolderEntry('/tmp/same', { git, repositories: [], lastUsedAt: null, pathOps })
    const second = await toFolderEntry('/tmp/same', { git, repositories: [], lastUsedAt: null, pathOps })
    expect(first.id).toBe(second.id)
  })
})
