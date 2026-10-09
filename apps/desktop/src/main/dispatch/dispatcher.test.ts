import { describe, expect, it, vi } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { HostedSessionSnapshot, SessionKey } from '../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../shared/hosting/controls'
import type { HostedStore } from '../hosting/store'
import type { TickActionable, TickReport } from '../../shared/tick/types'
import type { ReadyEntry } from '../actions/apply'
import type { StageLaunchRequest, StageLaunchResult, StageLauncher } from './launch'
import { createDispatcher, DISPATCH_PROMPT, promptFor, REFRESH_PROMPT } from './dispatcher'
import type { CreateDispatcherParams } from './dispatcher'
import type { OwnershipRead } from './ownership'

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
      checkDispositions: {},
      overrides: [],
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
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], ...overrides }
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
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
    dispatch: [],
  }
}

const OWNED_BY_APP: OwnershipRead = { kind: 'app', since: '2026-01-01T00:00:00Z', path: '/repo/.agents/cockpit.json', readAt: 'r' }
const ABSENT_OWNERSHIP: OwnershipRead = { kind: 'absent', path: '/repo/.agents/cockpit.json', readAt: 'r' }
const UNREADABLE_OWNERSHIP: OwnershipRead = { kind: 'unreadable', message: 'bad', path: '/repo/.agents/cockpit.json', readAt: 'r' }

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function sessionSnapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
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
    capabilities: { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'loaded', path: 'p', version: null }, components: { kind: 'complete' }, slashCommands: [] },
    title: null,
    rateLimit: null,
    controls: TEST_CONTROLS,
    models: TEST_MODELS,
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
    close: () => Promise.resolve({ ok: true }),
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
    snapshotOf: () => null,
    cwdOf: () => null,
    capacity: () => Promise.resolve({ limit: 4, ceiling: 8 }),
    setLimit: () => {
      throw new Error('setLimit should not be invoked in this case')
    },
    restorable: () => Promise.resolve([]),
    restore: () => {
      throw new Error('restore should not be invoked in this case')
    },
    discardRestorable: () => Promise.resolve({ ok: true }),
    setControls: () => Promise.resolve({ ok: false, kind: 'unknown-session' }),
    answerQuestion: () => ({ ok: false, kind: 'unknown-session' }),
    answerPlan: () => ({ ok: false, kind: 'unknown-session' }),
    defaults: () => {
      throw new Error('defaults should not be invoked in this case')
    },
    setDefaults: () => {
      throw new Error('setDefaults should not be invoked in this case')
    },
    rename: () => {
      throw new Error('rename should not be invoked in this case')
    },
    ...overrides,
  }
}

function fakeLauncher(launch: (request: StageLaunchRequest) => Promise<StageLaunchResult>): StageLauncher {
  return { launch }
}

