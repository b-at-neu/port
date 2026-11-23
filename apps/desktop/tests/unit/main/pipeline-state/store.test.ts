import { describe, expect, it, vi } from 'vitest'
import { createPipelineStateStore } from '@/main/pipeline/state/store'
import type { TransitionInput } from '@/types/pipeline-state'
import type { FileResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { reconciledItem, repositoryState } from '../../../fixtures/board-state'

const REPO = 'repo-a' as RepoId
const AT = '2026-01-01T00:00:00.000Z'
const READY = repositoryState([reconciledItem({ number: 7, matchedKeys: ['marker', 'ready'] })])

function input(overrides: Partial<TransitionInput> = {}): TransitionInput {
  return { add: ['planning'], remove: ['ready'], expect: { present: ['ready'], absent: [] }, action: 'stage-claim', at: AT, actor: null, issue: null, ...overrides }
}

function rig(options: { readonly file?: FileResult<unknown>; readonly write?: () => Promise<FileResult<void>> } = {}) {
  const writes: unknown[] = []
  const store = createPipelineStateStore({
    path: '/data/state.json',
    readJson: <T>() => Promise.resolve((options.file ?? { ok: false, kind: 'not-found', message: 'missing' }) as FileResult<T>),
    writeJsonAtomic: (_path, value) => {
      writes.push(value)
      return options.write?.() ?? Promise.resolve({ ok: true, value: undefined })
    },
    now: () => new Date(AT),
  })
  return { store, writes }
}

describe('createPipelineStateStore', () => {
  it('starts empty on a missing, malformed or newer-version file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const file of [undefined, { ok: true as const, value: '{' }, { ok: true as const, value: { version: 9, repositories: {} } }, { ok: false as const, kind: 'io' as const, message: 'denied' }]) {
      const { store } = rig({ file })
      await store.ready
      expect(store.view(REPO)).toEqual({ kind: 'unseeded' })
    }
    error.mockRestore()
  })

  it('is unseeded until a repository is seeded, then the store, which survives a restart', async () => {
    const first = rig()
    await first.store.seed(REPO, READY)
    expect(first.store.view(REPO)).toMatchObject({ kind: 'store', items: [{ number: 7, keys: ['ready'] }] })

    const restarted = rig({ file: { ok: true, value: first.writes.at(-1) } })
    await restarted.store.ready
    expect(restarted.store.view(REPO)).toMatchObject({ kind: 'store', items: [{ number: 7, keys: ['ready'] }] })
  })

  it('commits a transition to disk before reporting it applied', async () => {
    const { store, writes } = rig()
    await store.seed(REPO, READY)
    writes.length = 0
    expect(await store.transition(REPO, { kind: 'issue', number: 7 }, input())).toEqual({ ok: true, changed: true })
    expect(writes).toHaveLength(1)
    expect(store.view(REPO)).toMatchObject({ items: [{ keys: ['planning'] }] })
  })

  it('reports persist-failed and leaves memory unchanged when the write fails', async () => {
    const { store } = rig({ write: () => Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }) })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await store.seed(REPO, READY)
    expect(await store.transition(REPO, { kind: 'issue', number: 7 }, input())).toEqual({ ok: false, reason: 'persist-failed', message: 'disk full' })
    expect(store.view(REPO)).toMatchObject({ items: [{ keys: ['ready'] }] })
    error.mockRestore()
  })

  it('refuses a stale precondition without writing, and never interleaves two transitions', async () => {
    const { store, writes } = rig()
    await store.seed(REPO, READY)
    writes.length = 0
    const [first, second] = await Promise.all([store.transition(REPO, { kind: 'issue', number: 7 }, input()), store.transition(REPO, { kind: 'issue', number: 7 }, input())])
    expect(first).toEqual({ ok: true, changed: true })
    expect(second).toEqual({ ok: false, reason: 'precondition-failed' })
    expect(writes).toHaveLength(1)
  })

  it('refuses a transition on a repository it does not hold', async () => {
    const { store } = rig()
    expect(await store.transition(REPO, { kind: 'issue', number: 7 }, input())).toEqual({ ok: false, reason: 'precondition-failed' })
  })

  it('records a mirror failure on the item and persists it, and ignores a missing item', async () => {
    const { store, writes } = rig()
    await store.seed(REPO, READY)
    const failure = { at: AT, outcome: { kind: 'item-unavailable' as const } }
    writes.length = 0
    await store.recordMirror(REPO, { kind: 'issue', number: 7 }, failure)
    expect(store.view(REPO)).toMatchObject({ items: [{ mirrorFailure: failure }] })
    expect(writes).toHaveLength(1)
    await store.recordMirror(REPO, { kind: 'issue', number: 7 }, failure)
    await store.recordMirror(REPO, { kind: 'issue', number: 99 }, failure)
    expect(writes).toHaveLength(1)
    await store.recordMirror(REPO, { kind: 'issue', number: 7 }, null)
    expect(store.view(REPO)).toMatchObject({ items: [{ mirrorFailure: null }] })
  })

  it('prunes closed items and tracks the rest', async () => {
    const { store } = rig()
    await store.seed(REPO, repositoryState([reconciledItem({ number: 1 }), reconciledItem({ number: 2 })]))
    await store.prune(REPO, [1])
    expect(store.tracked(REPO)?.map((ref) => ref.number)).toEqual([2])
  })

  it('views and tracks nothing for a repository it was never seeded with', async () => {
    const { store } = rig()
    await store.ready
    expect(store.view(REPO)).toEqual({ kind: 'unseeded' })
    expect(store.tracked(REPO)).toBeNull()
    await store.seed(REPO, READY)
    expect(store.view(REPO).kind).toBe('store')
  })
})
