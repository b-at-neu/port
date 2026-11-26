import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { SessionKey } from '@/types/hosting'
import type { TickActionable, TickReport } from '@/types/tick'
import type { StageLaunchResult } from '@/types/dispatch'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { DISPATCH_PROMPT, promptFor, REFRESH_PROMPT } from '@/main/dispatch/launch'
import { boardSnapshot, repositoryState } from '../../../support/board-snapshot'
import { dispatchContext, type DispatchContextOptions } from '../../../support/context'
import { memoryRuns } from '../../../support/state-store'
import { NOW, runOf, ticketOf } from '../../../support/tickets'
import { sessionSnapshot } from '../../../support/session-snapshot'

const ops = vi.hoisted(() => ({ claim: vi.fn(), transition: vi.fn() }))
vi.mock('@/main/pipeline/operator/stage', () => ({
  applyStageClaim: (_ctx: unknown, params: unknown) => ops.claim(params) as unknown,
  applyStageTransition: (_ctx: unknown, params: unknown) => ops.transition(params) as unknown,
}))

const REPO_ID = 'repo-a' as RepoId
const WITH_TICKETS = { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 52, stage: 'implement' }), ticketOf({ repo: REPO_ID, ticket: 46, pr: { number: 47, approvedAt: null }, stage: 'review' })] }
const ISSUE_52 = { number: 52, title: 't', labels: ['plan approved'], assignees: ['op'] }
const ACTIONABLE = [{ number: 52, kind: 'issue' as const, stage: 'implement' as const, trigger: 'planApproved' as const, agent: 'impl' as const, unchecked: false, cycle: null }]
const OK_LAUNCH: StageLaunchResult = { ok: true, sessionKey: 'hosted-1' as SessionKey }

function tickReport(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [], ...overrides }
}

function snapshotWith(tick: readonly TickReport[]): BoardSnapshot {
  return boardSnapshot([repositoryState([])], undefined, { tick })
}

/** An owned repository whose one ticket sits at plan approved, with a launcher that starts `hosted-1`. */
async function owned(overrides: DispatchContextOptions = {}) {
  const launches: unknown[] = []
  const ctx = await dispatchContext({
    owner: 'app',
    items: [ISSUE_52],
    tickets: WITH_TICKETS,
    store: { snapshotOf: () => sessionSnapshot() },
    launcher: (request) => {
      launches.push(request)
      return Promise.resolve(OK_LAUNCH)
    },
    ...overrides,
  })
  return { ctx, dispatcher: createDispatcher(ctx), launches }
}

beforeEach(() => {
  ops.claim.mockReset().mockResolvedValue({ kind: 'applied' })
  ops.transition.mockReset().mockResolvedValue({ kind: 'applied' })
})

describe('createDispatcher — ownership', () => {
  it.each([
    ['unreadable', 'unreadable', expect.stringContaining('terminal') as unknown],
    ['app', 'app', null],
  ] as const)('reports %s for the record on disk', async (owner, expected, message) => {
    const ctx = await dispatchContext({ owner })
    const dispatcher = createDispatcher(ctx)
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]).toMatchObject({ owner: expected, state: { kind: 'idle' }, runState: 'dispatching', unreadableMessage: message })
  })

  it('takes ownership itself when run state is dispatching but the record is absent', async () => {
    const ctx = await dispatchContext()
    const dispatcher = createDispatcher(ctx)
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.owner).toBe('app')
  })

  it('never takes ownership while paused, and still reports the run state', async () => {
    const ctx = await dispatchContext({ runState: 'paused' })
    const dispatcher = createDispatcher(ctx)
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]).toMatchObject({ owner: 'none', runState: 'paused' })
  })
})