function baseDeps(overrides: Partial<CreateDispatcherParams> = {}): CreateDispatcherParams {
  return {
    store: fakeStore(),
    launch: null,
    ledger: { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' }) },
    refreshMemo: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
    writeObservation: () => {
      throw new Error('writeObservation should not be invoked unless a test wires its own')
    },
    runState: () => 'dispatching',
    readOwnership: () => Promise.resolve(ABSENT_OWNERSHIP),
    // Harmless by default — readOwnership above stays `absent`, so this never changes outcomes.
    takeOwnership: () => Promise.resolve({ ok: true, path: 'p' }),
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

const ACTIONABLE = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]

describe('createDispatcher — ownership', () => {
  it('reports none for an absent record, and never touches the store', async () => {
    const dispatcher = createDispatcher(baseDeps())
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()).toEqual([
      { repoId: REPO_ID, owner: 'none', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [] },
    ])
  })

  it('reports unreadable for an unreadable record', async () => {
    const dispatcher = createDispatcher(baseDeps({ readOwnership: () => Promise.resolve(UNREADABLE_OWNERSHIP) }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()).toEqual([
      { repoId: REPO_ID, owner: 'unreadable', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: 'bad', budget: null, observed: [] },
    ])
  })

  it('reports terminal for a record owned by the terminal cockpit', async () => {
    const dispatcher = createDispatcher(baseDeps({ readOwnership: () => Promise.resolve({ kind: 'terminal', since: '2026-01-01T00:00:00Z', path: '/repo/.agents/cockpit.json', readAt: 'r' }) }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]).toMatchObject({ owner: 'terminal', ownedSince: '2026-01-01T00:00:00Z' })
  })

  it('reports app for a record owned by this app', async () => {
    const dispatcher = createDispatcher(baseDeps({ readOwnership: () => Promise.resolve(OWNED_BY_APP) }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.owner).toBe('app')
  })
})

describe('createDispatcher — re-take on relaunch (#331)', () => {
  it('takes ownership itself when run state is dispatching but the record is absent', async () => {
    let took = false
    const dispatcher = createDispatcher(
      baseDeps({
        readOwnership: () => Promise.resolve(ABSENT_OWNERSHIP),
        takeOwnership: () => {
          took = true
          return Promise.resolve({ ok: true, path: 'p' })
        },
      }),
    )
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(took).toBe(true)
  })

  it('never takes ownership while paused', async () => {
    let took = false
    const dispatcher = createDispatcher(
      baseDeps({
        runState: () => 'paused',
        readOwnership: () => Promise.resolve(ABSENT_OWNERSHIP),
        takeOwnership: () => {
          took = true
          return Promise.resolve({ ok: true, path: 'p' })
        },
      }),
    )
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(took).toBe(false)
  })
})

describe('createDispatcher — no-launcher', () => {
  it('holds visibly with candidates and no launcher, never fetching or budgeting', async () => {
    let fetched = false
    const dispatcher = createDispatcher(
      baseDeps({ readOwnership: () => Promise.resolve(OWNED_BY_APP), fetchItemsByNumber: () => { fetched = true; return Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: 'r' }) } }),
    )
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'no-launcher' })
    expect(fetched).toBe(false)
  })

  it('stays idle with nothing dispatchable', async () => {
    const dispatcher = createDispatcher(baseDeps({ readOwnership: () => Promise.resolve(OWNED_BY_APP) }))
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [] })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })
})

describe('createDispatcher — launching', () => {
  function readyToDispatch(overrides: Partial<CreateDispatcherParams> = {}) {
    const launched: StageLaunchRequest[] = []
    const launch = fakeLauncher((request) => {
      launched.push(request)
      return Promise.resolve({ ok: true, sessionKey: 'hosted-1' as SessionKey })
    })
    const store = fakeStore({ snapshotOf: () => sessionSnapshot() })
    const deps = baseDeps({
      store,
      launch,
      readOwnership: () => Promise.resolve(OWNED_BY_APP),
      fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      ...overrides,
    })
    return { dispatcher: createDispatcher(deps), launched }
  }

  it('a candidate that moved (label no longer present) is dropped — nothing launches', async () => {
    const { dispatcher, launched } = readyToDispatch({ fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['in progress'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }) })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(launched).toHaveLength(0)
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('launches a surviving candidate, recording it as started', async () => {
    const { dispatcher, launched } = readyToDispatch()
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({ agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved' })
    const state = dispatcher.status()[0]?.state
    expect(state?.kind).toBe('active')
    if (state?.kind !== 'active') return
    expect(state.recent).toEqual([{ agent: 'impl', number: 52, kind: 'issue', state: 'started', at: '2026-01-01T00:00:00.000Z', detail: null }])
  })

  it('calls ledger.record only after a launch returns ok', async () => {
    const ledger = { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' as const }) }
    const { dispatcher } = readyToDispatch({ ledger })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(ledger.record).toHaveBeenCalledWith(REPO_ID, 52)
  })

  it('a launch that reports at-capacity holds the candidate as waiting', async () => {
    const launch = fakeLauncher(() => Promise.resolve({ ok: false, kind: 'at-capacity', limit: 4 }))
    const { dispatcher } = readyToDispatch({ launch })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'at-capacity', limit: 4, waiting: 1 })
  })

  it('a launch that throws records a failed entry and never stops the loop', async () => {
    const launch = fakeLauncher(() => Promise.reject(new Error('boom')))
    const { dispatcher } = readyToDispatch({ launch })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    const state = dispatcher.status()[0]?.state
    expect(state?.kind).toBe('active')
    if (state?.kind !== 'active') return
    expect(state.recent).toEqual([{ agent: 'impl', number: 52, kind: 'issue', state: 'failed', at: '2026-01-01T00:00:00.000Z', detail: 'boom' }])
  })

  it('never launches while zero slots are free', async () => {
    const launch = fakeLauncher(() => {
      throw new Error('launch should never be called with zero free slots')
    })
    const store = fakeStore({ snapshotOf: () => sessionSnapshot(), capacity: () => Promise.resolve({ limit: 1, ceiling: 8 }), list: () => [sessionSnapshot({ sessionKey: 'hosted-2' as SessionKey })] })
    const { dispatcher } = readyToDispatch({ launch, store })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'at-capacity', limit: 1, waiting: 1 })
  })
})

