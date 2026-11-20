import { describe, expect, it, vi } from 'vitest'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import type { BoardSnapshot } from '@/types/board'
import type { ReadyEntry } from '@/types/actions'
import type { CreateDispatcherParams, OwnershipRead, StageLabelWrites, StageLaunchResult, StageLauncher } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageEvent, StageTransitionResult } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { TickReport } from '@/types/tick'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import { memoryDenialStore } from '../../../fixtures/denials'
import { DISPATCH_STORE_DEFAULTS, storeStub } from '../../../fixtures/store'

const REPO_ID = 'repo-a' as RepoId
const KEY = 'hosted-1' as SessionKey
const OWNED_BY_APP: OwnershipRead = { kind: 'app', since: '2026-01-01T00:00:00Z', path: '/repo/.agents/cockpit.json', readAt: 'r' }
const ACTIONABLE = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
const APPLIED = { kind: 'applied' as const }
const refused = (reason: 'moved' | 'write-failed', detail: string | null = null) => ({ kind: 'refused' as const, reason, retryable: false, detail })

function entry(): ReadyEntry {
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
      sessionRequiredPaths: [],
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
    autoPlan: [],
  }
}

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [], ...overrides }
}

const live = (phase: 'ready' | 'ended' = 'ready') => ({ phase, claudeSessionId: null, operatorJoinedAt: null }) as unknown as HostedSessionSnapshot
const launcher = (launch: () => Promise<StageLaunchResult>): StageLauncher => ({ launch })

