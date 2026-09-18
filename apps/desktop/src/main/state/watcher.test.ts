import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepositoryEntry } from '../../shared/repos'
import type { CommandResult, GhResult } from '../platform'
import type { BoardSnapshot } from '../../shared/board/types'
import { buildPipelineQuery } from '../github/query'
import { createPipelineWatcher } from './watcher'
import type { TimerFactory, TimerHandle } from './watcher'

const EMPTY_PIPELINE_STDOUT = JSON.stringify({ data: { repository: {}, rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' } } })

/** A real `fetchPipelineItems` reply carrying exactly one `ready`-labelled
 *  issue node, every other alias empty — built off the same
 *  `buildPipelineQuery` the adapter itself uses, so this fixture can never
 *  drift from the alias layout a real response actually carries (#105). */
function readyItemStdout(signedInLogin: string, assignees: readonly string[]): string {
  const { aliases } = buildPipelineQuery(resolveVocabulary({}))
  const repository: Record<string, unknown> = {}
  for (const alias of aliases) {
    const isReadyAlias = alias.key === 'ready'
    repository[alias.issueAlias] = isReadyAlias
      ? {
          totalCount: 1,
          nodes: [
            {
              number: 42,
              title: 'a ticket',
              url: 'https://github.com/o/a/issues/42',
              body: '',
              state: 'OPEN',
              assignees: { nodes: assignees.map((login) => ({ login })) },
              labels: { nodes: [{ name: 'ready' }] },
            },
          ],
        }
      : { totalCount: 0, nodes: [] }
    repository[alias.prAlias] = { totalCount: 0, nodes: [] }
  }
  repository.repoLabels = { totalCount: 0, nodes: [] }
  return JSON.stringify({
    data: { repository, rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' }, viewer: { login: signedInLogin } },
  })
}

function readyEntry(id: string, path: string, repo: string): Extract<RepositoryEntry, { status: 'ready' }> {
  return {
    id: id as RepositoryEntry['id'],
    path,
    displayName: repo,
    status: 'ready',
    config: {
      repo,
      owner: repo.split('/')[0] ?? '',
      name: repo.split('/')[1] ?? '',
      branches: { integration: 'dev', production: 'main' },
      commands: { worktrees: null },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: resolveVocabulary({}),
    },
    diagnostics: [],
  }
}

function fakeGit(counts: { worktreeList: number }): (args: readonly string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) => {
    const [cmd, sub] = args
    if (cmd === 'worktree' && sub === 'list') {
      counts.worktreeList += 1
      return Promise.resolve({ ok: true, stdout: `worktree ${cwd}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n`, stderr: '' })
    }
    if (cmd === 'config' && sub === '--get-regexp') return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
    if (cmd === 'log') return Promise.resolve({ ok: true, stdout: '', stderr: '' })
    if (cmd === 'rev-parse' && sub === '--git-common-dir') return Promise.resolve({ ok: true, stdout: '.git\n', stderr: '' })
    return Promise.resolve({ ok: true, stdout: '', stderr: '' })
  }
}

function makeFakeTimer(): { readonly factory: TimerFactory; readonly fire: () => void; readonly isScheduled: () => boolean } {
  let current: (() => void) | null = null
  return {
    factory: (callback: () => void): TimerHandle => {
      current = callback
      return { clear: () => { current = null } }
    },
    fire: () => {
      const cb = current
      current = null
      cb?.()
    },
    isScheduled: () => current !== null,
  }
}

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

describe('createPipelineWatcher — cadence', () => {
  it('a cheap source ticks four times while GitHub ticks once', async () => {
    let currentMs = Date.parse('2026-01-01T00:00:00.000Z')
    const now = () => new Date(currentMs)
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const gitCounts = { worktreeList: 0 }
    let ghCalls = 0
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit(gitCounts),
      gh: () => {
        ghCalls += 1
        return Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult)
      },
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    // The initial refresh reads every source once, from a cold cache.
    await watcher.refresh()
    gitCounts.worktreeList = 0
    ghCalls = 0

    for (let i = 0; i < 4; i++) {
      const p = waiter.next()
      currentMs += 15_000
      timer.fire()
      await p
    }

    expect(gitCounts.worktreeList).toBe(4)
    expect(ghCalls).toBe(1)
  })
})

describe('createPipelineWatcher — in-flight guard', () => {
  it('a tick firing during an outstanding read skips rather than stacks', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
    let ghCalls = 0
    const pending: { resolve: (() => void) | null } = { resolve: null }
    const gh = (): Promise<GhResult> => {
      ghCalls += 1
      // The very first call (priming the watcher below) resolves right
      // away; every call after that hangs until the test resolves it by
      // hand — the point of this test is what happens while one is still
      // outstanding.
      if (ghCalls === 1) return Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' })
      return new Promise((resolve) => {
        pending.resolve = () => resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' })
      })
    }

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit({ worktreeList: 0 }),
      gh,
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    // Prime every source once, so `now` being fixed means nothing but a
    // forced source is due for the rest of this test — the in-flight race
    // below is isolated to `github` alone.
    await watcher.refresh()
    expect(ghCalls).toBe(1)

    const p1 = watcher.refresh({ source: 'github' })
    const p2 = watcher.refresh({ source: 'github' })

    // Whichever of the two reaches the github read first performs it; the
    // other sees the in-flight key and skips its own read immediately.
    await p2
    expect(ghCalls).toBe(2)

    pending.resolve?.()
    await p1
    expect(ghCalls).toBe(2)
  })
})

describe('createPipelineWatcher — refresh() bypasses backoff, not the in-flight guard', () => {
  it('forces an immediate re-read of the named source even though its interval has not elapsed', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
    const gitCounts = { worktreeList: 0 }

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit(gitCounts),
      gh: () => Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    await watcher.refresh()
    const afterFirst = gitCounts.worktreeList
    expect(afterFirst).toBeGreaterThan(0)

    await watcher.refresh({ repoId: 'repo-a' as RepositoryEntry['id'], source: 'worktrees' })
    expect(gitCounts.worktreeList).toBe(afterFirst + 1)
  })
})