describe('createDispatcher — stopFor and standDown', () => {
  it('stopFor returns false when there is no started record for that item', async () => {
    const dispatcher = createDispatcher(baseDeps())
    expect(await dispatcher.stopFor(REPO_ID, 999)).toBe(false)
  })

  it('standDown returns false when no session is live for that repository', async () => {
    const dispatcher = createDispatcher(baseDeps())
    expect(await dispatcher.standDown(REPO_ID)).toBe(false)
  })

  it('stopFor closes the live session and liveStages drops it', async () => {
    const close = vi.fn(() => Promise.resolve({ ok: true as const }))
    const launch = fakeLauncher(() => Promise.resolve({ ok: true, sessionKey: 'hosted-1' as SessionKey }))
    const store = fakeStore({ snapshotOf: () => sessionSnapshot(), close })
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        launch,
        readOwnership: () => Promise.resolve(OWNED_BY_APP),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.liveStages(REPO_ID)).toEqual(['impl #52'])
    expect(await dispatcher.stopFor(REPO_ID, 52)).toBe(true)
    expect(close).toHaveBeenCalledWith('hosted-1')
  })
})

describe('createDispatcher — run state (#314)', () => {
  it('draining never launches — the candidate is reported idle', async () => {
    const launch = fakeLauncher(() => {
      throw new Error('launch should not be called while draining')
    })
    const store = fakeStore({ snapshotOf: () => sessionSnapshot() })
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        launch,
        runState: () => 'draining',
        readOwnership: () => Promise.resolve(OWNED_BY_APP),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()[0]).toMatchObject({ runState: 'draining', state: { kind: 'idle' } })
  })

  it('status() reports this repository\'s own current run state even for the none owner', async () => {
    const dispatcher = createDispatcher(baseDeps({ runState: () => 'paused' }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]).toMatchObject({ owner: 'none', runState: 'paused' })
  })
})

describe('createDispatcher — shutdown', () => {
  it('consider is a no-op once shutdown has run', async () => {
    const dispatcher = createDispatcher(baseDeps({ readOwnership: () => Promise.resolve(OWNED_BY_APP) }))
    dispatcher.shutdown()
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()).toEqual([])
  })
})

function promptForActionable(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

describe('promptFor', () => {
  it('uses DISPATCH_PROMPT for an ordinary trigger, filling in the number', () => {
    expect(promptFor(promptForActionable())).toBe(DISPATCH_PROMPT.replace('<n>', '52'))
  })

  it('uses REFRESH_PROMPT for a refreshBranch trigger', () => {
    expect(promptFor(promptForActionable({ trigger: 'refreshBranch', agent: 'revise' }))).toBe(REFRESH_PROMPT.replace('<n>', '52'))
  })
})
