import { describe, expect, it, vi } from 'vitest'
import { createRunStateStore } from '@/main/pipeline/state/run-state'
import { createPipelineStateStore } from '@/main/pipeline/state/store'
import type { FileResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { AT } from '../../../support/state-store'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const PATH = '/data/state.json'

function rig(options: { readonly file?: FileResult<unknown>; readonly writeFails?: boolean } = {}) {
  const writes: unknown[] = []
  const store = createPipelineStateStore({
    path: PATH,
    legacy: { dispatch: '/data/dispatch.json', sessions: '/data/stage-sessions.json', denials: '/data/stage-denials.json' },
    readJson: <T>() => Promise.resolve((options.file ?? { ok: false, kind: 'not-found', message: 'missing' }) as FileResult<T>),
    writeJsonAtomic: (_path, value) => {
      if (options.writeFails === true) return Promise.resolve({ ok: false, kind: 'io', message: 'disk full' })
      writes.push(value)
      return Promise.resolve({ ok: true, value: undefined })
    },
    remove: () => Promise.resolve({ ok: true, value: undefined }),
    now: () => new Date(AT),
  })
  return { runStates: createRunStateStore(store, PATH), store, writes }
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

describe('createRunStateStore', () => {
  it('reads every repository paused, with no since, until one is set — and before the file is read', async () => {
    const { runStates, store } = rig()
    expect(runStates.status()).toEqual({ kind: 'unread' })
    expect(runStates.current(A)).toEqual({ repoId: A, state: 'paused', since: null })
    await store.ready
    expect(runStates.status()).toEqual({ kind: 'loaded' })
    expect(runStates.snapshot([A, B])).toEqual({ store: { kind: 'loaded' }, repositories: [{ repoId: A, state: 'paused', since: null }, { repoId: B, state: 'paused', since: null }] })
  })

  it('writes a set into the dispatch section of the file, and a restart reads it back', async () => {
    const first = rig()
    await first.store.ready
    expect(await first.runStates.set([A, B], 'dispatching', AT)).toEqual({ ok: true })
    expect(first.writes.at(-1)).toMatchObject({ version: 3, dispatch: { [A]: { state: 'dispatching', since: AT }, [B]: { state: 'dispatching', since: AT } } })

    const restarted = rig({ file: { ok: true, value: first.writes.at(-1) } })
    await restarted.store.ready
    expect(restarted.runStates.current(B)).toEqual({ repoId: B, state: 'dispatching', since: AT })
  })

  it('refuses run and drain while the file is unreadable, and pause needs no write', async () => {
    const error = quiet()
    const { runStates, store, writes } = rig({ file: { ok: false, kind: 'io', message: 'denied' } })
    await store.ready
    expect(runStates.status()).toMatchObject({ kind: 'unreadable', message: 'denied', path: PATH })
    expect(await runStates.set([A], 'dispatching', AT)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await runStates.set([A], 'draining', AT)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await runStates.set([A], 'paused', AT)).toEqual({ ok: true })
    expect(runStates.current(A).state).toBe('paused')
    expect(writes).toEqual([])
    error.mockRestore()
  })

  it('a failed run write changes nothing, while a failed pause or drain still applies in memory', async () => {
    const { runStates, store } = rig({ writeFails: true })
    await store.ready
    expect(await runStates.set([A], 'dispatching', AT)).toEqual({ ok: false, reason: 'unwritable', message: 'disk full' })
    expect(runStates.current(A).state).toBe('paused')
    expect(await runStates.set([A], 'draining', AT)).toMatchObject({ ok: false, reason: 'unwritable' })
    expect(runStates.current(A)).toEqual({ repoId: A, state: 'draining', since: AT })
  })

  it('forgets a repository’s entry, and reports a missing one as already forgotten', async () => {
    const { runStates, store } = rig()
    await store.ready
    await runStates.set([A, B], 'dispatching', AT)
    expect(await runStates.forget(A)).toEqual({ ok: true })
    expect(runStates.current(A).state).toBe('paused')
    expect(runStates.current(B).state).toBe('dispatching')
    expect(await runStates.forget(A)).toEqual({ ok: true })
  })

  it('refuses to forget while the file is unreadable', async () => {
    const error = quiet()
    const { runStates, store } = rig({ file: { ok: false, kind: 'io', message: 'denied' } })
    await store.ready
    expect(await runStates.forget(A)).toMatchObject({ ok: false, reason: 'unreadable' })
    error.mockRestore()
  })
})