describe('createPipelineWatcher — stop()', () => {
  it('makes every later callback a no-op', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))
    const gitCounts = { worktreeList: 0 }

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit(gitCounts),
      gh: () => Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    await watcher.refresh()
    expect(timer.isScheduled()).toBe(true)

    watcher.stop()
    expect(timer.isScheduled()).toBe(false)

    timer.fire() // no scheduled callback — a no-op
    const before = gitCounts.worktreeList
    const snap = await watcher.refresh()
    expect(gitCounts.worktreeList).toBe(before)
    expect(snap).toBe(watcher.snapshot())
  })
})

describe('createPipelineWatcher — registry re-list', () => {
  it('a repository added between ticks appears on the board without a restart', async () => {
    let currentMs = Date.parse('2026-01-01T00:00:00.000Z')
    const now = () => new Date(currentMs)
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const rootA = await mkdtemp(join(tmpdir(), 'port-watcher-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'port-watcher-b-'))
    let repos: readonly RepositoryEntry[] = [readyEntry('repo-a', rootA, 'o/a')]

    const watcher = createPipelineWatcher({
      repositories: () => Promise.resolve(repos),
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit({ worktreeList: 0 }),
      gh: () => Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    const first = await watcher.refresh()
    expect(first.state.repositories).toHaveLength(1)

    repos = [readyEntry('repo-a', rootA, 'o/a'), readyEntry('repo-b', rootB, 'o/b')]
    const p = waiter.next()
    currentMs += 60_000 // the GitHub cadence, which re-lists the registry
    timer.fire()
    const second = await p

    expect(second.state.repositories).toHaveLength(2)
  })
})

describe('createPipelineWatcher — tick wiring (#105)', () => {
  it('buildSnapshot().tick carries a real ready repository through to an actionable dispatch', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit({ worktreeList: 0 }),
      gh: () => Promise.resolve({ ok: true, stdout: readyItemStdout('op', ['op']), stderr: '' } satisfies GhResult),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    const snap = await watcher.refresh()
    expect(snap.tick).toHaveLength(1)
    expect(snap.tick[0]?.repoId).toBe('repo-a')
    expect(snap.tick[0]?.blind).toBeNull()
    expect(snap.tick[0]?.actionable).toEqual([{ number: 42, kind: 'issue', trigger: 'ready', agent: 'plan' }])
    expect(snap.tick[0]?.held).toEqual([])
  })

  it('a ready item not assigned to the viewer is held, unowned, in the same TickReport', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit({ worktreeList: 0 }),
      gh: () => Promise.resolve({ ok: true, stdout: readyItemStdout('op', []), stderr: '' } satisfies GhResult),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    const snap = await watcher.refresh()
    expect(snap.tick[0]?.actionable).toEqual([])
    expect(snap.tick[0]?.held).toEqual([{ number: 42, kind: 'issue', trigger: 'ready', reason: 'unowned' }])
  })
})

describe('createPipelineWatcher — stop() and nextWakeupAt', () => {
  it('nextWakeupAt on the snapshot itself is null after stop(), not just the timer', async () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    const timer = makeFakeTimer()
    const waiter = makeSnapshotWaiter()
    const root = await mkdtemp(join(tmpdir(), 'port-watcher-'))

    const watcher = createPipelineWatcher({
      repositories: [readyEntry('repo-a', root, 'o/a')],
      onSnapshot: waiter.onSnapshot,
      now,
      setTimer: timer.factory,
      git: fakeGit({ worktreeList: 0 }),
      gh: () => Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })

    const before = await watcher.refresh()
    expect(before.nextWakeupAt).not.toBeNull()

    watcher.stop()
    expect(watcher.snapshot().nextWakeupAt).toBeNull()
  })
})
