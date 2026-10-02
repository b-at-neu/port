// #293: dispatcher-level budget-gate cases — reset-once/sweep-every-pass
// bookkeeping, the fail-closed `budget-unavailable` refusal, and the gate's
// own per-candidate routing (allow/hold/escalate/failed). `dispatcher.test.ts`
// covers everything else; this file is additive, not a duplicate.
import { describe, expect, it, vi } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ClaimRead } from '../writes'
import type { HostedSessionSnapshot, HostedStore, SessionKey } from '../hosting'
import type { TickReport } from '../../shared/tick/types'
import type { EscalateToHumanParams } from '../actions'
import type { ReadyEntry } from '../actions'
import { createDispatcher } from './dispatcher'
import type { CreateDispatcherParams } from './dispatcher'
import type { BudgetCheckResult, BudgetGate, BudgetResetResult, BudgetSweepResult } from './budget-gate'

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

const IMPL_CANDIDATE = { number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }

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

function baseDeps(overrides: Partial<CreateDispatcherParams> = {}): CreateDispatcherParams {
  return {
    store: fakeStore(),
    ledger: { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' }) },
    refreshMemo: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
    writeObservation: () => {
      throw new Error('writeObservation should not be invoked unless a test wires its own')
    },
    drain: () => ({ gate: 'open' }),
    readGateClaim: () => Promise.resolve(HELD_CLAIM),
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
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u1', queued: true }))
    const store = fakeStore({ start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot() }), snapshotOf: () => baseSessionSnapshot(), send })
    let sweepCalls = 0
    const budget = fakeBudget({
      check: () => Promise.resolve({ ok: true, verdict: 'allow', line: 'allowed' } satisfies BudgetCheckResult),
      sweep: () => {
        sweepCalls += 1
        return Promise.resolve({ line: `sweep ${String(sweepCalls)}`, problem: null })
      },
    })
    let claim: ClaimRead = HELD_CLAIM
    const dispatcher = createDispatcher(baseDeps({ store, budget, readGateClaim: () => Promise.resolve(claim), fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }) }))

    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // owner app, dispatches, starts the session
    expect(dispatcher.status()[0]?.owner).toBe('app')
    expect(sweepCalls).toBe(1)

    claim = ABSENT_CLAIM // the claim moves back to the cockpit
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.owner).toBe('cockpit')
    expect(sweepCalls).toBe(2) // still sweeping — this app's own agent may still be live
    expect(dispatcher.status()[0]?.budget?.line).toBe('sweep 2')
  })
})

describe('createDispatcher — the budget gate itself', () => {
  function readyToDispatch(overrides: Partial<CreateDispatcherParams> = {}) {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u1', queued: true }))
    const store = fakeStore({ start: () => Promise.resolve({ ok: true, snapshot: baseSessionSnapshot() }), snapshotOf: () => baseSessionSnapshot(), send })
    const deps = baseDeps({
      store,
      fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'] }], unavailable: [], fetchedAt: 'r' }),
      ...overrides,
    })
    return { dispatcher: createDispatcher(deps), send }
  }

  it('allow dispatches the candidate — no notes', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'allow', line: 'allowed' }) })
    const { dispatcher, send } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(send).toHaveBeenCalledTimes(1)
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([])
    expect(dispatcher.status()[0]?.state.kind).toBe('active')
  })

  it('a first hold holds — no dispatch, a held note carrying the script line', async () => {
    const line = "⏳ Couldn't read #52's cost ledger (unparseable table) — holding its dispatch one tick rather than dispatching blind."
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'hold', line }) })
    const { dispatcher, send } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(send).not.toHaveBeenCalled()
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'held', number: 52, line }])
  })

  it('a second consecutive hold dispatches anyway, with a held-dispatched note', async () => {
    const line = "⏳ Couldn't read #52's cost ledger (unparseable table) — holding its dispatch one tick rather than dispatching blind."
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'hold', line }) })
    const { dispatcher, send } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // first hold
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // second hold — dispatches
    expect(send).toHaveBeenCalledTimes(1)
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'held-dispatched', number: 52 }])
  })

  it('exceeded escalates instead of dispatching, with an escalated note', async () => {
    const line = '⛔ #52 has consumed 2h 00m of agent wall-clock against a 120m ceiling — escalate instead of dispatching impl #52.'
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'exceeded', line }) })
    const calls: EscalateToHumanParams[] = []
    const escalate: CreateDispatcherParams['escalate'] = (params) => {
      calls.push(params)
      return Promise.resolve({ labels: { kind: 'applied', argv: [] }, comment: { kind: 'applied', argv: [] } })
    }
    const { dispatcher, send } = readyToDispatch({ budget, escalate })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(send).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    const escalateParams = calls[0]
    if (escalateParams === undefined) throw new Error('unreachable')
    expect(escalateParams.trigger).toBe('planApproved')
    expect(escalateParams.number).toBe(52)
    expect(escalateParams.body).toContain('## Pipeline Escalation')
    expect(escalateParams.body).toContain(line)
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'escalated', number: 52, needsHumanLabel: 'needs human', commentFailedMessage: null }])
  })

  it('escalation-failed carries the outcome, for the renderer to classify', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: true, verdict: 'exceeded', line: 'over budget' }) })
    const escalate: CreateDispatcherParams['escalate'] = () => Promise.resolve({ labels: { kind: 'unclaimed-scope', scope: 'plan-gate', claimPath: '/x', keys: ['planApproved'] }, comment: null })
    const { dispatcher, send } = readyToDispatch({ budget, escalate })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(send).not.toHaveBeenCalled()
    const notes = dispatcher.status()[0]?.budget?.notes
    expect(notes).toEqual([{ kind: 'escalation-failed', number: 52, needsHumanLabel: 'needs human', triggerLabel: 'plan approved', outcome: { kind: 'unclaimed-scope', scope: 'plan-gate', claimPath: '/x', keys: ['planApproved'] } }])
  })

  it('a failed gate check drops the candidate — gate-failed note, never a dispatch', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: false, kind: 'failed', message: 'FAIL  something broke' }) })
    const { dispatcher, send } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })]))
    expect(send).not.toHaveBeenCalled()
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' }])
  })

  it('notes are kept when a later pass has nothing to gate', async () => {
    const budget = fakeBudget({ check: () => Promise.resolve({ ok: false, kind: 'failed', message: 'FAIL  something broke' }) })
    const { dispatcher } = readyToDispatch({ budget })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: [IMPL_CANDIDATE] })])) // gate runs, note recorded
    await dispatcher.consider(snapshotWith([tickReport()])) // nothing actionable — no gate this pass
    expect(dispatcher.status()[0]?.budget?.notes).toEqual([{ kind: 'gate-failed', number: 52, message: 'FAIL  something broke' }])
  })
})
