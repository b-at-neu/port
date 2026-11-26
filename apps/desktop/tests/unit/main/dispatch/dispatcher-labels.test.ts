import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { SETTLE_GRACE_MS } from '@/main/dispatch/records'
import type { BoardSnapshot } from '@/types/board'
import type { StageLaunchResult } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'
import type { StageOutcome } from '@/types/stage-session'
import type { TickReport } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { dispatchContext, type DispatchContextOptions } from '../../../support/context'
import { sessionSnapshot } from '../../../support/session-snapshot'
import { runOf, ticketOf } from '../../../support/tickets'

const ops = vi.hoisted(() => ({ claim: vi.fn<(params: unknown) => Promise<unknown>>(), transition: vi.fn<(params: unknown) => Promise<unknown>>(), calls: [] as string[] }))
vi.mock('@/main/pipeline/operator/stage', () => ({
  applyStageClaim: (_ctx: unknown, params: unknown) => ops.claim(params),
  applyStageTransition: (_ctx: unknown, params: unknown) => ops.transition(params),
}))

const REPO_ID = 'repo-a' as RepoId
const KEY = 'hosted-1' as SessionKey
const RUN_ID = `run-of-${KEY}`
const ACTIONABLE = [{ number: 52, kind: 'issue' as const, stage: 'implement' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
const APPLIED = { kind: 'applied' as const }
const refused = (reason: 'moved' | 'write-failed', detail: string | null = null) => ({ kind: 'refused' as const, reason, retryable: false, detail })

function snapshotWith(tick: readonly TickReport[]): BoardSnapshot {
  return {
    state: {
      repositories: [{ ok: true, repoId: REPO_ID, repo: 'o/a', displayName: 'o/a', viewer: 'op', items: [], freshness: { github: { at: '2026-01-01T00:00:00Z' } } } as never],
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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const completed = (handback: StageOutcome['handback']): StageOutcome => ({ kind: 'completed', detail: null, costUsd: null, resetsAt: null, worktree: 'removed', operatorJoined: false, handback })
const outcomeOf = (kind: StageOutcome['kind'], detail: string | null = null): StageOutcome => ({ kind, detail, costUsd: null, resetsAt: null, worktree: 'kept', operatorJoined: false, handback: null })
const startedOk = (): Promise<StageLaunchResult> => Promise.resolve({ ok: true, sessionKey: KEY })
const failing = (cause: Extract<StageLaunchResult, { readonly kind: 'failed' }>['cause']) => (): Promise<StageLaunchResult> => Promise.resolve({ ok: false, kind: 'failed', message: 'no worktree', cause })

async function rig(options: DispatchContextOptions & { phase?: () => 'ready' | 'ended' } = {}) {
  const { phase = () => 'ready' as const, launcher = startedOk, ...rest } = options
  const ctx = await dispatchContext({
    owner: 'app',
    items: [{ number: 52, title: 't', labels: ['plan approved'], assignees: ['op'] }],
    tickets: { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 52, stage: 'implement' })] },
    store: { snapshotOf: () => sessionSnapshot({ phase: phase() }) },
    launcher: () => {
      ops.calls.push('launch')
      return launcher({} as never)
    },
    ...rest,
  })
  const record = vi.spyOn(ctx.stores.incidentLog, 'record').mockResolvedValue(undefined)
  const dispatcher = createDispatcher(ctx)
  return { ctx, dispatcher, record, runs: ctx.stores.runs, incidents: () => record.mock.calls.map(([draft]) => draft) }
}

const consider = (dispatcher: ReturnType<typeof createDispatcher>) => dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
function recent(dispatcher: ReturnType<typeof createDispatcher>) {
  const state = dispatcher.status()[0]?.state
  return state?.kind === 'active' ? state.recent : []
}

beforeEach(() => {
  ops.calls.length = 0
  ops.claim.mockReset().mockImplementation(() => {
    ops.calls.push('claim')
    return Promise.resolve(APPLIED)
  })
  ops.transition.mockReset().mockImplementation((params) => {
    ops.calls.push((params as { event: { kind: string } }).event.kind)
    return Promise.resolve(APPLIED)
  })
})

describe('createDispatcher — stage label writes', () => {
  it('claims once, from the pre-launch re-read, before the launch', async () => {
    const { dispatcher } = await rig()
    await consider(dispatcher)
    expect(ops.calls).toEqual(['claim', 'launch'])
    expect(ops.claim.mock.calls[0]?.[0]).toMatchObject({ entry: { id: REPO_ID }, candidate: ACTIONABLE[0], resolved: { number: 52, labels: ['plan approved'] } })
  })

  it("tests survival against the store's labels, so a ticket whose labels were removed on GitHub still launches", async () => {
    const { dispatcher } = await rig({ items: [{ number: 52, title: 't', labels: [], assignees: ['op'] }] })
    await consider(dispatcher)
    expect(ops.calls).toEqual(['claim', 'launch'])
  })

  it.each([
    ['a ticket the store does not track', { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 99, stage: 'implement' })] }],
    ['an unseeded repository', undefined],
  ] as const)('launches nothing for %s, even when GitHub shows the trigger label', async (_name, tickets) => {
    const { dispatcher } = await rig({ tickets })
    await consider(dispatcher)
    expect(ops.calls).toEqual([])
  })

  it('a moved claim launches nothing and records nothing', async () => {
    ops.claim.mockResolvedValue(refused('moved'))
    const { dispatcher } = await rig()
    await consider(dispatcher)
    expect(ops.calls).toEqual([])
    expect(recent(dispatcher)).toEqual([])
  })

  it('any other refused claim records a failed launch with the reason and launches nothing', async () => {
    ops.claim.mockResolvedValue(refused('write-failed', 'boom'))
    const { dispatcher } = await rig()
    await consider(dispatcher)
    expect(ops.calls).toEqual([])
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', sessionKey: null, detail: "port couldn't move the label before starting: write-failed (boom)" }])
  })

  it('a launch that fails rolls the claim back, then records the failure', async () => {
    const { dispatcher } = await rig({ launcher: failing('worktree') })
    await consider(dispatcher)
    expect(ops.transition).toHaveBeenCalledTimes(1)
    expect(ops.transition.mock.calls[0]?.[0]).toMatchObject({ entry: { id: REPO_ID }, record: ACTIONABLE[0], event: { kind: 'rollback' } })
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', detail: 'no worktree' }])
  })

  it('a launch that throws rolls the claim back', async () => {
    const { dispatcher } = await rig({ launcher: () => Promise.reject(new Error('boom')) })
    await consider(dispatcher)
    expect(ops.transition.mock.calls[0]?.[0]).toMatchObject({ event: { kind: 'rollback' } })
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', detail: 'boom' }])
  })

  it('a refused rollback is left to the stall ladder, never thrown', async () => {
    ops.transition.mockResolvedValue(refused('moved'))
    const { dispatcher } = await rig({ launcher: failing('worktree') })
    await expect(consider(dispatcher)).resolves.toBeUndefined()
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed' }])
  })

  it('a successful launch is never rolled back', async () => {
    const { dispatcher } = await rig()
    await consider(dispatcher)
    expect(ops.transition).not.toHaveBeenCalled()
  })

  it('recordOutcome settles the label move through the hand-back write, carrying the captured plan', async () => {
    const { dispatcher } = await rig()
    await consider(dispatcher)
    dispatcher.recordOutcome(REPO_ID, KEY, completed({ token: 'plan-written', arg: null }), { kind: 'read', body: '## Implementation Plan' })
    await settle()
    expect(ops.transition.mock.calls[0]?.[0]).toMatchObject({ record: { number: 52, sessionKey: KEY }, event: { kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan: { kind: 'read', body: '## Implementation Plan' } } })
  })

  it('records the hand-back write result on the ended stage the tick reads', async () => {
    let phase: 'ready' | 'ended' = 'ready'
    ops.transition.mockResolvedValue({ kind: 'refused', reason: 'no-handback', retryable: false, detail: null })
    const { dispatcher, runs } = await rig({ phase: () => phase })
    await consider(dispatcher)
    await runs.ended(REPO_ID, RUN_ID, completed(null))
    dispatcher.recordOutcome(REPO_ID, KEY, completed(null), null)
    await settle()
    phase = 'ended'
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.endedStages(REPO_ID)).toMatchObject([{ agent: 'impl', number: 52, outcome: 'completed', labels: { kind: 'refused', reason: 'no-handback', detail: null } }])
  })

  it('recordResumedTurn writes the next-turn event for a tracked session and ignores an untracked one', async () => {
    const { dispatcher } = await rig()
    await consider(dispatcher)
    dispatcher.recordResumedTurn(REPO_ID, 'hosted-other' as SessionKey)
    await settle()
    expect(ops.transition).not.toHaveBeenCalled()
    dispatcher.recordResumedTurn(REPO_ID, KEY)
    await settle()
    expect(ops.transition.mock.calls[0]?.[0]).toMatchObject({ event: { kind: 'resumed-turn' } })
  })
})

