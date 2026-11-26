import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { EndedStage } from '@/types/tick'
import { repairsOf } from '@/main/pipeline/tick/repair'
import { ticketViewOf } from '@/utils/pipeline/stages'
import type { Event, Ticket } from '@/utils/pipeline/ticket'
import { reconciledItem } from '../../../../support/board-snapshot'
import { NOW, queuedAt, ticketAt } from '../../../../support/tickets'

const VIEWER = 'op'
const READ_AT = '2026-01-01T01:00:00.000Z'

const RUNNING = ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 52 })
const PLAN_REVIEW = (history: Event[] = []) => ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }, { ticket: 52, history })
const APPROVED = (history: Event[] = []) => ticketAt('implement', queuedAt('new'), { ticket: 52, history })

function item(overrides: Partial<ReconciledItem> & { readonly ticket?: Ticket | null } = {}): ReconciledItem {
  return reconciledItem({
    repo: 'o/r',
    number: 52,
    title: 'a ticket',
    url: 'https://github.com/o/r/issues/52',
    assignees: [VIEWER],
    ticket: RUNNING,
    ...overrides,
  })
}

function ended(overrides: Partial<EndedStage> = {}): EndedStage {
  return { agent: 'impl', number: 52, outcome: 'completed', at: '2026-01-01T00:00:00.000Z', labels: { kind: 'refused', reason: 'moved', detail: null }, ...overrides }
}

const repair = (items: readonly ReconciledItem[], endedStages: readonly EndedStage[] = [], options: { readonly liveNumbers?: ReadonlySet<number>; readonly readAt?: string | null } = {}) =>
  repairsOf({ items, endedStages, liveNumbers: options.liveNumbers ?? new Set(), viewer: VIEWER, readAt: options.readAt === undefined ? READ_AT : options.readAt })

const RUNNING_VIEW = ticketViewOf(RUNNING)

describe('repairsOf — guards', () => {
  it.each([
    ['an unmarked item', () => repair([item({ marked: false })], [ended()])],
    ['an item not assigned to the viewer', () => repair([item({ assignees: ['someone-else'] })], [ended()])],
    ['a number with a live stage session', () => repair([item()], [ended()], { liveNumbers: new Set([52]) })],
    ['a closed item', () => repair([item({ state: 'CLOSED' })], [ended()])],
    ['a session shape when the read is older than the outcome', () => repair([item()], [ended({ at: '2026-01-01T02:00:00.000Z' })])],
    ['a session shape when readAt is null', () => repair([item()], [ended()], { readAt: null })],
    ['an item the record does not track', () => repair([item({ ticket: null })], [ended()])],
  ])('skips %s', (_name, run) => {
    expect(run()).toEqual({ observations: [], reports: [] })
  })
})

describe('repairsOf — mirror-failed', () => {
  const failure = { at: '2026-01-01T00:30:00.000Z', outcome: { kind: 'item-unavailable' as const } }

  it('reports a failed label mirror with the failure it recorded', () => {
    const result = repair([item({ mirrorFailure: failure })])
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'mirror-failed', view: RUNNING_VIEW, agent: null, reason: null, mirror: failure }])
  })

  it('reports it for an unmarked item and while a stage session is live', () => {
    expect(repair([item({ marked: false, mirrorFailure: failure })], [], { liveNumbers: new Set([52]) }).reports).toHaveLength(1)
  })

  it('skips a closed item, an item assigned to someone else and an item with no failure', () => {
    const items = [item({ state: 'CLOSED', mirrorFailure: failure }), item({ assignees: ['someone-else'], mirrorFailure: failure }), item({ mirrorFailure: null }), item()]
    expect(repair(items).reports).toEqual([])
  })

  it('reports beside a session shape on the same item', () => {
    expect(repair([item({ mirrorFailure: failure })], [ended()]).reports.map((report) => report.shape)).toEqual(['mirror-failed', 'handback-unlabelled'])
  })
})

describe('repairsOf — session shapes', () => {
  const unlabelled = (reason: string, view = RUNNING_VIEW) => ({ number: 52, kind: 'issue', shape: 'handback-unlabelled', view, agent: 'impl', reason, mirror: null })

  it('an error outcome produces no observation', () => {
    expect(repair([item()], [ended({ outcome: 'error', labels: { kind: 'applied' } })])).toEqual({ observations: [], reports: [] })
  })

  it('a refused completed hand-back reports handback-unlabelled with its reason', () => {
    const result = repair([item()], [ended({ labels: { kind: 'refused', reason: 'no-handback', detail: null } })])
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([unlabelled('no-handback')])
  })

  it('a refused error write reports handback-unlabelled too', () => {
    expect(repair([item()], [ended({ outcome: 'error', labels: { kind: 'refused', reason: 'write-failed', detail: 'boom' } })]).reports).toEqual([unlabelled('write-failed')])
  })

  it('an applied or pending hand-back reports nothing', () => {
    for (const labels of [{ kind: 'applied' as const }, null]) {
      expect(repair([item()], [ended({ labels })])).toEqual({ observations: [], reports: [] })
    }
  })

  it('an impl whose ticket is blocked still reports a refused hand-back', () => {
    const blocked = ticketAt('implement', { kind: 'blocked', on: [], reason: 'needs a decision' }, { ticket: 52 })
    expect(repair([item({ ticket: blocked })], [ended()]).reports).toEqual([unlabelled('moved', ticketViewOf(blocked))])
  })

  it('a refused write reports nothing once the ticket has moved off the running stage', () => {
    expect(repair([item({ ticket: PLAN_REVIEW() })], [ended()]).reports).toEqual([])
  })

  it.each(['questions', 'blocked', 'interrupted', 'usage-limit'] as const)('%s produces nothing', (outcome) => {
    expect(repair([item()], [ended({ outcome })])).toEqual({ observations: [], reports: [] })
  })

  it('the newest ended stage for a number wins when more than one is present', () => {
    const older = ended({ at: '2025-12-31T00:00:00.000Z' })
    const newer = ended({ outcome: 'error', labels: { kind: 'applied' }, at: '2025-12-31T23:00:00.000Z' })
    expect(repair([item()], [older, newer])).toEqual({ observations: [], reports: [] })
  })
})

