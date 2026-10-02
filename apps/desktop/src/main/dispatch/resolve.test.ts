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
import type { ReadyEntry } from '../actions'
import type { Dispatcher } from './dispatcher'
import type { DrainStore, SetDrainResult } from './store'
import { resolveDispatchClaimSet, resolveDispatchControl, resolveDispatchRelay } from './resolve'
import type { ResolveDispatchClaimSetDeps, ResolveDispatchControlDeps, ResolveDispatchRelayDeps } from './resolve'

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const SNAPSHOT: BoardSnapshot = {
  state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: 't' }, readAt: 't' },
  health: [],
  policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
  tick: [],
  relay: { ok: true, pending: [], checked: 0, unreached: 0, scannedAt: 't' },
  drain: { gate: 'open' },
  nextWakeupAt: null,
  emittedAt: 't',
  dispatch: [],
}

function fakeDrain(current: DrainStore['current'], setResult: SetDrainResult = { ok: true }): { readonly drain: DrainStore; readonly setCalls: boolean[] } {
  const setCalls: boolean[] = []
  const drain: DrainStore = {
    current,
    load: () => Promise.resolve(),
    set: (draining: boolean) => {
      setCalls.push(draining)
      return Promise.resolve(setResult)
    },
    path: '/userData/dispatch.json',
  }
  return { drain, setCalls }
}

function depsWith(overrides: Partial<ResolveDispatchControlDeps> = {}): ResolveDispatchControlDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    drain: fakeDrain(() => ({ gate: 'open' })).drain,
    haltDispatch: () => Promise.resolve({ kind: 'completed', items: [] } as HaltReport),
    snapshot: () => SNAPSHOT,
    refresh: () => Promise.resolve(SNAPSHOT),
    auditDir: '/audit',
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('resolveDispatchControl — validation', () => {
  it('rejects a command outside DISPATCH_COMMANDS', async () => {
    await expect(resolveDispatchControl(registryDeps, { command: 'bogus' as never }, depsWith())).rejects.toThrow(
      "'dispatch:control' requires 'command' to be one of drain, resume, halt",
    )
  })
})

describe('resolveDispatchControl — drain', () => {
  it('sets draining, never calls refresh, and reports persisted true on a clean write', async () => {
    let refreshed = false
    const { drain } = fakeDrain(() => ({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }))
    const result = await resolveDispatchControl(registryDeps, { command: 'drain' }, depsWith({ drain, refresh: () => { refreshed = true; return Promise.resolve(SNAPSHOT) } }))
    expect(result).toEqual({ ok: true, command: 'drain', drain: { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }, persisted: true })
    expect(refreshed).toBe(false)
  })

  it('reports persisted false when the write fails, but is never refused', async () => {
    const { drain } = fakeDrain(() => ({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }), { ok: false, message: 'disk full' })
    const result = await resolveDispatchControl(registryDeps, { command: 'drain' }, depsWith({ drain }))
    expect(result).toEqual({ ok: true, command: 'drain', drain: { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }, persisted: false })
  })
})

describe('resolveDispatchControl — resume', () => {
  it('sets open and refreshes once on a clean write', async () => {
    let refreshCalls = 0
    const { drain } = fakeDrain(() => ({ gate: 'open' }))
    const result = await resolveDispatchControl(registryDeps, { command: 'resume' }, depsWith({ drain, refresh: () => { refreshCalls += 1; return Promise.resolve(SNAPSHOT) } }))
    expect(result).toEqual({ ok: true, command: 'resume', drain: { gate: 'open' } })
    expect(refreshCalls).toBe(1)
  })

  it('is refused outright when the write fails, and never refreshes', async () => {
    let refreshed = false
    const { drain } = fakeDrain(() => ({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }), { ok: false, message: 'disk full' })
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'resume' },
      depsWith({ drain, refresh: () => { refreshed = true; return Promise.resolve(SNAPSHOT) } }),
    )
    expect(result).toEqual({ ok: false, command: 'resume', reason: 'drain-unwritable', message: 'disk full', path: '/userData/dispatch.json' })
    expect(refreshed).toBe(false)
  })
})

