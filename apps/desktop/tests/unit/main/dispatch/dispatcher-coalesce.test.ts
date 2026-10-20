import { describe, expect, it, vi } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import type { TickActionable, TickReport } from '@/types/tick'
import type { ReadyEntry } from '@/types/actions'
import type { CreateDispatcherParams, OwnershipRead, StageLaunchRequest } from '@/types/dispatch'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { DISPATCH_STORE_DEFAULTS, storeStub } from '../../../fixtures/store'

const REPO_ID = 'repo-a' as RepoId
const SESSION_KEY = 'hosted-1' as SessionKey
const OWNED_BY_APP: OwnershipRead = { kind: 'app', since: '2026-01-01T00:00:00Z', path: '/repo/.agents/cockpit.json', readAt: 'r' }

function outcome(kind: StageOutcome['kind']): StageOutcome {
  return { kind, detail: null, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false }
}

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

function candidate(number: number): TickActionable {
  return { number, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }
}

function snapshotCarrying(...numbers: readonly number[]): BoardSnapshot {
  const tick: TickReport = { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: numbers.map(candidate), held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [] }
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op' } as never],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00Z' },
      readAt: '2026-01-01T00:00:00Z',
    },
    health: [],
    policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 },
    tick: [tick],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: '2026-01-01T00:00:00Z',
    dispatch: [],
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<CreateDispatcherParams> = {}) {
  const launched: number[] = []
  const requestRead = vi.fn()
  let ownershipReads = 0
  let releaseFirstOwnership: () => void = () => undefined
  const deps: CreateDispatcherParams = {
    store: storeStub({ ...DISPATCH_STORE_DEFAULTS, snapshotOf: () => ({ phase: 'ready', claudeSessionId: null, operatorJoinedAt: null }) as unknown as HostedSessionSnapshot }),
    launch: {
      launch: (request: StageLaunchRequest) => {
        launched.push(request.number)
        return Promise.resolve({ ok: true, sessionKey: SESSION_KEY })
      },
    },
    ledger: { record: vi.fn(), advance: vi.fn(), rowFor: () => undefined, observeUnmatched: () => ({ class: 'no-record' }) },
    refreshMemo: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
    forceDispatch: { has: () => false, set: vi.fn(), clear: vi.fn(), prune: vi.fn() },
    writeObservation: () => {
      throw new Error('writeObservation should not be invoked')
    },
    runState: () => 'dispatching',
    // The first read hangs until released, so a pass is in flight while later snapshots arrive.
    readOwnership: () => {
      ownershipReads += 1
      if (ownershipReads > 1) return Promise.resolve(OWNED_BY_APP)
      return new Promise((resolve) => {
        releaseFirstOwnership = () => resolve(OWNED_BY_APP)
      })
    },
    takeOwnership: () => Promise.resolve({ ok: true, path: 'p' }),
    fetchItemsByNumber: (params) =>
      Promise.resolve({
        ok: true,
        resolved: params.numbers.map((number) => ({ number, kind: 'issue' as const, state: 'OPEN' as const, mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['plan approved'], assignees: ['op'], headRefName: null })),
        unavailable: [],
        fetchedAt: 'r',
      }),
    listRepositories: () => Promise.resolve({ ok: true, repositories: [entry()] }),
    registryDeps: { registryDir: '/registry', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
    budget: {
      reset: () => {
        throw new Error('budget.reset should not be invoked')
      },
      sweep: () => {
        throw new Error('budget.sweep should not be invoked')
      },
      check: () => {
        throw new Error('budget.check should not be invoked')
      },
    },
    escalate: () => {
      throw new Error('escalate should not be invoked')
    },
    requestRead,
    dirs: { audit: '/audit', scratch: '/scratch' },
    onChange: vi.fn(),
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
  return { dispatcher: createDispatcher(deps), launched, requestRead, ownershipReads: () => ownershipReads, releaseFirstOwnership: () => releaseFirstOwnership() }
}

describe('createDispatcher — coalesced passes', () => {
  it('three snapshots during one pass produce one follow-up pass, which reads the third', async () => {
    const { dispatcher, launched, ownershipReads, releaseFirstOwnership } = harness()
    const first = dispatcher.consider(snapshotCarrying())
    await flush()
    const second = dispatcher.consider(snapshotCarrying(53))
    const third = dispatcher.consider(snapshotCarrying(52))
    await flush()
    expect(ownershipReads()).toBe(1)

    releaseFirstOwnership()
    await Promise.all([first, second, third])
    await flush()

    expect(ownershipReads()).toBe(2)
    expect(launched).toEqual([52])
  })

  it('runs no follow-up pass once shutdown has run', async () => {
    const { dispatcher, launched, ownershipReads, releaseFirstOwnership } = harness()
    const first = dispatcher.consider(snapshotCarrying())
    await flush()
    const second = dispatcher.consider(snapshotCarrying(52))
    await flush()

    dispatcher.shutdown()
    releaseFirstOwnership()
    await Promise.all([first, second])
    await flush()

    expect(ownershipReads()).toBe(1)
    expect(launched).toEqual([])
  })
})

describe('createDispatcher — read on hand-back', () => {
  async function trackedSession() {
    const rig = harness({ readOwnership: () => Promise.resolve(OWNED_BY_APP) })
    await rig.dispatcher.consider(snapshotCarrying(52))
    expect(rig.launched).toEqual([52])
    return rig
  }

  it('a completed hand-back requests exactly one read for its repository', async () => {
    const { dispatcher, requestRead } = await trackedSession()
    dispatcher.recordOutcome(REPO_ID, SESSION_KEY, outcome('completed'))
    expect(requestRead).toHaveBeenCalledTimes(1)
    expect(requestRead).toHaveBeenCalledWith(REPO_ID)
  })

  it.each(['questions', 'blocked', 'error', 'usage-limit', 'interrupted'] as const)('a %s hand-back requests no read', async (kind) => {
    const { dispatcher, requestRead } = await trackedSession()
    dispatcher.recordOutcome(REPO_ID, SESSION_KEY, outcome(kind))
    expect(requestRead).not.toHaveBeenCalled()
  })

  it('a hand-back for an untracked session requests no read', async () => {
    const { dispatcher, requestRead } = await trackedSession()
    dispatcher.recordOutcome(REPO_ID, 'hosted-other' as SessionKey, outcome('completed'))
    expect(requestRead).not.toHaveBeenCalled()
  })
})
