// Dispatcher-level budget-gate cases: reset-once/sweep-every-pass bookkeeping, the fail-closed
// budget-unavailable refusal, and per-candidate routing. Additive to dispatcher.test.ts, not a duplicate.
import { describe, expect, it, vi } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { HostedSessionSnapshot, SessionKey } from '../../shared/hosting/types'
import type { SessionControls, SessionModels } from '../../shared/hosting/controls'
import type { HostedStore } from '../hosting/store'
import type { TickReport } from '../../shared/tick/types'
import type { EscalateToHumanParams } from '../actions/escalate'
import type { ReadyEntry } from '../actions/apply'
import type { StageLaunchResult, StageLauncher } from './launch'
import { createDispatcher } from './dispatcher'
import type { CreateDispatcherParams } from './dispatcher'
import type { BudgetCheckResult, BudgetGate, BudgetResetResult, BudgetSweepResult } from './budget-gate'
import type { OwnershipRead } from './ownership'

const REPO_ID = 'repo-a' as RepoId
const VOCABULARY = resolveVocabulary({})
const BUDGET_COMMAND = 'node scripts/budget.mjs'

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
      commands: { worktrees: null, budget: BUDGET_COMMAND },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
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

const IMPL_CANDIDATE = { number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }

const TEST_CONTROLS: SessionControls = { permissionMode: 'default', model: null, effort: null }
const TEST_MODELS: SessionModels = { kind: 'pending' }

function sessionSnapshot(overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: REPO_ID,
    workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
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
    usage: null,
    backgroundTasks: [],
    stage: null,
    lastResult: null,
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
    marks: () => {
      throw new Error('marks should not be invoked in this case')
    },
    setMark: () => {
      throw new Error('setMark should not be invoked in this case')
    },
    stopTask: () => {
      throw new Error('stopTask should not be invoked in this case')
    },
    ...overrides,
  }
}

function fakeBudget(overrides: Partial<BudgetGate> = {}): BudgetGate {
  return {
    reset: () => Promise.resolve({ ok: true }),
    sweep: () => Promise.resolve({ line: null, problem: null }),
    check: () => {
      throw new Error('budget.check should not be invoked in this case')
    },
    ...overrides,
  }
}

function fakeLauncher(result: StageLaunchResult = { ok: true, sessionKey: 'hosted-1' as SessionKey }): StageLauncher {
  return { launch: () => Promise.resolve(result) }
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
    readOwnership: () => Promise.resolve(OWNED_BY_APP),
    takeOwnership: () => Promise.resolve({ ok: true, path: 'p' }),
    fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: 'r' }),
    listRepositories: () => Promise.resolve({ ok: true, repositories: [entry()] }),
    registryDeps: { registryDir: '/registry', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
    budget: fakeBudget(),
    escalate: () => {
      throw new Error('escalate should not be invoked in this case')
    },
    dirs: { audit: '/audit', scratch: '/scratch' },
    onChange: vi.fn(),
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('createDispatcher — budget bookkeeping', () => {
  it('resets once, then sweeps on every pass, populating budget.line', async () => {
    let resetCalls = 0
    let sweepCalls = 0
    const budget = fakeBudget({
      reset: () => {
        resetCalls += 1
        return Promise.resolve({ ok: true } satisfies BudgetResetResult)
      },
      sweep: () => {
        sweepCalls += 1
        return Promise.resolve({ line: 'session 1 dispatch · 2m 00s agent wall-clock', problem: null } satisfies BudgetSweepResult)
      },
    })
    const dispatcher = createDispatcher(baseDeps({ budget }))
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(resetCalls).toBe(1)
    expect(sweepCalls).toBe(1)
    expect(dispatcher.status()[0]?.budget).toEqual({ line: 'session 1 dispatch · 2m 00s agent wall-clock', problem: null, notes: [] })

    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(resetCalls).toBe(1) // never resets twice
    expect(sweepCalls).toBe(2) // sweeps on every pass
  })

  it('a reset failure reports budget-unavailable and dispatches nothing this pass', async () => {
    const budget = fakeBudget({ reset: () => Promise.resolve({ ok: false, kind: 'unavailable', message: "commands.budget can't run (could not be parsed as a plain command prefix)." }) })
    const dispatcher = createDispatcher(baseDeps({ budget }))
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'budget-unavailable', message: "commands.budget can't run (could not be parsed as a plain command prefix)." })
  })

  it('sweeps even after ownership moves away from this app, while a session is still live', async () => {
    const launch = fakeLauncher()
    const store = fakeStore({ snapshotOf: () => sessionSnapshot() })
    let sweepCalls = 0
    const budget = fakeBudget({
      check: () => Promise.resolve({ ok: true, verdict: 'allow', line: 'allowed' } satisfies BudgetCheckResult),
      sweep: () => {
        sweepCalls += 1
        return Promise.resolve({ line: `sweep ${String(sweepCalls)}`, problem: null })
      },
    })
    let ownership: OwnershipRead = OWNED_BY_APP
    const dispatcher = createDispatcher(
      baseDeps({
        store,
        launch,
        budget,
        readOwnership: () => Promise.resolve(ownership),
        fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      }),
    )

    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // owner app, launches, starts the session
    expect(dispatcher.status()[0]?.owner).toBe('app')
    expect(sweepCalls).toBe(1)

    ownership = ABSENT_OWNERSHIP // ownership moves back to the terminal cockpit's own startup window
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.owner).toBe('none')
    expect(sweepCalls).toBe(2) // still sweeping — this app's own session may still be live
    expect(dispatcher.status()[0]?.budget?.line).toBe('sweep 2')
  })
})

