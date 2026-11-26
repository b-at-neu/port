import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import type { TickActionable, TickReport } from '@/types/tick'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { dispatchContext } from '../../../support/context'
import { sessionSnapshot } from '../../../support/session-snapshot'
import { ticketOf } from '../../../support/tickets'

vi.mock('@/main/pipeline/operator/stage', () => ({
  applyStageClaim: () => Promise.resolve({ kind: 'applied' }),
  applyStageTransition: () => Promise.resolve({ kind: 'applied' }),
}))

const REPO_ID = 'repo-a' as RepoId
const SESSION_KEY = 'hosted-1' as SessionKey

function outcome(kind: StageOutcome['kind']): StageOutcome {
  return { kind, detail: null, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null }
}

function candidate(number: number): TickActionable {
  return { number, kind: 'issue', stage: 'implement', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }
}

function snapshotCarrying(...numbers: readonly number[]): BoardSnapshot {
  const tick: TickReport = { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: numbers.map(candidate), held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [] }
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op', items: [], freshness: { github: { at: '2026-01-01T00:00:00Z' } } } as never],
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
    autoPlan: [],
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function harness({ holdFirstPass = false }: { holdFirstPass?: boolean } = {}) {
  const launched: number[] = []
  const ctx = await dispatchContext({
    owner: 'app',
    items: [52, 53].map((number) => ({ number, title: 't', labels: ['plan approved'], assignees: ['op'] })),
    tickets: { repoId: REPO_ID, tickets: [52, 53].map((ticket) => ticketOf({ repo: REPO_ID, ticket, stage: 'implement' })) },
    store: { snapshotOf: () => sessionSnapshot({ sessionKey: SESSION_KEY }) },
    launcher: (request) => {
      launched.push(request.number)
      return Promise.resolve({ ok: true, sessionKey: SESSION_KEY })
    },
  })
  // The first pass hangs on its ownership read until released, so later snapshots arrive while it is in flight.
  let release: () => void = () => undefined
  if (holdFirstPass) {
    const real = ctx.git
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(ctx, 'git').mockImplementationOnce(async (...args) => {
      await held
      return real(...args)
    })
  }
  return { ctx, dispatcher: createDispatcher(ctx), launched, release: () => release() }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('createDispatcher — coalesced passes', () => {
  it('three snapshots during one pass produce one follow-up pass, which reads the third', async () => {
    const { dispatcher, launched, release } = await harness({ holdFirstPass: true })
    const first = dispatcher.consider(snapshotCarrying())
    await flush()
    const second = dispatcher.consider(snapshotCarrying(53))
    const third = dispatcher.consider(snapshotCarrying(52))
    await flush()
    expect(launched).toEqual([])

    release()
    await Promise.all([first, second, third])
    await flush()

    expect(launched).toEqual([52])
  })

  it('runs no follow-up pass once shutdown has run', async () => {
    const { dispatcher, launched, release } = await harness({ holdFirstPass: true })
    const first = dispatcher.consider(snapshotCarrying())
    await flush()
    const second = dispatcher.consider(snapshotCarrying(52))
    await flush()

    dispatcher.shutdown()
    release()
    await Promise.all([first, second])
    await flush()

    expect(launched).toEqual([])
  })
})

describe('createDispatcher — read on hand-back', () => {
  async function trackedSession() {
    const rig = await harness()
    await rig.dispatcher.consider(snapshotCarrying(52))
    expect(rig.launched).toEqual([52])
    return rig
  }

  it('a completed hand-back requests exactly one read for its repository, once its label write has settled', async () => {
    const { ctx, dispatcher } = await trackedSession()
    dispatcher.recordOutcome(REPO_ID, SESSION_KEY, outcome('completed'), null)
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
    await flush()
    expect(ctx.watcher.refresh).toHaveBeenCalledTimes(1)
    expect(ctx.watcher.refresh).toHaveBeenCalledWith({ repoId: REPO_ID, source: 'github' })
  })

  it.each(['questions', 'error', 'interrupted'] as const)('a %s hand-back requests no read', async (kind) => {
    const { ctx, dispatcher } = await trackedSession()
    dispatcher.recordOutcome(REPO_ID, SESSION_KEY, outcome(kind), null)
    await flush()
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })

  it('a hand-back for an untracked session requests no read', async () => {
    const { ctx, dispatcher } = await trackedSession()
    dispatcher.recordOutcome(REPO_ID, 'hosted-other' as SessionKey, outcome('completed'), null)
    await flush()
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })
})