describe('createDispatcher — a resumed session, a superseded outcome and a settling one', () => {
  const RESUMED_KEY = 'hosted-2' as SessionKey

  it('a resumed session’s hand-back writes its labels', async () => {
    const { dispatcher, runs } = await rig()
    await consider(dispatcher)
    await runs.resumed(REPO_ID, RUN_ID, RESUMED_KEY)
    dispatcher.recordOutcome(REPO_ID, RESUMED_KEY, completed({ token: 'pr-opened', arg: '#8' }), null)
    await settle()
    expect(ops.transition.mock.calls[0]?.[0]).toMatchObject({ record: { number: 52, agent: 'impl', trigger: 'planApproved', sessionKey: RESUMED_KEY }, event: { kind: 'outcome', outcome: 'completed' } })
  })

  it('an older session’s outcome writes no label once a newer session owns the ticket, but is still recorded', async () => {
    const { dispatcher, runs } = await rig()
    await consider(dispatcher)
    await runs.ended(REPO_ID, RUN_ID, completed({ token: 'pr-opened', arg: '#8' }))
    await runs.start(REPO_ID, runOf({ id: 'run-2', item: { kind: 'issue', number: 52 }, sessionKey: RESUMED_KEY, startedAt: '2026-01-01T00:10:00.000Z' }))
    dispatcher.recordOutcome(REPO_ID, KEY, completed({ token: 'pr-opened', arg: '#8' }), null)
    await settle()
    expect(ops.transition).not.toHaveBeenCalled()
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(recent(dispatcher).find((r) => r.sessionKey === KEY)?.outcome).toMatchObject({ kind: 'completed' })
  })

  it('a session that just ended with no classified outcome counts as live until the grace passes', async () => {
    let phase: 'ready' | 'ended' = 'ready'
    const { ctx, dispatcher } = await rig({ phase: () => phase })
    await consider(dispatcher)
    expect(dispatcher.stageLiveness(REPO_ID)?.live).toEqual(['impl #52'])
    phase = 'ended'
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.liveStages(REPO_ID)).toEqual([])
    expect(dispatcher.stageLiveness(REPO_ID)?.live).toEqual(['impl #52'])
    ctx.clock.advance(SETTLE_GRACE_MS + 1)
    expect(dispatcher.stageLiveness(REPO_ID)?.live).toEqual([])
  })

  it('a ticket whose hand-back write is still being retried stays live past the grace', async () => {
    let phase: 'ready' | 'ended' = 'ready'
    ops.transition.mockResolvedValue({ kind: 'refused', reason: 'write-failed', retryable: true, detail: 'EAI_AGAIN' })
    const { ctx, dispatcher } = await rig({ phase: () => phase })
    await consider(dispatcher)
    dispatcher.recordOutcome(REPO_ID, KEY, completed({ token: 'pr-opened', arg: '#8' }), null)
    await settle()
    phase = 'ended'
    await dispatcher.consider(snapshotWith([tickReport()]))
    ctx.clock.advance(SETTLE_GRACE_MS * 3)
    expect(dispatcher.stageLiveness(REPO_ID)?.live).toEqual(['impl #52'])
  })
})