describe('createDispatcher — the budget gate itself', () => {
  function readyToDispatch(overrides: Partial<CreateDispatcherParams> = {}) {
    const launch = fakeLauncher()
    const store = fakeStore({ snapshotOf: () => sessionSnapshot() })
    const deps = baseDeps({
      store,
      launch,
      fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      ...overrides,
    })
    return { dispatcher: createDispatcher(deps) }
  }

  it('allow launches the candidate — no notes', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'allow', line: 'allowed' }) })
    const { dispatcher } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([])
    expect(dispatcher.status()[0]?.state.kind).toBe('active')
  })

  it('a first hold holds — no launch, a held note carrying the script line', async () => {
    const line = "⏳ Couldn't read #52's cost ledger (unparseable table) — holding its dispatch one tick rather than dispatching blind."
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'hold', line }) })
    const { dispatcher } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'held', number: 52, line }])
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('a second consecutive hold launches anyway, with a held-dispatched note', async () => {
    const line = "⏳ Couldn't read #52's cost ledger (unparseable table) — holding its dispatch one tick rather than dispatching blind."
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'hold', line }) })
    const { dispatcher } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // first hold
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // second hold — launches
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'held-dispatched', number: 52 }])
    expect(dispatcher.status()[0]?.state.kind).toBe('active')
  })

  it('exceeded escalates instead of launching, with an escalated note', async () => {
    const line = '⛔ #52 has consumed 2h 00m of agent wall-clock against a 120m ceiling — escalate instead of dispatching impl #52.'
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'exceeded', line }) })
    const calls: EscalateToHumanParams[] = []
    const escalate: CreateDispatcherParams['escalate'] = (params) => {
      calls.push(params)
      return Promise.resolve({ labels: { kind: 'applied', argv: [] }, comment: { kind: 'applied', argv: [] } })
    }
    const { dispatcher } = readyToDispatch({ budget, escalate })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(calls).toHaveLength(1)
    const escalateParams = calls[0]
    if (escalateParams === undefined) throw new Error('unreachable')
    expect(escalateParams.trigger).toBe('planApproved')
    expect(escalateParams.number).toBe(52)
    expect(escalateParams.body).toContain('## Pipeline Escalation')
    expect(escalateParams.body).toContain(line)
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'escalated', number: 52, needsHumanLabel: 'needs human', commentFailedMessage: null }])
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('escalation-failed carries the outcome, for the renderer to classify', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'exceeded', line: 'over budget' }) })
    const escalate: CreateDispatcherParams['escalate'] = () => Promise.resolve({ labels: { kind: 'terminal-owned', since: '2026-01-01T00:00:00Z' }, comment: null })
    const { dispatcher } = readyToDispatch({ budget, escalate })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    const notes = dispatcher.status()[0]?.budget?.notes
    expect(notes).toEqual([{ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs human', triggerLabel: 'plan approved', outcome: { kind: 'terminal-owned', since: '2026-01-01T00:00:00Z' } }])
  })

  it('a failed gate check drops the candidate — gate-failed note, never a launch', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: false, kind: 'failed', message: 'FAIL  something broke' }) })
    const { dispatcher } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' }])
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('notes are kept when a later pass has nothing to gate', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: false, kind: 'failed', message: 'FAIL  something broke' }) })
    const { dispatcher } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // gate runs, note recorded
    await dispatcher.consider(snapshotWith([tickReport()])) // nothing actionable — no gate this pass
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' }])
  })
})
