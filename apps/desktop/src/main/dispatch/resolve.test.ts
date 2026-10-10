import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { ReposListResponse } from '../../shared/ipc'
import type { BoardSnapshot } from '../../shared/board/types'
import type { HaltReport } from '../../shared/dispatch/types'
import type { RegistryDeps } from '../registry'
import type { ReadyEntry } from '../actions/apply'
import type { RunStateStore, SetRunStateResult } from './store'
import { registeredRepoIds, resolveDispatchControl } from './resolve'
import type { ResolveDispatchControlDeps } from './resolve'
import type { OwnershipWriteResult, TakeOwnershipResult } from './ownership'

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const REPO_ID = 'repo-a' as RepoId

const SNAPSHOT: BoardSnapshot = {
  state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' }, readAt: 't' },
  health: [],
  policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
  tick: [],
  runStates: { store: { kind: 'loaded' }, repositories: [] },
  nextWakeupAt: null,
  emittedAt: 't',
  dispatch: [],
}

async function readyEntry(path?: string): Promise<ReadyEntry> {
  return {
    id: REPO_ID,
    path: path ?? (await mkdtemp(join(tmpdir(), 'port-dispatch-resolve-'))),
    displayName: 'o/a',
    status: 'ready',
    config: {
      repo: 'o/a',
      owner: 'o',
      name: 'a',
      branches: { integration: 'dev', production: 'main' },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: resolveVocabulary({}),
    },
    diagnostics: [],
  }
}

function fakeRunStates(current: RunStateStore['current'], setResult: SetRunStateResult = { ok: true }): { readonly runStates: RunStateStore; readonly setCalls: (readonly [readonly RepoId[], string])[] } {
  const setCalls: (readonly [readonly RepoId[], string])[] = []
  const runStates: RunStateStore = {
    current,
    status: () => ({ kind: 'loaded' }),
    snapshot: () => ({ store: { kind: 'loaded' }, repositories: [] }),
    load: () => Promise.resolve(),
    set: (repoIds, state) => {
      setCalls.push([repoIds, state])
      return Promise.resolve(setResult)
    },
    forget: () => Promise.resolve({ ok: true }),
    path: '/userData/dispatch.json',
  }
  return { runStates, setCalls }
}

function depsWith(overrides: Partial<ResolveDispatchControlDeps> = {}): ResolveDispatchControlDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    runStates: fakeRunStates(() => ({ repoId: REPO_ID, state: 'paused', since: null })).runStates,
    haltDispatch: () => Promise.resolve({ kind: 'completed', items: [] } as HaltReport),
    takeOwnership: () => Promise.resolve({ ok: true, path: '/repo/.agents/cockpit.json' } as TakeOwnershipResult),
    releaseOwnership: () => Promise.resolve({ ok: true, path: '/repo/.agents/cockpit.json' } as OwnershipWriteResult),
    snapshot: () => SNAPSHOT,
    refresh: () => Promise.resolve(SNAPSHOT),
    auditDir: '/audit',
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('registeredRepoIds', () => {
  it('returns every registered id, any status', async () => {
    const entry = await readyEntry()
    const ids = await registeredRepoIds(registryDeps, { listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }) })
    expect(ids).toEqual([REPO_ID])
  })

  it('returns null when the registry could not be listed', async () => {
    const ids = await registeredRepoIds(registryDeps, { listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'boom' }) })
    expect(ids).toBeNull()
  })
})

describe('resolveDispatchControl — validation', () => {
  it('rejects a command outside DISPATCH_COMMANDS', async () => {
    await expect(resolveDispatchControl(registryDeps, { command: 'bogus' as never }, depsWith())).rejects.toThrow(
      "'dispatch:control' requires 'command' to be one of run, drain, pause, halt, take-over",
    )
  })

  it('rejects halt carrying a repoId', async () => {
    await expect(resolveDispatchControl(registryDeps, { command: 'halt', repoId: REPO_ID }, depsWith())).rejects.toThrow("must not carry a 'repoId'")
  })

  it('rejects run/drain/pause with no repoId', async () => {
    await expect(resolveDispatchControl(registryDeps, { command: 'run' } as never, depsWith())).rejects.toThrow("requires a non-empty 'repoId'")
  })

  it('rejects a repoId naming no registered repository', async () => {
    await expect(resolveDispatchControl(registryDeps, { command: 'run', repoId: REPO_ID }, depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) }))).rejects.toThrow(
      "found no repository registered with id 'repo-a'",
    )
  })
})

