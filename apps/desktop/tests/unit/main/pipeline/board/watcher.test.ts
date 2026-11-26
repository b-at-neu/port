import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { GitHubHttpResult, GitHubRequest } from '@/types/platform'
import type { BoardSnapshot } from '@/types/board'
import { httpOk, queryOf } from '../../../../fixtures/github-http'
import { EMPTY_PIPELINE_BODY, RATE_LIMIT_REPLY, connection } from '../../../../fixtures/pipeline-reply'
import { queuedAt, ticketAt } from '../../../../support/tickets'
import { fakeGit, readyEntry, readyItemTransport, scriptedConditional, watcherRig, type WatcherRigOptions } from '../../../../fixtures/watcher-harness'

function makeSnapshotWaiter(): { readonly onSnapshot: (snapshot: BoardSnapshot) => void; readonly next: () => Promise<BoardSnapshot> } {
  let resolvers: ((snapshot: BoardSnapshot) => void)[] = []
  return {
    onSnapshot: (snapshot) => {
      const current = resolvers
      resolvers = []
      for (const resolve of current) resolve(snapshot)
    },
    next: () => new Promise((resolve) => resolvers.push(resolve)),
  }
}

const rootEntry = async (): Promise<RepositoryEntry> => readyEntry('repo-a', await mkdtemp(join(tmpdir(), 'port-watcher-')), 'o/a')

async function rigOn(options: WatcherRigOptions = {}) {
  return watcherRig({ repositories: [await rootEntry()], ...options })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createPipelineWatcher — cadence', () => {
  it('a cheap source ticks four times while GitHub ticks once', async () => {
    const gitCounts = { worktreeList: 0 }
    let ghCalls = 0
    const rig = await rigOn({
      git: fakeGit(gitCounts),
      github: (request) => {
        if (!queryOf(request).includes('integrationHistory:')) ghCalls += 1
        return Promise.resolve(httpOk(EMPTY_PIPELINE_BODY))
      },
    })
    const waiter = makeSnapshotWaiter()
    const watcher = rig.watch({ onSnapshot: waiter.onSnapshot })

    // The initial refresh reads every source once, from a cold cache.
    await watcher.refresh()
    gitCounts.worktreeList = 0
    ghCalls = 0

    for (let i = 0; i < 4; i++) {
      const p = waiter.next()
      rig.clock.advance(15_000)
      rig.timer.fire()
      await p
    }

    expect(gitCounts.worktreeList).toBe(4)
    expect(ghCalls).toBe(1)
  })
})

describe('createPipelineWatcher — budgeted interval', () => {
  it.each([
    { cost: 73, expected: 315_360 },
    { cost: 1, expected: 60_000 },
  ])('a poll costing $cost stretches the GitHub interval to $expected ms', async ({ cost, expected }) => {
    // Three round trips per poll (sweep, detail, then the integration history) each report the cost, so a poll costs three times it.
    const rig = await rigOn({ github: readyItemTransport('op', ['op'], { ...RATE_LIMIT_REPLY, cost, resetAt: '2026-01-01T00:00:10Z' }) })
    const watcher = rig.watch()
    const snap = await watcher.refresh()
    watcher.stop()
    expect(snap.health[0]?.github.intervalMs).toBe(expected)
  })
})

/** A watcher whose first `gh` call answers at once and every later one hangs until the test releases it by hand. */
async function watcherWithHungReads() {
  const hung: (() => void)[] = []
  let ghCalls = 0
  const github = (request: GitHubRequest): Promise<GitHubHttpResult> => {
    if (queryOf(request).includes('integrationHistory:')) return Promise.resolve(httpOk(EMPTY_PIPELINE_BODY))
    ghCalls += 1
    if (ghCalls === 1) return Promise.resolve(httpOk(EMPTY_PIPELINE_BODY))
    return new Promise((resolve) => {
      hung.push(() => resolve(httpOk(EMPTY_PIPELINE_BODY)))
    })
  }
  const rig = await rigOn({ github })
  const watcher = rig.watch()
  // Prime every source once, so the race in each test is isolated to `github` alone.
  await watcher.refresh()
  return { rig, watcher, release: (index: number) => hung[index]?.(), calls: () => ghCalls }
}

