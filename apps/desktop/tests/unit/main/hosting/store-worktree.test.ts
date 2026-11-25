// folder-busy and the worktree dismiss outcomes.
import { describe, expect, it } from 'vitest'
import { createHostedStore } from '@/main/sessions/hosting/store'
import type { SessionDismissResult, WorktreeChoice } from '@/types/hosting'
import type { CommandResult } from '@/types/platform'
import type { SessionWorkspace } from '@/types/workspace'
import { fakeGit } from '../../../support/fake-platform'
import { REPO_ID, endedQuery, flush, hostingCtx, sdkWith, storeOptions } from '../../../fixtures/hosting/store'

const PLAIN_WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }
const WORKTREE_WORKSPACE: SessionWorkspace = { folder: '/repo/.claude/worktrees/session-a', root: '/repo', worktree: { path: '/repo/.claude/worktrees/session-a', branch: 'session/a' }, base: null }

describe('createHostedStore — folder-busy', () => {
  it('refuses a second non-worktree start in the same folder', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    expect(second).toEqual({ ok: false, kind: 'folder-busy', sessionKey: first.snapshot.sessionKey })
  })

  it('already-open wins over folder-busy for a resume of a session already open in that folder', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: PLAIN_WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: PLAIN_WORKSPACE })
    expect(second).toEqual({ ok: false, kind: 'already-open', sessionKey: first.snapshot.sessionKey })
  })

  it('allows a non-worktree start once the first has ended, and in a different folder', async () => {
    const store = createHostedStore(hostingCtx({ sdk: sdkWith(endedQuery) }), storeOptions())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    await flush()
    expect((await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })).ok).toBe(true)

    const otherStore = createHostedStore(hostingCtx(), storeOptions())
    const otherFolder: SessionWorkspace = { folder: '/other', root: '/other', worktree: null, base: null }
    expect((await otherStore.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })).ok).toBe(true)
    expect((await otherStore.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: otherFolder })).ok).toBe(true)
  })

  it('allows a worktree session to start alongside a live non-worktree one in the same root', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    expect((await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })).ok).toBe(true)
    expect((await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })).ok).toBe(true)
  })
})

const REMOVED: CommandResult = { ok: true, stdout: '', stderr: '' }
const DIRTY: CommandResult = { ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: 'contains modified or untracked files, use --force to delete it' }
const FAILED: CommandResult = { ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: 'boom' }

describe('createHostedStore — dismiss worktree outcomes', () => {
  it.each<{ readonly name: string; readonly choice: WorktreeChoice; readonly git: CommandResult | null; readonly expected: SessionDismissResult; readonly remaining: number; readonly forced: boolean }>([
    { name: 'remove forgets the handle once the worktree is removed', choice: 'remove', git: REMOVED, expected: { ok: true }, remaining: 0, forced: false },
    { name: 'remove reports worktree-dirty and keeps the handle', choice: 'remove', git: DIRTY, expected: { ok: false, kind: 'worktree-dirty' }, remaining: 1, forced: false },
    { name: 'force passes --force and reports worktree-remove-failed with its message', choice: 'force', git: FAILED, expected: { ok: false, kind: 'worktree-remove-failed', message: 'boom' }, remaining: 1, forced: true },
    { name: 'keep forgets the handle without calling git, even for a worktree session', choice: 'keep', git: null, expected: { ok: true }, remaining: 0, forced: false },
  ])('$name', async ({ choice, git, expected, remaining, forced }) => {
    const removals: (readonly string[])[] = []
    const ctx = hostingCtx({
      sdk: sdkWith(endedQuery),
      git: fakeGit((args) => {
        if (args[0] === 'rev-parse') return Promise.resolve({ ok: true, stdout: '/repo/.git\n', stderr: '' })
        removals.push(args)
        if (git === null) throw new Error('git must not run for keep')
        return Promise.resolve(git)
      }),
    })
    const store = createHostedStore(ctx, storeOptions())
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await flush()

    expect(await store.dismiss(started.snapshot.sessionKey, choice)).toEqual(expected)
    expect(store.list()).toHaveLength(remaining)
    expect(removals.every((args) => args.includes('--force') === forced)).toBe(true)
    expect(removals).toHaveLength(git === null ? 0 : 1)
  })
})