describe('resolveDispatchControl — run', () => {
  it('sets dispatching, refreshes once, and reports the new run state', async () => {
    let refreshed: unknown
    const entry = await readyEntry()
    const { runStates, setCalls } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'dispatching', since: '2026-01-01T00:00:00Z' }))
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'run', repoId: REPO_ID },
      depsWith({ runStates, listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }), refresh: (request) => { refreshed = request; return Promise.resolve(SNAPSHOT) } }),
    )
    expect(result).toEqual({ ok: true, command: 'run', repoId: REPO_ID, runState: { repoId: REPO_ID, state: 'dispatching', since: '2026-01-01T00:00:00Z' } })
    expect(setCalls).toEqual([[[REPO_ID], 'dispatching']])
    expect(refreshed).toEqual({ repoId: REPO_ID })
  })

  it('is refused outright when the write fails, and never refreshes', async () => {
    let refreshed = false
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'paused', since: null }), { ok: false, reason: 'unwritable', message: 'disk full' })
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'run', repoId: REPO_ID },
      depsWith({ runStates, listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }), refresh: () => { refreshed = true; return Promise.resolve(SNAPSHOT) } }),
    )
    expect(result).toEqual({ ok: false, command: 'run', repoId: REPO_ID, reason: 'unwritable', message: 'disk full', path: '/userData/dispatch.json' })
    expect(refreshed).toBe(false)
  })

  it('takes ownership before the run-state write, and refuses with no write at all when a terminal cockpit owns it', async () => {
    let written = false
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'paused', since: null }))
    const terminalSince = '2026-01-01T00:00:00Z'
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'run', repoId: REPO_ID },
      depsWith({
        runStates: { ...runStates, set: (repoIds, state, at) => { written = true; return runStates.set(repoIds, state, at) } },
        listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
        takeOwnership: () =>
          Promise.resolve({ ok: false, kind: 'refused', verdict: { kind: 'terminal', since: terminalSince, path: '/repo/.agents/cockpit.json', readAt: terminalSince }, path: '/repo/.agents/cockpit.json' }),
      }),
    )
    expect(result).toEqual({ ok: false, command: 'run', repoId: REPO_ID, reason: 'terminal-owned', since: terminalSince })
    expect(written).toBe(false)
  })

  it('refuses with ownership-unreadable when the record cannot be read', async () => {
    const entry = await readyEntry()
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'run', repoId: REPO_ID },
      depsWith({
        listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
        takeOwnership: () =>
          Promise.resolve({
            ok: false,
            kind: 'refused',
            verdict: { kind: 'unreadable', message: 'bad json', path: '/repo/.agents/cockpit.json', readAt: '2026-01-01T00:00:00Z' },
            path: '/repo/.agents/cockpit.json',
          }),
      }),
    )
    expect(result).toEqual({ ok: false, command: 'run', repoId: REPO_ID, reason: 'ownership-unreadable', message: 'bad json', path: '/repo/.agents/cockpit.json' })
  })

  it('skips taking ownership for a repository with no ready config, and still sets run state', async () => {
    let took = false
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'run', repoId: REPO_ID },
      depsWith({
        listRepositories: () => Promise.resolve({ ok: true, repositories: [{ id: REPO_ID, path: '/repo', displayName: 'o/a', problem: { kind: 'directory-missing' as const }, diagnostics: [] }] }),
        takeOwnership: () => { took = true; return Promise.resolve({ ok: true, path: 'p' }) },
      }),
    )
    expect(took).toBe(false)
    expect(result.ok).toBe(true)
  })
})

describe('resolveDispatchControl — take-over (#331)', () => {
  it('requires a ready repository', async () => {
    const notReady = { id: REPO_ID, path: '/repo', displayName: 'o/a', problem: { kind: 'directory-missing' as const }, diagnostics: [] }
    await expect(
      resolveDispatchControl(registryDeps, { command: 'take-over', repoId: REPO_ID }, depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [notReady] }) })),
    ).rejects.toThrow("take-over requires 'repo-a' to be a ready repository")
  })

  it('forces ownership, then sets dispatching and refreshes once', async () => {
    let forced = false
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'dispatching', since: '2026-01-01T00:00:00Z' }))
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'take-over', repoId: REPO_ID },
      depsWith({
        runStates,
        listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
        takeOwnership: (params) => { forced = params.force === true; return Promise.resolve({ ok: true, path: 'p' }) },
      }),
    )
    expect(forced).toBe(true)
    expect(result).toEqual({ ok: true, command: 'take-over', repoId: REPO_ID, runState: { repoId: REPO_ID, state: 'dispatching', since: '2026-01-01T00:00:00Z' } })
  })
})

