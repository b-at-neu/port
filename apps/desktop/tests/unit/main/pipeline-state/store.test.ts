import { describe, expect, it, vi } from 'vitest'
import { createPipelineStateStore } from '@/main/pipeline/state/store'
import type { TicketEvent } from '@/types/stage-labels'
import type { FileResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import v1 from '../../../fixtures/pipeline-state/v1.json'
import { reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { AT, memoryStore } from '../../../support/state-store'
import { ticketOf } from '../../../support/tickets'

const REPO = 'repo-a' as RepoId
const READY = repositoryState([reconciledItem({ number: 7, matchedKeys: ['marker', 'ready'] })])
const ISSUE = { kind: 'issue' as const, number: 7 }
const CLAIM: TicketEvent = { kind: 'claim', stage: 'plan' }

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

describe('createPipelineStateStore — loading', () => {
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

  it('loads a version-1 file as version 2, and writes the migrated file back', async () => {
    const { store, writes } = rig({ file: { ok: true, value: v1 } })
    await store.ready
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ version: 2, repositories: { 'repo-a': { tickets: { '101': { pr: { number: 201 } } } } } })
    expect(store.ticket('repo-a' as RepoId, { kind: 'pull-request', number: 201 })?.ticket).toBe(101)
    expect(store.tracked('repo-b' as RepoId)?.map((ref) => ref.number)).toEqual([5, 6, 7])
  })

  it('reads a version-1 file that cannot be migrated as empty, and leaves it unwritten', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { store, writes } = rig({ file: { ok: true, value: { version: 1, repositories: 'junk' } } })
    await store.ready
    expect(store.view(REPO)).toEqual({ kind: 'unseeded' })
    expect(writes).toEqual([])
    error.mockRestore()
  })
})

describe('createPipelineStateStore — apply', () => {
  const queued = () => ticketOf({ ticket: 7, repo: REPO })

  it('commits an event to disk before reporting it applied, and bumps rev', async () => {
    const { store, writes } = memoryStore(REPO, { tickets: [queued()] })
    await store.ready
    const result = await store.apply(REPO, ISSUE, CLAIM, 0)
    expect(result).toMatchObject({ ok: true, changed: true, ticket: { rev: 1, status: { kind: 'running' } } })
    expect(writes).toHaveLength(1)
    expect(store.ticket(REPO, ISSUE)?.rev).toBe(1)
  })

  it('refuses a stale rev without writing, and never interleaves two events', async () => {
    const { store, writes } = memoryStore(REPO, { tickets: [queued()] })
    const [first, second] = await Promise.all([store.apply(REPO, ISSUE, CLAIM, 0), store.apply(REPO, ISSUE, CLAIM, 0)])
    expect(first).toMatchObject({ ok: true, changed: true })
    expect(second).toEqual({ ok: false, reason: 'stale' })
    expect(writes).toHaveLength(1)
  })

  it('skips the rev check when the caller holds none, and the table still refuses a running ticket', async () => {
    const { store } = memoryStore(REPO, { tickets: [queued()] })
    await store.apply(REPO, ISSUE, CLAIM, null)
    expect(await store.apply(REPO, ISSUE, CLAIM, null)).toEqual({ ok: false, reason: 'moved' })
  })

  it('reports persist-failed and leaves memory unchanged when the write fails', async () => {
    const { store } = memoryStore(REPO, { tickets: [queued()], persistFails: true })
    expect(await store.apply(REPO, ISSUE, CLAIM, 0)).toEqual({ ok: false, reason: 'persist-failed', message: 'disk full' })
    expect(store.ticket(REPO, ISSUE)).toMatchObject({ rev: 0, status: { kind: 'queued' } })
  })

  it('refuses an event on a repository it does not hold', async () => {
    const { store } = memoryStore(REPO, { tickets: null })
    expect(await store.apply(REPO, ISSUE, CLAIM, null)).toEqual({ ok: false, reason: 'unseeded' })
  })

  it('reports no change, and writes nothing, for an event that lands where the ticket already is', async () => {
    const { store, writes } = memoryStore(REPO, { tickets: [queued()] })
    const labels: TicketEvent = { kind: 'labels', itemKind: 'issue', add: ['ready'], remove: [], expect: { present: [], absent: [] }, action: 'noop', issue: null }
    expect(await store.apply(REPO, ISSUE, labels, null)).toMatchObject({ ok: true, changed: false })
    expect(writes).toEqual([])
  })
})

describe('createPipelineStateStore — mirror failures and pruning', () => {
  it('records a mirror failure on the ticket and persists it once, and ignores a missing ticket', async () => {
    const { store, writes } = rig()
    await store.seed(REPO, READY)
    const failure = { at: AT, outcome: { kind: 'item-unavailable' as const } }
    writes.length = 0
    await store.recordMirror(REPO, ISSUE, failure)
    expect(store.tickets(REPO)?.[0]?.mirror.failure).toEqual(failure)
    expect(writes).toHaveLength(1)
    await store.recordMirror(REPO, ISSUE, failure)
    await store.recordMirror(REPO, { kind: 'issue', number: 99 }, failure)
    expect(writes).toHaveLength(1)
    await store.recordMirror(REPO, ISSUE, null)
    expect(store.tickets(REPO)?.[0]?.mirror.failure).toBeNull()
  })

  it('prunes closed tickets and tracks the rest', async () => {
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
    expect(store.tickets(REPO)).toBeNull()
    await store.seed(REPO, READY)
    expect(store.view(REPO).kind).toBe('store')
  })
})