describe('repairsOf — artifact shapes (issues only)', () => {
  const missing = (shape: string, ticket: Ticket) => ({ number: 52, kind: 'issue', shape, view: ticketViewOf(ticket), agent: null, reason: null, mirror: null })
  const closedTicket = ticketAt('implement', { kind: 'done', at: NOW }, { ticket: 52 })

  it('a plan awaiting approval with planPresent false repairs via plan-missing', () => {
    const result = repair([item({ ticket: PLAN_REVIEW(), planPresent: false })])
    expect(result.reports).toEqual([])
    expect(result.observations).toEqual([{ kind: 'plan-missing', number: 52, itemKind: 'issue' }])
  })

  it.each([true, null])('a plan awaiting approval with planPresent %s produces nothing', (planPresent) => {
    expect(repair([item({ ticket: PLAN_REVIEW(), planPresent })])).toEqual({ observations: [], reports: [] })
  })

  it('an approved plan with planPresent false reports plan-missing-approved', () => {
    const result = repair([item({ ticket: APPROVED(), planPresent: false })])
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([missing('plan-missing-approved', APPROVED())])
  })

  it('a ticket with no pull request whose counterpart closed unmerged reports pr-missing', () => {
    const result = repair([item({ ticket: closedTicket, linkReason: 'counterpart-not-open' })])
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([missing('pr-missing', closedTicket)])
  })

  it('a merged counterpart produces no report and no observation', () => {
    expect(repair([item({ ticket: closedTicket, linkReason: 'counterpart-merged' })])).toEqual({ observations: [], reports: [] })
  })

  it('a pull request never triggers an artifact shape', () => {
    const pr = item({ kind: 'pull-request', ticket: closedTicket, linkReason: 'counterpart-not-open' })
    expect(repair([pr])).toEqual({ observations: [], reports: [] })
  })
})

describe('repairsOf — plan-missing freshness', () => {
  const BEFORE_READ = '2026-01-01T00:59:00.000Z'
  const AFTER_READ = '2026-01-01T01:00:01.000Z'
  const entered = (stage: 'plan' | 'implement', status: 'waiting-on-you' | 'queued', at: string): Event => ({ at, action: 'move', actor: null, to: { stage, status }, legacy: null })

  function planItem(key: 'planReview' | 'planApproved', enteredAt: string, planPresent: boolean): ReconciledItem {
    const ticket = key === 'planReview' ? PLAN_REVIEW([entered('plan', 'waiting-on-you', enteredAt)]) : APPROVED([entered('implement', 'queued', enteredAt)])
    return item({ ticket, planPresent })
  }

  it.each([
    { key: 'planReview', enteredAt: AFTER_READ, planPresent: false, readAt: READ_AT, observations: 0, reports: 0 },
    { key: 'planReview', enteredAt: BEFORE_READ, planPresent: false, readAt: READ_AT, observations: 1, reports: 0 },
    { key: 'planApproved', enteredAt: AFTER_READ, planPresent: false, readAt: READ_AT, observations: 0, reports: 0 },
    { key: 'planApproved', enteredAt: BEFORE_READ, planPresent: false, readAt: READ_AT, observations: 0, reports: 1 },
    { key: 'planReview', enteredAt: BEFORE_READ, planPresent: false, readAt: null, observations: 0, reports: 0 },
    { key: 'planApproved', enteredAt: BEFORE_READ, planPresent: false, readAt: null, observations: 0, reports: 0 },
    { key: 'planReview', enteredAt: BEFORE_READ, planPresent: true, readAt: READ_AT, observations: 0, reports: 0 },
    { key: 'planApproved', enteredAt: AFTER_READ, planPresent: true, readAt: READ_AT, observations: 0, reports: 0 },
  ] as const)('$key entered $enteredAt, planPresent $planPresent, readAt $readAt → $observations observations, $reports reports', ({ key, enteredAt, planPresent, readAt, observations, reports }) => {
    const result = repair([planItem(key, enteredAt, planPresent)], [], { readAt })
    expect(result.observations).toHaveLength(observations)
    expect(result.reports).toHaveLength(reports)
    if (reports === 1) expect(result.reports).toMatchObject([{ shape: 'plan-missing-approved' }])
  })
})