function rig(overrides: Partial<CreateDispatcherParams> = {}) {
  const calls: string[] = []
  const claim = vi.fn<StageLabelWrites['claim']>(() => {
    calls.push('claim')
    return Promise.resolve(APPLIED)
  })
  const transition = vi.fn((params: { readonly event: StageEvent }) => {
    calls.push(params.event.kind)
    return Promise.resolve<StageTransitionResult>(APPLIED)
  })
  const deps: CreateDispatcherParams = {
    store: storeStub({ ...DISPATCH_STORE_DEFAULTS, snapshotOf: () => live() }),
    denials: memoryDenialStore(),
    ledger: { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' }) },
    refreshMemo: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
    forceDispatch: { has: () => false, set: vi.fn(), clear: vi.fn(), prune: vi.fn() },
    writeObservation: () => {
      throw new Error('writeObservation should not be invoked')
    },
    launch: launcher(() => {
      calls.push('launch')
      return Promise.resolve({ ok: true, sessionKey: KEY })
    }),
    stageLabels: { claim, transition },
    runState: () => 'dispatching',
    readOwnership: () => Promise.resolve(OWNED_BY_APP),
    takeOwnership: () => Promise.resolve({ ok: true, path: 'p' }),
    fetchItemsByNumber: () => Promise.resolve({ ok: true, resolved: [{ number: 52, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'], headRefName: null, author: null }], unavailable: [], fetchedAt: 'r' }),
    listRepositories: () => Promise.resolve({ ok: true, repositories: [entry()] }),
    registryDeps: { registryDir: '/registry', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
    budget: {
      reset: () => {
        throw new Error('budget should not be invoked')
      },
      sweep: () => {
        throw new Error('budget should not be invoked')
      },
      check: () => {
        throw new Error('budget should not be invoked')
      },
      report: () => {
        throw new Error('budget should not be invoked')
      },
    },
    escalate: () => {
      throw new Error('escalate should not be invoked')
    },
    requestRead: () => undefined,
    dirs: { audit: '/audit', scratch: '/scratch' },
    onChange: vi.fn(),
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
  return { dispatcher: createDispatcher(deps), calls, claim, transition }
}

const consider = (dispatcher: ReturnType<typeof createDispatcher>) => dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
function recent(dispatcher: ReturnType<typeof createDispatcher>) {
  const state = dispatcher.status()[0]?.state
  return state?.kind === 'active' ? state.recent : []
}
function completed(handback: StageOutcome['handback']): StageOutcome {
  return { kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed', operatorJoined: false, handback }
}

describe('createDispatcher — stage label writes', () => {
  it('claims once, from the pre-launch re-read, before the launch', async () => {
    const { dispatcher, calls, claim } = rig()
    await consider(dispatcher)
    expect(calls).toEqual(['claim', 'launch'])
    expect(claim).toHaveBeenCalledTimes(1)
    expect(claim.mock.calls[0]?.[0]).toMatchObject({ entry: { id: REPO_ID }, candidate: ACTIONABLE[0], resolved: { number: 52, labels: ['plan approved'] }, auditDir: '/audit' })
  })

  it('tests survival against the store\'s labels, so a ticket whose labels were removed on GitHub still launches', async () => {
    const withoutLabels = () => Promise.resolve({ ok: true as const, resolved: [{ number: 52, kind: 'issue' as const, state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: ['op'], headRefName: null, author: null }], unavailable: [], fetchedAt: 'r' })
    const { dispatcher, calls } = rig({ fetchItemsByNumber: withoutLabels, stateLabels: () => ['claude', 'plan approved'] })
    await consider(dispatcher)
    expect(calls).toEqual(['claim', 'launch'])
  })

  it('launches nothing for a ticket the store does not track, even when GitHub shows its trigger label', async () => {
    const { dispatcher, calls } = rig({ stateLabels: () => [] })
    await consider(dispatcher)
    expect(calls).toEqual([])
  })

  it('a moved claim launches nothing and records nothing', async () => {
    const { dispatcher, calls } = rig({ stageLabels: { claim: () => Promise.resolve(refused('moved')), transition: () => Promise.resolve(APPLIED) } })
    await consider(dispatcher)
    expect(calls).toEqual([])
    expect(recent(dispatcher)).toEqual([])
  })

  it('any other refused claim records a failed launch with the reason and launches nothing', async () => {
    const launch = vi.fn()
    const { dispatcher } = rig({ launch: { launch }, stageLabels: { claim: () => Promise.resolve(refused('write-failed', 'boom')), transition: () => Promise.resolve(APPLIED) } })
    await consider(dispatcher)
    expect(launch).not.toHaveBeenCalled()
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', sessionKey: null, detail: "port couldn't move the label before starting: write-failed (boom)" }])
  })

  it('a launch that fails rolls the claim back, then records the failure', async () => {
    const { dispatcher, transition } = rig({ launch: launcher(() => Promise.resolve({ ok: false, kind: 'failed', message: 'no worktree' })) })
    await consider(dispatcher)
    expect(transition).toHaveBeenCalledTimes(1)
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ entry: { id: REPO_ID }, record: ACTIONABLE[0], event: { kind: 'rollback' }, auditDir: '/audit' })
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', detail: 'no worktree' }])
  })

  it('an at-capacity launch rolls the claim back and holds the candidate as waiting', async () => {
    const { dispatcher, transition } = rig({ launch: launcher(() => Promise.resolve({ ok: false, kind: 'at-capacity', limit: 4 })) })
    await consider(dispatcher)
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ event: { kind: 'rollback' } })
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'at-capacity', limit: 4, waiting: 1 })
  })

  it('a launch that throws rolls the claim back', async () => {
    const { dispatcher, transition } = rig({ launch: launcher(() => Promise.reject(new Error('boom'))) })
    await consider(dispatcher)
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ event: { kind: 'rollback' } })
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', detail: 'boom' }])
  })

  it('a refused rollback is left to the stall ladder, never thrown', async () => {
    const { dispatcher } = rig({ launch: launcher(() => Promise.resolve({ ok: false, kind: 'failed', message: 'no worktree' })), stageLabels: { claim: () => Promise.resolve(APPLIED), transition: () => Promise.resolve(refused('moved')) } })
    await expect(consider(dispatcher)).resolves.toBeUndefined()
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed' }])
  })

  it('a successful launch is never rolled back', async () => {
    const { dispatcher, transition } = rig()
    await consider(dispatcher)
    expect(transition).not.toHaveBeenCalled()
  })

  it('recordOutcome settles the label move through the hand-back write', async () => {
    const { dispatcher, transition } = rig()
    await consider(dispatcher)
    dispatcher.recordOutcome(REPO_ID, KEY, completed({ token: 'pr-opened', arg: '#8' }), null)
    await settle()
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ record: { number: 52, sessionKey: KEY }, event: { kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null } })
  })

  it('recordOutcome carries the captured plan file to the write', async () => {
    const { dispatcher, transition } = rig()
    await consider(dispatcher)
    dispatcher.recordOutcome(REPO_ID, KEY, completed({ token: 'plan-written', arg: null }), { kind: 'read', body: '## Implementation Plan' })
    await settle()
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ event: { plan: { kind: 'read', body: '## Implementation Plan' } } })  })

  it('records the hand-back write result on the ended stage the tick reads', async () => {
    let phase: 'ready' | 'ended' = 'ready'
    const { dispatcher } = rig({
      store: storeStub({ ...DISPATCH_STORE_DEFAULTS, snapshotOf: () => live(phase) }),
      stageLabels: { claim: () => Promise.resolve(APPLIED), transition: () => Promise.resolve({ kind: 'refused', reason: 'no-handback', retryable: false, detail: null }) },
    })
    await consider(dispatcher)
    dispatcher.recordOutcome(REPO_ID, KEY, completed(null), null)
    await settle()
    phase = 'ended'
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.endedStages(REPO_ID)).toMatchObject([{ agent: 'impl', number: 52, outcome: 'completed', labels: { kind: 'refused', reason: 'no-handback', detail: null } }])
  })

  it('recordResumedTurn writes the next-turn event for a tracked session and ignores an untracked one', async () => {
    const { dispatcher, transition } = rig()
    await consider(dispatcher)
    dispatcher.recordResumedTurn(REPO_ID, 'hosted-other' as SessionKey)
    await settle()
    expect(transition).not.toHaveBeenCalled()
    dispatcher.recordResumedTurn(REPO_ID, KEY)
    await settle()
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ event: { kind: 'resumed-turn' } })
  })
})
