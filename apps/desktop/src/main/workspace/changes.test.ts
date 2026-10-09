import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform/run'
import type { GitRunner } from '../platform/git'
import type { SessionWorkspace } from '../../shared/workspace/types'
import { computeSessionChanges } from './changes'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NONZERO = (stderr = 'fatal'): CommandResult => ({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr })
const CWD_MISSING: CommandResult = { ok: false, kind: 'cwd-missing', cwd: '/gone' }
const TOO_LARGE: CommandResult = { ok: false, kind: 'output-too-large', maxBytes: 2_000_000 }

const NON_GIT_WORKSPACE: SessionWorkspace = { folder: '/tmp/plain', root: null, worktree: null, base: null }
const NO_BASE_WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }

function workspaceWithBase(sha = 'abc123'): SessionWorkspace {
  return { folder: '/repo', root: '/repo', worktree: null, base: { sha, label: 'main' } }
}

function fakeGit(overrides: Partial<Record<string, (args: readonly string[]) => CommandResult>>): GitRunner {
  return (args) => {
    const key = args[0] ?? ''
    const sub = args.slice(0, 2).join(' ')
    const handler = overrides[sub] ?? overrides[key]
    if (handler) return Promise.resolve(handler(args))
    return Promise.resolve(ok(''))
  }
}

describe('computeSessionChanges', () => {
  it('reports not-git without any git call when root is null', async () => {
    const result = await computeSessionChanges(NON_GIT_WORKSPACE, { git: fakeGit({}) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('not-git')
  })

  it('reports base-missing when workspace.base is null', async () => {
    const result = await computeSessionChanges(NO_BASE_WORKSPACE, { git: fakeGit({}) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('base-missing')
  })

  it('reports base-missing when the base commit is unreachable', async () => {
    const git = fakeGit({ 'cat-file -e': () => NONZERO() })
    const result = await computeSessionChanges(workspaceWithBase(), { git })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('base-missing')
  })

  it('reports folder-missing when the worktree directory no longer exists', async () => {
    const git = fakeGit({ 'cat-file -e': () => CWD_MISSING })
    const result = await computeSessionChanges(workspaceWithBase(), { git })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('folder-missing')
  })

  it('returns a full diff with untracked files on success', async () => {
    const diffOutput = ['diff --git a/a.ts b/a.ts', 'index aaa..bbb 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '+x', ''].join('\n')
    const git = fakeGit({
      'cat-file -e': () => ok(''),
      'ls-files --others': () => ok('untracked.txt\n'),
      diff: () => ok(diffOutput),
    })
    const result = await computeSessionChanges(workspaceWithBase(), { git })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(false)
    expect(result.files).toHaveLength(1)
    expect(result.untracked).toEqual(['untracked.txt'])
    expect(result.summary).toEqual([{ path: 'a.ts', additions: 1, deletions: 0 }])
  })

  it('falls back to --numstat on output-too-large, reporting truncated: true', async () => {
    const numstat = ['5\t2\tbig.ts', '-\t-\timage.png'].join('\n')
    const git = fakeGit({
      'cat-file -e': () => ok(''),
      'ls-files --others': () => ok(''),
      diff: (args) => (args.includes('--numstat') ? ok(numstat) : TOO_LARGE),
    })
    const result = await computeSessionChanges(workspaceWithBase(), { git })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.files).toEqual([])
    expect(result.summary).toEqual([{ path: 'big.ts', additions: 5, deletions: 2 }])
    expect(result.binary).toEqual(['image.png'])
  })

  it('reports git-failed when the numstat fallback itself fails', async () => {
    const git = fakeGit({
      'cat-file -e': () => ok(''),
      'ls-files --others': () => ok(''),
      diff: (args) => (args.includes('--numstat') ? NONZERO() : TOO_LARGE),
    })
    const result = await computeSessionChanges(workspaceWithBase(), { git })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('git-failed')
  })

  it('reports git-failed for any other diff failure', async () => {
    const git = fakeGit({
      'cat-file -e': () => ok(''),
      'ls-files --others': () => ok(''),
      diff: () => NONZERO('boom'),
    })
    const result = await computeSessionChanges(workspaceWithBase(), { git })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('git-failed')
  })
})
