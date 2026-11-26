import { describe, expect, it, vi } from 'vitest'
import { createHostedStore } from '@/main/sessions/hosting/store'
import type { HostedQuery } from '@/main/sessions/hosting/handle'
import type { SessionWorkspace } from '@/types/workspace'
import { REPO_ID, flush, hostingCtx, sdkWith, storeOptions } from '../../../../fixtures/hosting/store'

const WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: { path: '/repo', branch: 'session/shared' }, base: null }

async function startedWithId(renameSession: () => Promise<void>) {
  const box: { deliver: ((message: unknown) => void) | null } = { deliver: null }
  const query = (): HostedQuery =>
    ({
      interrupt: vi.fn(),
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>((resolve) => (box.deliver = (message) => resolve({ done: false, value: message }))) }
      },
    }) as unknown as HostedQuery
  const store = createHostedStore(hostingCtx({ sdk: sdkWith(query, renameSession) }), storeOptions())
  const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
  if (!started.ok) throw new Error('unreachable')
  box.deliver?.({ type: 'system', subtype: 'init', session_id: 'claude-1' })
  await flush()
  return { store, sessionKey: started.snapshot.sessionKey }
}

describe('createHostedStore rename()', () => {
  it('reports unknown-session and not-ready before renaming on disk', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    const key = 'hosted-999' as import('@/types/hosting').SessionKey
    await expect(store.rename(key, 'New title')).resolves.toEqual({ ok: false, kind: 'unknown-session' })
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await expect(store.rename(started.snapshot.sessionKey, 'New title')).resolves.toEqual({ ok: false, kind: 'not-ready' })
  })

  it('renames on disk then applies the title to the handle', async () => {
    const renameSession = vi.fn(() => Promise.resolve())
    const { store, sessionKey } = await startedWithId(renameSession)
    await expect(store.rename(sessionKey, 'New title')).resolves.toEqual({ ok: true })
    expect(renameSession).toHaveBeenCalledWith('claude-1', 'New title', { dir: '/repo' })
    expect(store.attach(sessionKey)).toMatchObject({ snapshot: { title: 'New title' } })
  })

  it('reports rename-failed and leaves the title unchanged on a rejection', async () => {
    const { store, sessionKey } = await startedWithId(() => Promise.reject(new Error('disk full')))
    await expect(store.rename(sessionKey, 'New title')).resolves.toEqual({ ok: false, kind: 'rename-failed', message: 'disk full' })
    expect(store.attach(sessionKey)).toMatchObject({ snapshot: { title: null } })
  })
})