describe('resolveDispatchControl — halt', () => {
  it('lists ready repositories, calls haltDispatch, and refreshes once', async () => {
    let refreshCalls = 0
    let haltCalled = false
    const { drain } = fakeDrain(() => ({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }))
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'halt' },
      depsWith({
        drain,
        haltDispatch: () => {
          haltCalled = true
          return Promise.resolve({ kind: 'completed', items: [] })
        },
        refresh: () => {
          refreshCalls += 1
          return Promise.resolve(SNAPSHOT)
        },
      }),
    )
    expect(haltCalled).toBe(true)
    expect(refreshCalls).toBe(1)
    expect(result).toEqual({ ok: true, command: 'halt', drain: { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }, report: { kind: 'completed', items: [] } })
  })

  it('still refreshes once even when the halt itself aborted', async () => {
    let refreshCalls = 0
    const { drain } = fakeDrain(() => ({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }))
    const aborted: HaltReport = { kind: 'aborted', reason: 'drain-unwritable', message: 'disk full', path: '/userData/dispatch.json' }
    const result = await resolveDispatchControl(
      registryDeps,
      { command: 'halt' },
      depsWith({ drain, haltDispatch: () => Promise.resolve(aborted), refresh: () => { refreshCalls += 1; return Promise.resolve(SNAPSHOT) } }),
    )
    expect(refreshCalls).toBe(1)
    expect(result).toEqual({ ok: true, command: 'halt', drain: { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' }, report: aborted })
  })
})

const REPO_ID = 'repo-a' as RepoId

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
      checkDispositions: { excusedCheck: null, unverifiable: null },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: resolveVocabulary({}),
    },
    diagnostics: [],
  }
}

function fakeDispatcher(overrides: Partial<Dispatcher> = {}): Dispatcher {
  return {
    consider: () => Promise.resolve(),
    status: () => [],
    relay: () => Promise.resolve({ ok: false, kind: 'no-dispatcher' }),
    stopFor: () => Promise.resolve(false),
    startedTasks: () => [],
    ...overrides,
  }
}

describe('resolveDispatchClaimSet (#265)', () => {
  it('throws for a repository that is not ready', async () => {
    const deps: ResolveDispatchClaimSetDeps = { listRepositories: () => Promise.resolve({ ok: true, repositories: [] }), dispatcher: fakeDispatcher(), refresh: () => Promise.resolve(SNAPSHOT), now: () => new Date('2026-01-01T00:00:00Z') }
    await expect(resolveDispatchClaimSet(registryDeps, { repoId: REPO_ID, held: true }, deps)).rejects.toThrow("no repository registered with id 'repo-a'")
  })

  it('takes the claim, refreshes once, and reports the dispatcher status it then reads back', async () => {
    let refreshed = 0
    const entry = await readyEntry()
    const dispatcher = fakeDispatcher({ status: () => [{ repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, draining: false, claudeSessionId: null, claimedAt: null, budget: null, observed: [] }] })
    const deps: ResolveDispatchClaimSetDeps = {
      listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
      dispatcher,
      refresh: (request) => { refreshed += 1; expect(request).toEqual({ repoId: REPO_ID }); return Promise.resolve(SNAPSHOT) },
      now: () => new Date('2026-01-01T00:00:00Z'),
    }
    const result = await resolveDispatchClaimSet(registryDeps, { repoId: REPO_ID, held: true }, deps)
    expect(result).toEqual({ kind: 'ok', status: { repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, draining: false, claudeSessionId: null, claimedAt: null, budget: null, observed: [] } })
    expect(refreshed).toBe(1)
  })
})

describe('resolveDispatchRelay (#265)', () => {
  it('throws on a bad shape — empty agentId — before ever listing repositories', async () => {
    const deps: ResolveDispatchRelayDeps = { listRepositories: () => Promise.resolve({ ok: true, repositories: [] }), dispatcher: fakeDispatcher(), maxReplyChars: 100 }
    await expect(resolveDispatchRelay(registryDeps, { repoId: REPO_ID, agentId: '', text: 'x' }, deps)).rejects.toThrow()
  })

  it('throws on text over maxReplyChars', async () => {
    const deps: ResolveDispatchRelayDeps = { listRepositories: () => Promise.resolve({ ok: true, repositories: [] }), dispatcher: fakeDispatcher(), maxReplyChars: 3 }
    await expect(resolveDispatchRelay(registryDeps, { repoId: REPO_ID, agentId: 'a1', text: 'xxxx' }, deps)).rejects.toThrow()
  })

  it('delegates to dispatcher.relay for a well-formed, ready request', async () => {
    let seen: { repoId: RepoId; agentId: string; text: string } | null = null
    const dispatcher = fakeDispatcher({
      relay: (params) => {
        seen = params
        return Promise.resolve({ ok: true })
      },
    })
    const entry = await readyEntry()
    const deps: ResolveDispatchRelayDeps = { listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }), dispatcher, maxReplyChars: 100 }
    const result = await resolveDispatchRelay(registryDeps, { repoId: REPO_ID, agentId: 'a1', text: 'go' }, deps)
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual({ repoId: REPO_ID, agentId: 'a1', text: 'go' })
  })
})
