import { describe, expect, it, vi } from 'vitest'
import { resolveStartTarget } from './target'
import type { ResolveStartTargetDeps } from './target'
import { toFolderId } from './resolve'
import { pathOps } from '../platform/paths'
import type { RepositoryEntry } from '../../shared/repos'
import type { RepoId } from '../../shared/repos'

const REPO_PATH = '/home/you/src/widgets'
const REPO_ID = 'repo-1' as RepoId

function baseDeps(overrides: Partial<ResolveStartTargetDeps> = {}): ResolveStartTargetDeps {
  return {
    git: vi.fn(() => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a repository' })) as unknown as ResolveStartTargetDeps['git'],
    repositories: [{ id: REPO_ID, path: REPO_PATH, status: 'ready', config: {} } as unknown as RepositoryEntry],
    recents: { load: () => Promise.resolve([]), record: () => Promise.resolve() },
    exists: () => Promise.resolve(true),
    readSessions: () => Promise.resolve({ ok: true, sessions: [] }),
    createWorktree: () => Promise.resolve({ ok: false, message: 'should not be called' }),
    ...overrides,
  }
}

function folderIdFor(path: string): string {
  // Reuses the real `toFolderId`/`pathKey` so the test exercises the same platform-normalized
  // lookup `resolveFolderPath` performs against registry/recents paths.
  return toFolderId(pathOps.pathKey(path))
}

describe('resolveStartTarget', () => {
  it('throws for an unknown folderId', async () => {
    const deps = baseDeps()
    await expect(resolveStartTarget({ kind: 'folder', folderId: 'folder-bogus', worktree: false }, { kind: 'fresh' }, deps)).rejects.toThrow(/no folder registered/)
  })

  it('returns folder-missing for a registered folder that no longer exists', async () => {
    const deps = baseDeps({ exists: () => Promise.resolve(false) })
    const folderId = folderIdFor(REPO_PATH)
    const result = await resolveStartTarget({ kind: 'folder', folderId, worktree: false }, { kind: 'fresh' }, deps)
    expect(result).toEqual({ ok: false, kind: 'folder-missing', path: REPO_PATH })
  })

  it('returns not-git when worktree is requested on a non-git folder', async () => {
    const deps = baseDeps()
    const folderId = folderIdFor(REPO_PATH)
    const result = await resolveStartTarget({ kind: 'folder', folderId, worktree: true }, { kind: 'fresh' }, deps)
    expect(result).toEqual({ ok: false, kind: 'not-git' })
  })

  it('returns worktree-failed when creation fails', async () => {
    const git = vi.fn(() => Promise.resolve({ ok: true, stdout: '/home/you/src/widgets\n', stderr: '', code: 0 })) as unknown as ResolveStartTargetDeps['git']
    const deps = baseDeps({ git, createWorktree: () => Promise.resolve({ ok: false, message: 'collision' }) })
    const folderId = folderIdFor(REPO_PATH)
    const result = await resolveStartTarget({ kind: 'folder', folderId, worktree: true }, { kind: 'fresh' }, deps)
    expect(result).toEqual({ ok: false, kind: 'worktree-failed', message: 'collision' })
  })

  it('returns folder-missing with a null path for an unknown transcript', async () => {
    const deps = baseDeps()
    const result = await resolveStartTarget({ kind: 'transcript' }, { kind: 'resume', sessionId: 'unknown-1' }, deps)
    expect(result).toEqual({ ok: false, kind: 'folder-missing', path: null })
  })

  it('returns folder-missing with a null path for a transcript carrying no cwd', async () => {
    const deps = baseDeps({
      readSessions: () => Promise.resolve({ ok: true, sessions: [{ sessionId: 's1', summary: null, lastModified: 't', customTitle: null, firstPrompt: null, gitBranch: null, cwd: null }] }),
    })
    const result = await resolveStartTarget({ kind: 'transcript' }, { kind: 'resume', sessionId: 's1' }, deps)
    expect(result).toEqual({ ok: false, kind: 'folder-missing', path: null })
  })

  it('returns folder-missing with the path when a transcript cwd no longer exists', async () => {
    const deps = baseDeps({
      exists: () => Promise.resolve(false),
      readSessions: () => Promise.resolve({ ok: true, sessions: [{ sessionId: 's1', summary: null, lastModified: 't', customTitle: null, firstPrompt: null, gitBranch: null, cwd: '/gone' }] }),
    })
    const result = await resolveStartTarget({ kind: 'transcript' }, { kind: 'resume', sessionId: 's1' }, deps)
    expect(result).toEqual({ ok: false, kind: 'folder-missing', path: '/gone' })
  })
})