describe('createDispatcher — stageLiveness', () => {
  it('is null for a repository this app does not own', async () => {
    const ctx = await dispatchContext({ runState: 'paused' })
    const dispatcher = createDispatcher(ctx)
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.stageLiveness(REPO_ID)).toBeNull()
  })

  it('reports live and interrupted descriptions once this app owns the repository', async () => {
    const interrupted = runOf({ id: 'i1', stage: 'plan', agent: 'plan', trigger: 'ready', item: { kind: 'issue', number: 7 }, endedAt: NOW, interruption: { reason: 'crash', detail: null, at: NOW, resetsAt: null } })
    const { store } = memoryRuns(REPO_ID, { tickets: [ticketOf({ repo: REPO_ID, ticket: 7, stage: 'plan', runs: [interrupted] })] })
    const ctx = await dispatchContext({ owner: 'app', tickets: { repoId: REPO_ID, tickets: [ticketOf({ repo: REPO_ID, ticket: 7, stage: 'plan', runs: [interrupted] })] } })
    expect(store).toBeDefined()
    const dispatcher = createDispatcher(ctx)
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.stageLiveness(REPO_ID)).toEqual({ live: [], interrupted: ['plan #7'] })
  })
})

describe('createDispatcher — launching', () => {
  it('stays idle with nothing dispatchable', async () => {
    const { dispatcher, launches } = await owned()
    await dispatcher.consider(snapshotWith([tickReport()]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
    expect(launches).toHaveLength(0)
  })

  it('drops a candidate whose assignee moved away — nothing launches', async () => {
    const { dispatcher, launches } = await owned({ items: [{ ...ISSUE_52, assignees: ['someone'] }] })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(launches).toHaveLength(0)
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it('launches a surviving candidate, claiming it first and recording it as started', async () => {
    const { ctx, dispatcher, launches } = await owned()
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(ops.claim).toHaveBeenCalledTimes(1)
    expect(launches[0]).toMatchObject({ agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', review: null, title: '#52', target: { kind: 'issue', title: 't' } })
    const state = dispatcher.status()[0]?.state
    expect(state).toMatchObject({ kind: 'active', recent: [{ agent: 'impl', number: 52, state: 'started', sessionKey: 'hosted-1' }] })
    expect(ctx.live.memos.forceDispatch.has(REPO_ID, 52)).toBe(false)
  })

  it('refuses a claim that moved without launching or recording a failure', async () => {
    ops.claim.mockResolvedValue({ kind: 'refused', reason: 'moved', retryable: false, detail: null })
    const { dispatcher, launches } = await owned()
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(launches).toHaveLength(0)
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'idle' })
  })

  it("builds a pull request launch's target from the re-read head branch and hands a review its cycle", async () => {
    const review = [{ number: 47, kind: 'pull-request' as const, stage: 'review' as const, trigger: 'readyForReview' as const, agent: 'review' as const, unchecked: false, cycle: { count: 2, cap: 5 } }]
    const { dispatcher, launches } = await owned({ items: [{ number: 47, kind: 'pull-request', labels: ['ready for review'], assignees: ['op'], headRefName: '46-sync-time' }] })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: review })]))
    expect(launches[0]).toMatchObject({ target: { kind: 'pr', headRefName: '46-sync-time' }, review: { cycle: 3, selfAuthored: false } })
  })

  it('records a failed launch for a review with no cycle count, without launching', async () => {
    const review = [{ number: 47, kind: 'pull-request' as const, stage: 'review' as const, trigger: 'readyForReview' as const, agent: 'review' as const, unchecked: false, cycle: null }]
    const { dispatcher, launches } = await owned({ items: [{ number: 47, kind: 'pull-request', labels: ['ready for review'], assignees: ['op'] }] })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: review })]))
    expect(launches).toHaveLength(0)
    expect(dispatcher.status()[0]?.state).toMatchObject({ kind: 'active', recent: [{ number: 47, state: 'failed', detail: "Couldn't count the earlier reviews on pull request #47, so the review wasn't started." }] })
  })

  it('holds the candidate as waiting when the launch reports at-capacity, rolling the claim back and keeping the force override', async () => {
    const { ctx, dispatcher } = await owned({ launcher: () => Promise.resolve({ ok: false, kind: 'at-capacity', limit: 4 }) })
    ctx.live.memos.forceDispatch.set(REPO_ID, 52)
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'at-capacity', limit: 4, waiting: 1 })
    expect(ops.transition).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: 'rollback' } }))
    expect(ctx.live.memos.forceDispatch.has(REPO_ID, 52)).toBe(true)
  })

  it('records a failed entry when the launch throws, and never stops the loop', async () => {
    const { dispatcher } = await owned({ launcher: () => Promise.reject(new Error('boom')) })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()[0]?.state).toMatchObject({ kind: 'active', recent: [{ number: 52, state: 'failed', detail: 'boom', sessionKey: null }] })
  })

  it('never launches while zero slots are free', async () => {
    const { dispatcher, launches } = await owned({ store: { snapshotOf: () => sessionSnapshot(), capacity: () => Promise.resolve({ limit: 1, ceiling: 8 }), list: () => [sessionSnapshot({ sessionKey: 'hosted-2' as SessionKey })] } })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(launches).toHaveLength(0)
    expect(dispatcher.status()[0]?.state).toEqual({ kind: 'at-capacity', limit: 1, waiting: 1 })
  })

  it('never launches while draining — the candidate is reported idle', async () => {
    const { dispatcher, launches } = await owned({ runState: 'draining' })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(launches).toHaveLength(0)
    expect(dispatcher.status()[0]).toMatchObject({ runState: 'draining', state: { kind: 'idle' } })
  })
})