describe('createPipelineWatcher — in-flight reads', () => {
  it('two forced github refreshes during a hung read share exactly one follow-up read', async () => {
    const { watcher, release, calls } = await watcherWithHungReads()
    expect(calls()).toBe(1)

    const p1 = watcher.refresh({ source: 'github' })
    const p2 = watcher.refresh({ source: 'github' })
    await flush()
    expect(calls()).toBe(2)

    release(0)
    await flush()
    expect(calls()).toBe(3)

    release(1)
    await Promise.all([p1, p2])
    expect(calls()).toBe(3)
  })

  it('an unforced due read during a hung read still skips', async () => {
    const { rig, watcher, release, calls } = await watcherWithHungReads()

    rig.clock.advance(60_000)
    rig.timer.fire()
    // The due local reads run first, so the hung github read starts a few turns later.
    for (let turn = 0; turn < 50 && calls() < 2; turn++) await flush()
    expect(calls()).toBe(2)

    await watcher.refresh({ source: 'worktrees' })
    expect(calls()).toBe(2)

    release(0)
    await flush()
    expect(calls()).toBe(2)
  })
})

describe('createPipelineWatcher — rate-limit deferral', () => {
  it('a forced github refresh makes no gh call while the repository is deferred', async () => {
    let ghCalls = 0
    const limited = JSON.stringify({ data: { repository: { issues: connection([]), pullRequests: connection([]) }, rateLimit: { ...RATE_LIMIT_REPLY, remaining: 10, resetAt: '2026-01-01T01:00:00Z' } } })
    const rig = await rigOn({
      github: () => {
        ghCalls += 1
        return Promise.resolve(httpOk(limited))
      },
    })
    const watcher = rig.watch()

    const first = await watcher.refresh()
    expect(first.health[0]?.github.deferredUntil).toBe('2026-01-01T01:00:00Z')
    // The sweep, then the integration history.
    expect(ghCalls).toBe(2)

    await watcher.refresh({ repoId: 'repo-a' as RepositoryEntry['id'], source: 'github' })
    expect(ghCalls).toBe(2)
  })
})

describe('createPipelineWatcher — refresh() bypasses backoff', () => {
  it('forces an immediate re-read of the named source even though its interval has not elapsed', async () => {
    const gitCounts = { worktreeList: 0 }
    const rig = await rigOn({ git: fakeGit(gitCounts), github: () => Promise.resolve(httpOk(EMPTY_PIPELINE_BODY)) })
    const watcher = rig.watch()

    await watcher.refresh()
    const afterFirst = gitCounts.worktreeList
    expect(afterFirst).toBeGreaterThan(0)

    await watcher.refresh({ repoId: 'repo-a' as RepositoryEntry['id'], source: 'worktrees' })
    expect(gitCounts.worktreeList).toBe(afterFirst + 1)
  })
})

describe('createPipelineWatcher — stop()', () => {
  it('makes every later callback a no-op, and leaves no wakeup on the snapshot', async () => {
    const gitCounts = { worktreeList: 0 }
    const rig = await rigOn({ git: fakeGit(gitCounts), github: () => Promise.resolve(httpOk(EMPTY_PIPELINE_BODY)) })
    const watcher = rig.watch()

    const before = await watcher.refresh()
    expect(rig.timer.isScheduled()).toBe(true)
    expect(before.nextWakeupAt).not.toBeNull()

    watcher.stop()
    expect(rig.timer.isScheduled()).toBe(false)
    expect(watcher.snapshot().nextWakeupAt).toBeNull()

    rig.timer.fire() // no scheduled callback — a no-op
    const reads = gitCounts.worktreeList
    const snap = await watcher.refresh()
    expect(gitCounts.worktreeList).toBe(reads)
    expect(snap).toBe(watcher.snapshot())
  })
})

