import { describe, expect, it, vi } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ClaimRead } from '../writes'
import type { HostedSessionSnapshot, HostedStore, SessionKey } from '../hosting'
import type { TickReport } from '../../shared/tick/types'
import type { ReadyEntry } from '../actions'
import { createDispatcher } from './dispatcher'
import type { CreateDispatcherParams } from './dispatcher'

const REPO_ID = 'repo-a' as RepoId
const VOCABULARY = resolveVocabulary({})

function entry(overrides: Partial<ReadyEntry['config']> = {}): ReadyEntry {
  return {
    id: REPO_ID,
    path: '/repo',
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
      vocabulary: VOCABULARY,
      ...overrides,
    },
    diagnostics: [],
  }
}

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], ...overrides }
}

function snapshotWith(tick: readonly TickReport[]): BoardSnapshot {
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op' } as never],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00Z' },
      readAt: '2026-01-01T00:00:00Z',
    },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick,
    relay: { ok: true, pending: [], checked: 0, unreached: 0, scannedAt: '2026-01-01T00:00:00Z' },
    drain: { gate: 'open' },
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
    dispatch: [],
  }
}

const HELD_CLAIM: ClaimRead = { state: 'held', owner: 'port-desktop', scopes: ['dispatch'], unknownScopes: [], claimedAt: '2026-01-01T00:00:00Z', path: '/repo/.agents/gate-claim.json', readAt: 'r' }
const ABSENT_CLAIM: ClaimRead = { state: 'absent', path: '/repo/.agents/gate-claim.json', readAt: 'r' }
const UNREADABLE_CLAIM: ClaimRead = { state: 'unreadable', message: 'bad', path: '/repo/.agents/gate-claim.json', readAt: 'r' }

function baseSessionSnapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: REPO_ID,
    phase: 'ready',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [{ name: 'impl-agent', description: '', model: null }], plugin: { kind: 'loaded', path: 'p', version: null }, components: { kind: 'complete' } },
    title: 'Port dispatcher · o/a',
    rateLimit: null,
    role: 'dispatcher',
    tasks: [],
    ...overrides,
  }
}

function fakeStore(overrides: Partial<HostedStore> = {}): HostedStore {
  return {
    start: () => {
      throw new Error('start should not be invoked in this case')
    },
    send: () => ({ ok: true as const, uuid: 'u1', queued: true }),
    interrupt: () => {
      throw new Error('interrupt should not be invoked in this case')
    },
    close: () => {
      throw new Error('close should not be invoked in this case')
    },
    attach: () => {
      throw new Error('attach should not be invoked in this case')
    },
    list: () => [],
    closeAll: () => Promise.resolve(),
    answerPermission: () => {
      throw new Error('answerPermission should not be invoked in this case')
    },
    invoke: () => {
      throw new Error('invoke should not be invoked in this case')
    },
    dismiss: () => {
      throw new Error('dismiss should not be invoked in this case')
    },
    stopTask: () => Promise.resolve({ ok: true }),
    snapshotOf: () => null,
    capacity: () => Promise.resolve({ limit: 4, ceiling: 8 }),
    setLimit: () => {
      throw new Error('setLimit should not be invoked in this case')
    },
    restorable: () => Promise.resolve([]),
    restore: () => {
      throw new Error('restore should not be invoked in this case')
    },
    discardRestorable: () => Promise.resolve({ ok: true }),
    ...overrides,
  }
}

