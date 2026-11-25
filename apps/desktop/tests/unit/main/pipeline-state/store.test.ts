import { describe, expect, it, vi } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { createPipelineStateStore } from '@/main/pipeline/state/store'
import type { TicketEvent } from '@/types/stage-labels'
import type { FileResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import v1 from '../../../fixtures/pipeline-state/v1.json'
import dispatch from '../../../fixtures/pipeline-state/v2/dispatch.json'
import denials from '../../../fixtures/pipeline-state/v2/stage-denials.json'
import v2 from '../../../fixtures/pipeline-state/v2/pipeline-state.json'
import sessions from '../../../fixtures/pipeline-state/v2/stage-sessions.json'
import { reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { AT, memoryStore, STATE_PATH, storeCtx, USER_DATA } from '../../../support/state-store'
import { runOf, ticketOf } from '../../../support/tickets'

const REPO = 'repo-a' as RepoId
const READY = repositoryState([reconciledItem({ number: 7, matchedKeys: ['marker', 'ready'] })])
const ISSUE = { kind: 'issue' as const, number: 7 }
const CLAIM: TicketEvent = { kind: 'claim', stage: 'plan' }

const LEGACY = { dispatch: pathOps.join(USER_DATA, 'dispatch.json'), sessions: pathOps.join(USER_DATA, 'stage-sessions.json'), denials: pathOps.join(USER_DATA, 'stage-denials.json') }

interface RigOptions {
  readonly file?: FileResult<unknown>
  /** The raw JSON of an old run file, by path; a path left out is missing. */
  readonly legacy?: Readonly<Record<string, unknown>>
  readonly write?: () => Promise<FileResult<void>>
}

function rig(options: RigOptions = {}) {
  const writes: unknown[] = []
  const removed: string[] = []
  const store = createPipelineStateStore(
    storeCtx({
      readJson: <T>(path: string) => {
        if (path === STATE_PATH) return Promise.resolve((options.file ?? { ok: false, kind: 'not-found', message: 'missing' }) as FileResult<T>)
        const held = options.legacy?.[path]
        return Promise.resolve((held === undefined ? { ok: false, kind: 'not-found', message: 'missing' } : { ok: true, value: held }) as FileResult<T>)
      },
      writeJsonAtomic: (_path, value) => {
        writes.push(value)
        return options.write?.() ?? Promise.resolve({ ok: true, value: undefined })
      },
      remove: (path) => {
        removed.push(path)
        return Promise.resolve({ ok: true, value: undefined })
      },
    }),
  )
  return { store, writes, removed }
}

describe('createPipelineStateStore — loading', () => {
  it('starts empty on a missing, malformed or newer-version file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const file of [undefined, { ok: true as const, value: '{' }, { ok: true as const, value: { version: 9, dispatch: {}, repositories: {} } }, { ok: false as const, kind: 'io' as const, message: 'denied' }]) {
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

  it('loads a version-1 file as version 3, and writes the migrated file back', async () => {
    const { store, writes } = rig({ file: { ok: true, value: v1 } })
    await store.ready
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ version: 3, dispatch: {}, repositories: { 'repo-a': { tickets: { '101': { pr: { number: 201 } } } } } })
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

describe('createPipelineStateStore — version 2 and its run files', () => {
  const legacy = { [LEGACY.dispatch]: dispatch, [LEGACY.sessions]: sessions, [LEGACY.denials]: denials }

  it('loads them as version 3, and deletes the old files only once the new one is written', async () => {
    const { store, writes, removed } = rig({ file: { ok: true, value: v2 }, legacy })
    await store.ready
    expect(writes[0]).toMatchObject({ version: 3, dispatch: { 'repo-a': { state: 'dispatching' } } })
    expect(removed.sort()).toEqual(Object.values(LEGACY).sort())
    expect(store.runStates()['repo-b']).toMatchObject({ state: 'draining' })
    expect(store.ticket('repo-a' as RepoId, { kind: 'issue', number: 999 })?.runs.map((run) => run.id)).toEqual(['run-orphan'])
  })

  it('keeps the old files when the migrated file cannot be written back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { store, removed } = rig({ file: { ok: true, value: v2 }, legacy, write: () => Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }) })
    await store.ready
    expect(removed).toEqual([])
    error.mockRestore()
  })

  it('deletes nothing for a file already at version 3, or one that was never migrated', async () => {
    const written = rig({ file: { ok: true, value: v2 }, legacy })
    await written.store.ready
    const reload = rig({ file: { ok: true, value: written.writes[0] }, legacy })
    await reload.store.ready
    expect(reload.removed).toEqual([])
    const missing = rig({ legacy })
    await missing.store.ready
    expect(missing.removed).toEqual([])
  })

  it('marks a run that was open at boot crash, in one write after the migrated file', async () => {
    const { store, writes } = rig({ file: { ok: true, value: v2 }, legacy })
    await store.ready
    expect(writes).toHaveLength(2)
    expect(JSON.stringify(writes[0])).not.toContain('"crash"')
    expect(JSON.stringify(writes[1])).toContain('"crash"')
    expect(store.ticket('repo-a' as RepoId, { kind: 'issue', number: 101 })?.runs[0]).toMatchObject({ id: 'run-live', interruption: { reason: 'crash' } })
  })
})

describe('createPipelineStateStore — runs', () => {
  const claimed = () => ticketOf({ ticket: 7, repo: REPO, stage: 'implement', status: { kind: 'running', runId: null } })

  it('starts a run on its ticket, binds the claim, and applies a change to it by id', async () => {
    const { store, writes } = memoryStore(REPO, { tickets: [claimed()] })
    await store.ready
    expect(await store.startRun(REPO, runOf({ item: ISSUE }))).toMatchObject({ ok: true, ticket: { rev: 1, status: { runId: 'run-1' } } })
    expect(await store.applyRun(REPO, 'run-1', { kind: 'joined', at: AT })).toMatchObject({ ok: true, changed: true })
    expect(store.ticket(REPO, ISSUE)?.runs[0]?.operatorJoinedAt).toBe(AT)
    expect(writes).toHaveLength(2)
  })

  it('refuses a run for a ticket or a run it does not hold, and a repository it was never seeded with', async () => {
    const { store } = memoryStore(REPO, { tickets: [claimed()] })
    expect(await store.startRun(REPO, runOf({ item: { kind: 'issue', number: 99 } }))).toEqual({ ok: false, reason: 'moved' })
    expect(await store.applyRun(REPO, 'nope', { kind: 'cleared' })).toEqual({ ok: false, reason: 'moved' })
    expect(await store.applyRun('repo-z' as RepoId, 'run-1', { kind: 'cleared' })).toEqual({ ok: false, reason: 'unseeded' })
  })

  it('leaves memory unchanged when a run write fails', async () => {
    const { store } = memoryStore(REPO, { tickets: [claimed()], persistFails: true })
    expect(await store.startRun(REPO, runOf({ item: ISSUE }))).toEqual({ ok: false, reason: 'persist-failed', message: 'disk full' })
    expect(store.ticket(REPO, ISSUE)?.runs).toEqual([])
  })

  it('marks every open run quit in one write, and writes nothing when none is open', async () => {
    const { store, writes } = memoryStore(REPO, { tickets: [ticketOf({ ticket: 7, repo: REPO }), ticketOf({ ticket: 8, repo: REPO })] })
    await store.ready
    await store.startRun(REPO, runOf({ id: 'a', item: ISSUE }))
    await store.startRun(REPO, runOf({ id: 'b', item: ISSUE, endedAt: AT, outcome: 'completed' }))
    await store.startRun(REPO, runOf({ id: 'c', item: { kind: 'issue', number: 8 } }))
    writes.length = 0
    await store.quitRuns()
    expect(writes).toHaveLength(1)
    expect(store.allTickets().flatMap((ticket) => ticket.runs.map((run) => [run.id, run.interruption?.reason ?? null]))).toEqual([['a', 'quit'], ['b', null], ['c', 'quit']])
    await store.quitRuns()
    expect(writes).toHaveLength(1)
  })

  it('hands the boot’s unwritten hand-backs over once', async () => {
    const done = runOf({ id: 'run-1', endedAt: AT, outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' } })
    const { store } = memoryStore(REPO, { tickets: [ticketOf({ ticket: 7, repo: REPO, stage: 'implement', status: { kind: 'running', runId: 'run-1' }, runs: [done] })] })
    await store.ready
    expect(store.takeReplays(REPO).map((unsettled) => unsettled.run.id)).toEqual(['run-1'])
    expect(store.takeReplays(REPO)).toEqual([])
  })

  it('keeps the run state in the dispatch section, and writes it whole', async () => {
    const { store, writes } = memoryStore(REPO, { tickets: [] })
    await store.ready
    expect(await store.writeRunStates({ [REPO]: { state: 'paused', since: AT } })).toEqual({ ok: true, value: undefined })
    expect(store.runStates()).toEqual({ [REPO]: { state: 'paused', since: AT } })
    expect(writes.at(-1)).toMatchObject({ version: 3, dispatch: { [REPO]: { state: 'paused' } } })
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