describe('createDispatcher — incidents', () => {
  it('raises launch-failed with the failed step as its condition', async () => {
    const { dispatcher, incidents } = await rig({ launcher: failing('worktree') })
    await consider(dispatcher)
    expect(incidents()).toMatchObject([{ bucket: 'launch-failed', stage: 'impl', condition: 'worktree', repo: 'o/a', number: 52, kind: 'issue', outcome: { kind: 'failed' } }])
  })

  it('raises leftover-worktree when a leftover worktree refused its reclaim', async () => {
    const { dispatcher, incidents } = await rig({ launcher: failing('leftover-worktree') })
    await consider(dispatcher)
    expect(incidents()).toMatchObject([{ bucket: 'leftover-worktree', condition: 'leftover-worktree' }])
  })

  it('raises launch-failed for a refused claim and for a launch that throws, but nothing for a moved claim', async () => {
    ops.claim.mockResolvedValue(refused('write-failed', 'boom'))
    const refusedClaim = await rig()
    await consider(refusedClaim.dispatcher)
    expect(refusedClaim.incidents()).toMatchObject([{ bucket: 'launch-failed', condition: 'claim-write-failed' }])

    ops.claim.mockResolvedValue(APPLIED)
    const threw = await rig({ launcher: () => Promise.reject(new Error('boom')) })
    await consider(threw.dispatcher)
    expect(threw.incidents()).toMatchObject([{ bucket: 'launch-failed', condition: 'threw' }])

    ops.claim.mockResolvedValue(refused('moved'))
    const moved = await rig()
    await consider(moved.dispatcher)
    expect(moved.incidents()).toEqual([])
  })

  it('raises launch-failed ended-fast for a session that ends within seconds of starting, and nothing later', async () => {
    const fast = await rig()
    await consider(fast.dispatcher)
    fast.ctx.clock.advance(5000)
    fast.dispatcher.recordOutcome(REPO_ID, KEY, outcomeOf('completed'), null)
    expect(fast.incidents()).toMatchObject([{ bucket: 'launch-failed', condition: 'ended-fast', number: 52 }])

    const slow = await rig()
    await consider(slow.dispatcher)
    slow.ctx.clock.advance(300_000)
    slow.dispatcher.recordOutcome(REPO_ID, KEY, outcomeOf('completed'), null)
    expect(slow.incidents()).toEqual([])
  })

  it('raises network-interrupt for a transient failure, without the host name', async () => {
    const made = await rig()
    await consider(made.dispatcher)
    made.ctx.clock.advance(600_000)
    made.dispatcher.recordOutcome(REPO_ID, KEY, outcomeOf('interrupted', 'getaddrinfo ENOTFOUND api.anthropic.com'), null)
    expect(made.incidents()).toMatchObject([{ bucket: 'network-interrupt', stage: 'impl', condition: 'network', inputs: { sessionKey: KEY, outcome: 'interrupted' } }])
    expect(JSON.stringify(made.incidents())).not.toContain('api.anthropic.com')
  })

  it('never lets a failing recorder change the dispatch', async () => {
    const { dispatcher, record } = await rig({ launcher: failing('worktree') })
    record.mockRejectedValue(new Error('disk full'))
    await expect(consider(dispatcher)).resolves.toBeUndefined()
    expect(recent(dispatcher)).toMatchObject([{ state: 'failed', detail: 'no worktree' }])
  })

  it("hands the hand-back write the tick's view of the ticket and its read instant", async () => {
    const { dispatcher } = await rig()
    await consider(dispatcher)
    dispatcher.recordOutcome(REPO_ID, KEY, completed({ token: 'pr-opened', arg: '#8' }), null)
    await settle()
    expect(ops.transition.mock.calls[0]?.[0]).toMatchObject({ snapshot: { item: null } })
  })
})
