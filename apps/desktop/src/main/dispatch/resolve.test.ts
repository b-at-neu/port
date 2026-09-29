import { describe, expect, it } from 'vitest'
import type { ReposListResponse } from '../../shared/ipc'
import type { BoardSnapshot } from '../../shared/board/types'
import type { HaltReport } from '../../shared/dispatch/types'
import type { RegistryDeps } from '../registry'
import type { DrainStore, SetDrainResult } from './store'
import { resolveDispatchControl } from './resolve'
import type { ResolveDispatchControlDeps } from './resolve'

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