describe('createDispatcher — stopFor and standDown', () => {
  it('report false when nothing is live', async () => {
    const { dispatcher } = await owned()
    expect(await dispatcher.stopFor(REPO_ID, 999)).toBe(false)
    expect(await dispatcher.standDown(REPO_ID)).toBe(false)
  })

  it('stopFor closes the live session and liveStages drops it', async () => {
    const close = vi.fn(() => Promise.resolve({ ok: true as const }))
    const { dispatcher } = await owned({ store: { snapshotOf: () => sessionSnapshot(), close } })
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.liveStages(REPO_ID)).toEqual(['impl #52'])
    expect(await dispatcher.stopFor(REPO_ID, 52)).toBe(true)
    expect(close).toHaveBeenCalledWith('hosted-1')
  })
})

describe('createDispatcher — shutdown', () => {
  it('makes consider a no-op', async () => {
    const { dispatcher } = await owned()
    dispatcher.shutdown()
    await dispatcher.consider(snapshotWith([tickReport({ actionable: ACTIONABLE })]))
    expect(dispatcher.status()).toEqual([])
  })
})

function actionableOf(overrides: Partial<TickActionable> = {}): TickActionable {
  return { number: 52, kind: 'issue', stage: 'implement', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null, ...overrides }
}

describe('promptFor', () => {
  const INSTRUCTION = 'Run your pipeline stage for #52. port has already moved its label. Follow your Pre-flight, Work, and Handoff steps exactly.'

  it.each([
    [{ trigger: 'ready', agent: 'plan' }, `Plan stage for issue #52. ${INSTRUCTION}`],
    [{}, `Implementation stage for issue #52. ${INSTRUCTION}`],
    [{ kind: 'pull-request', trigger: 'readyForReview', agent: 'review' }, `Review stage for pull request #52. ${INSTRUCTION}`],
    [{ kind: 'pull-request', trigger: 'needsRevision', agent: 'revise' }, `Revision stage for pull request #52. ${INSTRUCTION}`],
  ] as const)('names the stage and the item for %j', (overrides, expected) => {
    expect(promptFor(actionableOf(overrides))).toBe(expected)
  })

  it('fills every placeholder, with the number twice', () => {
    const prompt = promptFor(actionableOf())
    expect(prompt).not.toMatch(/<[A-Za-z]+>/)
    expect(prompt.split('#52')).toHaveLength(3)
    expect(DISPATCH_PROMPT.split('<n>')).toHaveLength(3)
  })

  it('names the refresh stage for a refreshBranch trigger, with the number twice', () => {
    const prompt = promptFor(actionableOf({ kind: 'pull-request', stage: 'refresh', trigger: 'refreshBranch', agent: 'revise' }))
    expect(prompt).toBe('Refresh stage for pull request #52. Run your pipeline stage for pull request #52 in refresh mode.')
    expect(REFRESH_PROMPT.split('<n>')).toHaveLength(3)
  })
})
