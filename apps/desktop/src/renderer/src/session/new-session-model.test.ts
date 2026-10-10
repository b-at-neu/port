import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { FolderEntry, FolderId } from '../../../shared/workspace/types'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'
import { effectiveWorktree, initialFolderId, orderFolders, worktreeControl, worktreeHint } from './new-session-model'

function folder(overrides: Partial<FolderEntry>): FolderEntry {
  return {
    id: 'folder-1' as FolderId,
    path: '/home/you/src/widgets',
    name: 'widgets',
    git: { root: '/home/you/src/widgets', head: { sha: 'a1b2c3d4e5', branch: 'dev' } },
    repoId: null,
    lastUsedAt: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<HostedSessionSnapshot>): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1',
    claudeSessionId: null,
    repoId: null,
    workspace: { folder: '/home/you/src/widgets', root: '/home/you/src/widgets', worktree: null, base: null },
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: new Date(0).toISOString(),
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    title: null,
    pendingPermissions: [],
    capabilities: { kind: 'unavailable', request: { source: 'installed' }, message: '' },
    rateLimit: null,
    controls: { permissionMode: 'default', model: 'sonnet', effort: null },
    models: { kind: 'unavailable', message: '' },
    usage: null,
    ...overrides,
  } as HostedSessionSnapshot
}

describe('orderFolders', () => {
  it('puts registered repos first, then recents by lastUsedAt, capped at 10', () => {
    const repoFolder = folder({ id: 'repo' as FolderId, repoId: 'repo-1' as RepoId })
    const recents = Array.from({ length: 12 }, (_v, i) =>
      folder({ id: `recent-${String(i)}` as FolderId, path: `/path/${String(i)}`, lastUsedAt: new Date(i).toISOString() }),
    )
    const result = orderFolders([...recents, repoFolder])
    expect(result.repos).toEqual([repoFolder])
    expect(result.recents).toHaveLength(10)
    expect(result.recents[0]?.id).toBe('recent-11')
  })
})

describe('initialFolderId', () => {
  const repoFolder = folder({ id: 'repo' as FolderId, repoId: 'repo-1' as RepoId, path: '/home/you/src/widgets' })
  const pathFolder = folder({ id: 'path' as FolderId, path: '/home/you/notes', lastUsedAt: new Date(1).toISOString() })
  const latestFolder = folder({ id: 'latest' as FolderId, path: '/home/you/latest', lastUsedAt: new Date(2).toISOString() })

  it('prefers a repo preselect', () => {
    expect(initialFolderId([repoFolder, pathFolder], { kind: 'repo', repoId: 'repo-1' as RepoId })).toBe('repo')
  })

  it('then a path preselect', () => {
    expect(initialFolderId([repoFolder, pathFolder], { kind: 'path', path: '/home/you/notes' })).toBe('path')
  })

  it('then the latest lastUsedAt', () => {
    expect(initialFolderId([pathFolder, latestFolder], null)).toBe('latest')
  })

  it('is null when there are no folders', () => {
    expect(initialFolderId([], null)).toBeNull()
  })
})

describe('worktreeControl', () => {
  it('is disabled-off for a non-git folder', () => {
    expect(worktreeControl(folder({ git: null }), [])).toEqual({ kind: 'disabled-off', reason: "This folder isn't a git repository." })
  })

  it('is forced-on when a live non-worktree session sits in the same folder', () => {
    const control = worktreeControl(folder({ path: '/home/you/src/widgets' }), [snapshot({ phase: 'ready' })])
    expect(control.kind).toBe('forced-on')
  })

  it('is free when the matching session has ended', () => {
    const control = worktreeControl(folder({ path: '/home/you/src/widgets' }), [snapshot({ phase: 'ended' })])
    expect(control.kind).toBe('free')
  })

  it('is free when the matching session is itself a worktree session', () => {
    const control = worktreeControl(
      folder({ path: '/home/you/src/widgets' }),
      [snapshot({ workspace: { folder: '/home/you/src/widgets/.claude/worktrees/x', root: '/home/you/src/widgets', worktree: { path: 'x', branch: 'session/x' }, base: null } })],
    )
    expect(control.kind).toBe('free')
  })

  it('matches a trailing slash or a Windows drive-case difference', () => {
    expect(worktreeControl(folder({ path: 'C:\\src\\widgets' }), [snapshot({ workspace: { folder: 'c:\\src\\widgets\\', root: null, worktree: null, base: null } })]).kind).toBe('forced-on')
    expect(worktreeControl(folder({ path: '/home/you/src/widgets/' }), [snapshot({ workspace: { folder: '/home/you/src/widgets', root: null, worktree: null, base: null } })]).kind).toBe('forced-on')
  })
})

describe('effectiveWorktree', () => {
  it('is always true when forced on', () => {
    expect(effectiveWorktree({ kind: 'forced-on', reason: '' }, false, false)).toBe(true)
  })

  it('is always false when disabled off', () => {
    expect(effectiveWorktree({ kind: 'disabled-off', reason: '' }, true, true)).toBe(false)
  })

  it('follows the user toggle or a busy override when free', () => {
    expect(effectiveWorktree({ kind: 'free' }, false, false)).toBe(false)
    expect(effectiveWorktree({ kind: 'free' }, true, false)).toBe(true)
    expect(effectiveWorktree({ kind: 'free' }, false, true)).toBe(true)
  })
})

describe('worktreeHint', () => {
  it('names the branch and a 7-char short sha', () => {
    expect(worktreeHint(folder({ git: { root: '/x', head: { sha: '3eb526cdef', branch: 'dev' } } }))).toBe('Branches from dev (3eb526c) into its own folder.')
  })

  it('drops the branch clause for a detached HEAD', () => {
    expect(worktreeHint(folder({ git: { root: '/x', head: { sha: '3eb526cdef', branch: null } } }))).toBe('Branches from 3eb526c into its own folder.')
  })

  it('is null for a non-git folder', () => {
    expect(worktreeHint(folder({ git: null }))).toBeNull()
  })
})