describe('resolveDispatchControl — drain', () => {
  it('sets draining, refreshes once, and reports persisted true on a clean write', async () => {
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'draining', since: '2026-01-01T00:00:00Z' }))
    const result = await resolveDispatchControl(registryDeps, { command: 'drain', repoId: REPO_ID }, depsWith({ runStates, listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }) }))
    expect(result).toEqual({ ok: true, command: 'drain', repoId: REPO_ID, runState: { repoId: REPO_ID, state: 'draining', since: '2026-01-01T00:00:00Z' }, persisted: true })
  })

  it('reports persisted false when the write fails but the store is readable, never refused', async () => {
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'draining', since: '2026-01-01T00:00:00Z' }), { ok: false, reason: 'unwritable', message: 'disk full' })
    const result = await resolveDispatchControl(registryDeps, { command: 'drain', repoId: REPO_ID }, depsWith({ runStates, listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }) }))
    expect(result).toEqual({ ok: true, command: 'drain', repoId: REPO_ID, runState: { repoId: REPO_ID, state: 'draining', since: '2026-01-01T00:00:00Z' }, persisted: false })
  })

  it('is refused outright when the store is unreadable', async () => {
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'paused', since: null }), { ok: false, reason: 'unreadable', message: "can't read" })
    const result = await resolveDispatchControl(registryDeps, { command: 'drain', repoId: REPO_ID }, depsWith({ runStates, listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }) }))
    expect(result).toEqual({ ok: false, command: 'drain', repoId: REPO_ID, reason: 'unreadable', message: "can't read", path: '/userData/dispatch.json' })
  })
})

describe('resolveDispatchControl — pause', () => {
  it('scopes haltDispatch to the one repository, releases ownership, refreshes once, and reports the new run state', async () => {
    let refreshed: unknown
    let haltRepoIds: readonly RepoId[] | null = null
    let released: unknown
    const entry = await readyEntry()
    const { runStates } = fakeRunStates(() => ({ repoId: REPO_ID, state: 'paused', since: '2026-01-01T00:00:00Z' }))
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'pause', repoId: REPO_ID },
      depsWith({
        runStates,
        listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
        haltDispatch: (params) => {
          haltRepoIds = params.repoIds
          return Promise.resolve({ kind: 'completed', items: [] })
        },
        releaseOwnership: (params) => { released = params; return Promise.resolve({ ok: true, path: 'p' }) },
        refresh: (request) => { refreshed = request; return Promise.resolve(SNAPSHOT) },
      }),
    )
    expect(haltRepoIds).toEqual([REPO_ID])
    expect(released).toEqual({ repoRoot: entry.path, repo: entry.config.repo })
    expect(refreshed).toEqual({ repoId: REPO_ID })
    expect(result).toEqual({
      ok: true,
      command: 'pause',
      repoId: REPO_ID,
      runState: { repoId: REPO_ID, state: 'paused', since: '2026-01-01T00:00:00Z' },
      report: { kind: 'completed', items: [] },
      released: true,
    })
  })

  it('reports released: false without throwing when the release itself fails', async () => {
    const entry = await readyEntry()
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'pause', repoId: REPO_ID },
      depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }), releaseOwnership: () => Promise.resolve({ ok: false, kind: 'permission-denied', message: 'nope', path: 'p' }) }),
    )
    expect(result).toMatchObject({ ok: true, command: 'pause', released: false })
  })
})

describe('resolveDispatchControl — halt', () => {
  it('lists ready repositories, calls haltDispatch across all of them, releases ownership for each, and refreshes once', async () => {
    let refreshCalls = 0
    let haltCalled = false
    let releaseCalls = 0
    const entry = await readyEntry()
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'halt' },
      depsWith({
        listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
        haltDispatch: (params) => {
          haltCalled = true
          expect(params.repoIds).toEqual([REPO_ID])
          return Promise.resolve({ kind: 'completed', items: [] })
        },
        releaseOwnership: () => { releaseCalls += 1; return Promise.resolve({ ok: true, path: 'p' }) },
        refresh: () => {
          refreshCalls += 1
          return Promise.resolve(SNAPSHOT)
        },
      }),
    )
    expect(haltCalled).toBe(true)
    expect(releaseCalls).toBe(1)
    expect(refreshCalls).toBe(1)
    expect(result).toEqual({ ok: true, command: 'halt', report: { kind: 'completed', items: [] }, released: true })
  })

  it('still refreshes once even when the halt itself aborted', async () => {
    let refreshCalls = 0
    const aborted: HaltReport = { kind: 'aborted', reason: 'run-state-unwritable', message: 'disk full', path: '/userData/dispatch.json' }
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'halt' },
      depsWith({ haltDispatch: () => Promise.resolve(aborted), refresh: () => { refreshCalls += 1; return Promise.resolve(SNAPSHOT) } }),
    )
    expect(refreshCalls).toBe(1)
    expect(result).toEqual({ ok: true, command: 'halt', report: aborted, released: true })
  })
})