describe('createPipelineWatcher — registry re-list', () => {
  const sources = () => ({ github: () => Promise.resolve(httpOk(EMPTY_PIPELINE_BODY)), conditional: scriptedConditional().transport })

  it('a repository added between ticks appears on the board without a restart', async () => {
    const entryA = await rootEntry()
    const entryB = readyEntry('repo-b', await mkdtemp(join(tmpdir(), 'port-watcher-b-')), 'o/b')
    let listed: readonly RepositoryEntry[] = [entryA]
    const rig = watcherRig({ ...sources(), repos: { list: () => Promise.resolve({ ok: true as const, repositories: listed }) } })
    const waiter = makeSnapshotWaiter()
    const watcher = rig.watch({ onSnapshot: waiter.onSnapshot })

    const first = await watcher.refresh()
    expect(first.state.repositories).toHaveLength(1)

    listed = [entryA, entryB]
    const p = waiter.next()
    rig.clock.advance(60_000) // the GitHub cadence, which re-lists the registry
    rig.timer.fire()
    expect((await p).state.repositories).toHaveLength(2)
  })

  it('reads an unlistable registry as no repositories', async () => {
    const rig = watcherRig({ ...sources(), repos: { list: () => Promise.resolve({ ok: false as const, kind: 'registry-unreadable' as never, message: 'boom' }) } })
    const snap = await rig.watch().refresh()
    expect(snap.state.repositories).toEqual([])
  })

  describe('the fresh flag', () => {
    async function setup() {
      const entry = await rootEntry()
      const fresh: boolean[] = []
      const rig = watcherRig({
        ...sources(),
        repos: {
          list: (options) => {
            fresh.push(options?.fresh === true)
            return Promise.resolve({ ok: true as const, repositories: [entry] })
          },
        },
      })
      const waiter = makeSnapshotWaiter()
      return { rig, watcher: rig.watch({ onSnapshot: waiter.onSnapshot }), waiter, fresh }
    }

    it('the timer tick is not fresh', async () => {
      const { rig, watcher, waiter, fresh } = await setup()
      await watcher.refresh({ source: 'worktrees' })
      fresh.length = 0
      const p = waiter.next()
      rig.clock.advance(60_000)
      rig.timer.fire()
      await p
      expect(fresh).toEqual([false])
    })

    it('refresh({}) and a github-scoped refresh are fresh', async () => {
      const { watcher, fresh } = await setup()
      await watcher.refresh({})
      await watcher.refresh({ repoId: 'repo-a' as RepositoryEntry['id'], source: 'github' })
      expect(fresh).toEqual([true, true])
    })

    it('a worktrees-scoped refresh does not force a fresh list', async () => {
      const { watcher, fresh } = await setup()
      await watcher.refresh({ source: 'worktrees' })
      await watcher.refresh({ source: 'worktrees' })
      expect(fresh).toEqual([false])
    })
  })
})

describe('createPipelineWatcher — tick wiring', () => {
  it.each([
    { name: 'carries a real ready repository through to an actionable dispatch', assignees: ['op'], actionable: [{ number: 42, kind: 'issue', stage: 'plan', trigger: 'ready', agent: 'plan', unchecked: false, cycle: null }], held: [] },
    { name: 'holds a ready item not assigned to the viewer, unowned, in the same TickReport', assignees: [], actionable: [], held: [{ number: 42, kind: 'issue', stage: 'plan', trigger: 'ready', reason: 'unowned', contention: null, escalation: null }] },
  ])('$name', async ({ assignees, actionable, held }) => {
    const rig = await rigOn({ github: readyItemTransport('op', assignees), tickets: { repoId: 'repo-a' as RepoId, tickets: [ticketAt('plan', queuedAt(), { repo: 'o/a' as Ticket['repo'], ticket: 42 })] } })
    const snap = await rig.watch().refresh()
    expect(snap.tick).toHaveLength(1)
    expect(snap.tick[0]?.repoId).toBe('repo-a')
    expect(snap.tick[0]?.blind).toBeNull()
    expect(snap.tick[0]?.actionable).toEqual(actionable)
    expect(snap.tick[0]?.held).toEqual(held)
  })

  it('fires onTick on a poll and not on republish()', async () => {
    const rig = await rigOn({ github: () => Promise.resolve(httpOk(EMPTY_PIPELINE_BODY)) })
    const onTick = vi.fn()
    const watcher = rig.watch({ onTick })
    await watcher.refresh()
    expect(onTick).toHaveBeenCalledTimes(1)
    watcher.republish()
    expect(onTick).toHaveBeenCalledTimes(1)
  })
})

describe('createPipelineWatcher — a failed projection', () => {
  it('keeps the previous snapshot, fires nothing, and still reschedules', async () => {
    let failing = false
    const rig = await rigOn({ engine: { project: (params) => (failing ? Promise.reject(new Error('worker stopped')) : rig.inner.project(params)) } })
    const onSnapshot = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const watcher = rig.watch({ onSnapshot })

    const good = await watcher.refresh()
    onSnapshot.mockClear()
    failing = true
    const kept = await watcher.refresh()
    watcher.stop()

    expect(kept).toBe(good)
    expect(watcher.snapshot().emittedAt).toBe(good.emittedAt)
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('[watcher] projection failed', expect.any(Error))
    error.mockRestore()
  })
})
