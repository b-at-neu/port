// An app restart and a system sleep during an active run, ending with no finished work re-dispatched.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { planTick } from '@/main/pipeline/tick/plan'
import { createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import type { BoardSnapshot } from '@/types/board'
import type { AppContext } from '@/main/app/context'
import type { SessionKey } from '@/types/hosting'
import type { StageEvent } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
import type { TickReport } from '@/types/tick'
import type { PlatformFs } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { createTestContext, freshMemos } from '../../../support/context'
import { createFakeFs } from '../../../support/fake-platform'
import { createFakeGitHub } from '../../../support/fake-github'
import { readyEntry } from '../../../support/repo-config'
import { scriptedStage } from '../../../support/stage'
import { ticketOf } from '../../../support/tickets'

const hoisted = vi.hoisted(() => ({ events: [] as StageEvent[] }))
vi.mock('@/main/pipeline/operator/stage', () => ({
  applyStageClaim: () => Promise.resolve({ kind: 'applied' }),
  applyStageTransition: (_ctx: unknown, params: { event: StageEvent }) => {
    hoisted.events.push(params.event)
    return Promise.resolve({ kind: 'applied' })
  },
}))

vi.mock('@/main/pipeline/state/labels', async (original) => ({ ...(await original<object>()), storedLabels: () => ['plan approved'] }))

const REPO = 'repo-a' as RepoId
const STATE_FILE = '/test/userData/pipeline-state.json'
const ACTIONABLE = [{ number: 52, kind: 'issue' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
const COMPLETED: StageOutcome = { kind: 'completed', detail: null, costUsd: 1, resetsAt: null, worktree: 'removed', operatorJoined: false, handback: { token: 'pr-opened', arg: '#8' } }

/** The disk an app run leaves behind: ticket 52 claimed and running, no run recorded yet. */
async function diskWithClaimedTicket(): Promise<PlatformFs> {
  const fs = createFakeFs()
  const ticket = ticketOf({ repo: REPO, ticket: 52, stage: 'implement', status: { kind: 'running', runId: null } })
  await fs.writeJsonAtomic(STATE_FILE, { version: 3, dispatch: {}, repositories: { [REPO]: { seededAt: '2026-01-01T00:00:00.000Z', tickets: { '52': ticket } } } })
  return fs
}

/** One run of the app over `fs`: a restart is a second call over the same disk. */
async function boot(fs: PlatformFs) {
  const github = createFakeGitHub({ viewer: 'viewer', items: [{ number: 52, title: 't', labels: ['plan approved'], assignees: ['op'] }] })
  const watcher = { republish: vi.fn(), refresh: vi.fn(() => Promise.resolve({} as BoardSnapshot)), snapshot: () => boardSnapshot() }
  const live: { -readonly [K in keyof AppContext['live']]?: AppContext['live'][K] } = { memos: freshMemos(), watcher: watcher as unknown as AppContext['live']['watcher'] }
  const entry = readyEntry()
  const ctx = createTestContext({ platform: { ...github.platform, fs }, repositories: [entry], live })
  await ctx.ready
  await ctx.fs.writeText(`${entry.path}/.agents/cockpit.json`, JSON.stringify({ repo: entry.config.repo, owner: 'app', since: '2026-01-01T00:00:00Z' }))
  await ctx.stores.runStates.set([REPO], 'dispatching', ctx.clock.now().toISOString())
  const stage = scriptedStage(ctx.stores.runs, REPO, ctx.clock.now)
  live.hostedStore = stage.store
  live.stageLauncher = stage.launcher as unknown as AppContext['live']['stageLauncher']
  const dispatcher = createDispatcher(ctx)
  return { ctx, stage, dispatcher, events: hoisted.events, runs: ctx.stores.runs }
}

const tickReport = (overrides: Partial<TickReport> = {}): TickReport => ({ repoId: REPO, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [], ...overrides })
const snapshotWith = (...tick: TickReport[]): BoardSnapshot => boardSnapshot([repositoryState([])], undefined, { tick })

/** What the tick makes of ticket 52 still claimed, given the dispatcher's liveness and the runs on disk. */
function tickOver(app: Awaited<ReturnType<typeof boot>>, readAt: string): TickReport {
  const claimed = reconciledItem({ number: 52, kind: 'issue', stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], stageHistory: [{ key: 'inProgress', actor: null, at: '2026-01-01T00:00:00.000Z' }] })
  return planTick({
    repository: repositoryState([claimed], {}, readAt),
    runsOf: (repoId, kind, number) => app.runs.runsOf(repoId, kind, number),
    stageLiveness: app.dispatcher.stageLiveness(REPO),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date(readAt),
    now: () => new Date(readAt),
    reviewCycleCap: 5,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: {},
    holdSessionRequired: false,
  })
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('restart and sleep during an active run', () => {
  beforeEach(() => {
    hoisted.events.length = 0
  })

  it('a restart mid-run reads the run as a crash, keeps its claim interrupted, and launches nothing', async () => {
    const fs = await diskWithClaimedTicket()
    const before = await boot(fs)
    await before.dispatcher.consider(snapshotWith(tickReport({ actionable: ACTIONABLE })))
    expect(before.stage.launches).toHaveLength(1)

    const after = await boot(fs)
    expect(after.runs.list()).toMatchObject([{ id: 'run-1', reason: 'crash', number: 52 }])
    await after.dispatcher.consider(snapshotWith(tickReport()))
    const tick = tickOver(after, '2026-01-01T01:00:00.000Z')
    expect(tick.claims).toMatchObject([{ number: 52, class: 'interrupted' }])
    await after.dispatcher.consider(snapshotWith(tick))
    expect(after.stage.launches).toHaveLength(0)
    expect(after.events).toEqual([])
  })

  it('a restart after a hand-back that never reached its label settles it once, and launches nothing', async () => {
    const fs = await diskWithClaimedTicket()
    const before = await boot(fs)
    await before.dispatcher.consider(snapshotWith(tickReport({ actionable: ACTIONABLE })))
    await before.stage.handBack('hosted-1' as SessionKey, COMPLETED)
    expect(before.events).toEqual([])

    const after = await boot(fs)
    await after.dispatcher.consider(snapshotWith(tickReport()))
    await vi.waitFor(() => expect(after.events).toHaveLength(1))
    expect(after.events[0]).toMatchObject({ kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null })

    await after.dispatcher.consider(snapshotWith(tickReport()))
    await settled()
    expect(after.events).toHaveLength(1)
    expect(after.stage.launches).toHaveLength(0)
    const tick = tickOver(after, '2026-01-01T01:00:00.000Z')
    expect(tick.claims).toMatchObject([{ number: 52, class: 'capped' }])
    expect(tick.observations.filter((o) => o.kind === 'liveness-reset')).toEqual([])
  })

  it('a sleep with the session live keeps the claim matched, and the hand-back after the wake lands once', async () => {
    const fs = await diskWithClaimedTicket()
    const app = await boot(fs)
    await app.dispatcher.consider(snapshotWith(tickReport({ actionable: ACTIONABLE })))
    expect(app.stage.launches).toHaveLength(1)

    app.ctx.clock.advance(9 * 60 * 60 * 1000)
    await app.dispatcher.consider(snapshotWith(tickReport()))
    expect(app.dispatcher.stageLiveness(REPO)?.live).toEqual(['impl #52'])
    expect(tickOver(app, app.ctx.clock.now().toISOString()).claims).toMatchObject([{ number: 52, class: 'matched' }])

    await app.stage.handBack('hosted-1' as SessionKey, COMPLETED)
    app.dispatcher.recordOutcome(REPO, 'hosted-1' as SessionKey, COMPLETED, null)
    await vi.waitFor(() => expect(app.events).toHaveLength(1))
    await app.dispatcher.consider(snapshotWith(tickReport()))
    await settled()
    expect(app.events).toHaveLength(1)
    expect(app.stage.launches).toHaveLength(1)
  })
})