function baseDeps(overrides: Partial<CreateDispatcherParams> = {}): CreateDispatcherParams {
  return {
    store: fakeStore(),
    ledger: { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' }) },
    refreshMemo: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
    writeObservation: () => {
      throw new Error('writeObservation should not be invoked unless a test wires its own')
    },
    drain: () => ({ gate: 'open' }),
    readGateClaim: () => Promise.resolve(ABSENT_CLAIM),
    fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: 'r' }),
    listRepositories: () => Promise.resolve({ ok: true, repositories: [entry()] }),
    registryDeps: { registryDir: '/registry', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
    budget: {
      reset: () => {
        throw new Error('budget.reset should not be invoked when commands.budget is null')
      },
      sweep: () => {
        throw new Error('budget.sweep should not be invoked when commands.budget is null')
      },
      check: () => {
        throw new Error('budget.check should not be invoked when commands.budget is null')
      },
    },
    escalate: () => {
      throw new Error('escalate should not be invoked when commands.budget is null')
    },
    dirs: { audit: '/audit', scratch: '/scratch' },
    onChange: vi.fn(),
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('createDispatcher — ownership', () => {
  it('reports cockpit for an absent claim, and never touches the store', async () => {
    const store = fakeStore()
    const dispatcher = createDispatcher(baseDeps({ store }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()).toEqual([{ repoId: REPO_ID, owner: 'cockpit', state: { kind: 'idle' }, draining: false, claudeSessionId: null, claimedAt: null, budget: null, observed: [] }])
  })

  it('reports nobody for an unreadable claim', async () => {
    const dispatcher = createDispatcher(baseDeps({ readGateClaim: () => Promise.resolve(UNREADABLE_CLAIM) }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()).toEqual([{ repoId: REPO_ID, owner: 'nobody', state: { kind: 'idle' }, draining: false, claudeSessionId: null, claimedAt: null, budget: null, observed: [] }])
  })

  it('reports app for a claim naming dispatch', async () => {
    const dispatcher = createDispatcher(baseDeps({ readGateClaim: () => Promise.resolve(HELD_CLAIM) }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.owner).toBe('app')
  })
})

describe('createDispatcher — app ownership', () => {
  it('stays idle with nothing dispatchable', async () => {
    const dispatcher = createDispatcher(baseDeps({ readGateClaim: () => Promise.resolve(HELD_CLAIM) }))
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [] })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('reports dispatcher-failed: at-capacity when the session cannot start', async () => {
    const store = fakeStore({ start: () => Promise.resolve({ ok: false, kind: 'at-capacity', limit: 4 }) })
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        readGateClaim: () => Promise.resolve(HELD_CLAIM),
      }),
    )
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'dispatcher-failed', reason: 'at-capacity', limit: 4 })
  })

  it('waits (idle, unchanged) while capabilities are pending, never a busy-wait', async () => {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u1', queued: true }))
    const store = fakeStore({
      start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot({ capabilities: { kind: 'pending', request: { source: 'installed' } } }) }),
      snapshotOf: () => baseSessionSnapshot({ capabilities: { kind: 'pending', request: { source: 'installed' } } }),
      send,
    })
    const dispatcher = createDispatcher(baseDeps({ store, readGateClaim: () => Promise.resolve(HELD_CLAIM) }))
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports dispatcher-failed: plugin when the plugin load is missing', async () => {
    const store = fakeStore({
      start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot({ capabilities: { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'missing' }, components: { kind: 'unchecked', reason: 'no-plugin-path' } } }) }),
      snapshotOf: () => baseSessionSnapshot({ capabilities: { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'missing' }, components: { kind: 'unchecked', reason: 'no-plugin-path' } } }),
    })
    const dispatcher = createDispatcher(baseDeps({ store, readGateClaim: () => Promise.resolve(HELD_CLAIM) }))
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'dispatcher-failed', reason: 'plugin' })
  })

  it('a candidate that moved (label no longer present) is dropped — nothing dispatches', async () => {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u1', queued: true }))
    const store = fakeStore({ start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot() }), snapshotOf: () => baseSessionSnapshot(), send })
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        readGateClaim: () => Promise.resolve(HELD_CLAIM),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['in progress'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })]))
    expect(send).not.toHaveBeenCalled()
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('reports agents-missing and sends nothing when the session lacks the needed agent', async () => {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u1', queued: true }))
    const store = fakeStore({
      start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot({ capabilities: { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'loaded', path: 'p', version: null }, components: { kind: 'complete' } } }) }),
      snapshotOf: () => baseSessionSnapshot({ capabilities: { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'loaded', path: 'p', version: null }, components: { kind: 'complete' } } }),
      send,
    })
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        readGateClaim: () => Promise.resolve(HELD_CLAIM),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })]))
    expect(send).not.toHaveBeenCalled()
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'agents-missing', agent: 'impl' })
  })

  it('sends a dispatch turn for a surviving candidate, recording it as sent', async () => {
    const send = vi.fn<HostedStore['send']>(() => ({ ok: true as const, uuid: 'u1', queued: true }))
    const store = fakeStore({ start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot() }), snapshotOf: () => baseSessionSnapshot(), send })
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        readGateClaim: () => Promise.resolve(HELD_CLAIM),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })]))
    expect(send).toHaveBeenCalledTimes(1)
    const call = send.mock.calls[0]
    if (call === undefined) throw new Error('unreachable')
    const [, text] = call
    expect(text).toContain('Agent(')
    expect(text).toContain('impl #52')
    const state = dispatcher.status()[0]?.state
    expect(state?.kind).toBe('active')
    if (state?.kind !== 'active') return
    expect(state.recent).toEqual([{ agent: 'impl', number: 52, kind: 'issue', state: 'sent', at: '2026-01-01T00:00:00.000Z' }])
    expect(dispatcher.status()[0]?.claudeSessionId).toBe('sdk-1') // baseSessionSnapshot's own claudeSessionId (#265)
  })

  it('confirms a sent record as started once a matching task appears, and calls ledger.record', async () => {
    const snap = baseSessionSnapshot({ tasks: [{ taskId: 't1', toolUseId: 'tu1', description: 'impl #52', subagentType: 'port:impl-agent', status: 'started', startedAt: 'a', endedAt: null }] })
    const store = fakeStore({ start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot() }), snapshotOf: () => snap })
    const ledger = { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' as const }) }
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        ledger,
        readGateClaim: () => Promise.resolve(HELD_CLAIM),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )
    const actionable = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
    await dispatcher.consider(snapshotWith([tickReport({ actionable })])) // sends it — recorded 'sent'
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [] })])) // confirms it — recorded 'started'
    expect(ledger.record).toHaveBeenCalledWith(REPO_ID, 52)
    const state = dispatcher.status()[0]?.state
    expect(state?.kind).toBe('active')
    if (state?.kind !== 'active') return
    expect(state.recent[0]?.state).toBe('started')
  })
})

describe('createDispatcher — relay and stopFor', () => {
  it('relay refuses not-owner when this app does not hold the claim', async () => {
    const dispatcher = createDispatcher(baseDeps())
    const result = await dispatcher.relay({ repoId: REPO_ID, agentId: 't1', text: 'x' })
    expect(result).toEqual({ ok: false, kind: 'not-owner' })
  })

  it('stopFor returns false when there is no started task for that item', async () => {
    const dispatcher = createDispatcher(baseDeps())
    expect(await dispatcher.stopFor(REPO_ID, 999)).toBe(false)
  })
})
