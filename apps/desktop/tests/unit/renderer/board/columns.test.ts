import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import type { BlockedOn, BoardColumnKey, BoardItemRow } from '@/types/board'
import type { Ticket } from '@/types/ticket'
import type { Stage, Status } from '@/utils/pipeline/ticket'
import { ticketIndex } from '@/utils/tickets/ticket'
import { boardColumns } from '@/renderer/board/columns'
import { reconciledItem } from '../../../support/board-snapshot'
import { NOW, queuedAt, ticketAt } from '../../../support/tickets'

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

const RUNNING: Status = { kind: 'running', runId: null }
const waiting = (gate: 'plan-approval' | 'merge' | 'escalation'): Status => ({ kind: 'waiting-on-you', gate, detail: '' })

interface At {
  readonly stage: Stage
  readonly status: Status
}

function row(overrides: { readonly repoId?: string; readonly number?: number; readonly at?: At | null; readonly blockedOn?: BlockedOn }): BoardItemRow {
  const repoId = (overrides.repoId ?? 'repo-a') as RepoId
  const number = overrides.number ?? 1
  const at = overrides.at === undefined ? { stage: 'plan' as const, status: queuedAt('new') } : overrides.at
  const item = reconciledItem({
    repoId,
    number,
    url: 'https://example.com',
    assignees: [],
    waitingOn: null,
    ticket: at === null ? null : ticketAt(at.stage, at.status, { ticket: number }),
  })
  return {
    item,
    ticket: ticketIndex([item]).tickets[0] as Ticket,
    displayStatus: { status: 'waiting', staleGithub: false, githubAgeMs: null },
    liveStage: null,
    actions: NO_ACTIONS,
    decisions: NO_DECISIONS,
    viewer: null,
    autoApproving: false,
    blockedOn: overrides.blockedOn ?? null,
    held: null,
  }
}

const HELD: BlockedOn = { dependencies: null, session: null, comment: null }

function columnOfRow(r: BoardItemRow): BoardColumnKey | undefined {
  return boardColumns([r], [], { repo: null }).find((column) => column.cards.length > 0)?.key
}

const CASES: readonly (readonly [string, At, BoardColumnKey])[] = [
  ['a new plan', { stage: 'plan', status: queuedAt('new') }, 'queued'],
  ['a replan', { stage: 'plan', status: queuedAt('changes-requested') }, 'plan'],
  ['a running plan', { stage: 'plan', status: RUNNING }, 'plan'],
  ['a plan awaiting approval', { stage: 'plan', status: waiting('plan-approval') }, 'needs-you'],
  ['a queued implement', { stage: 'implement', status: queuedAt('new') }, 'implement'],
  ['a running implement', { stage: 'implement', status: RUNNING }, 'implement'],
  ['a queued review', { stage: 'review', status: queuedAt('new') }, 'review'],
  ['a running review', { stage: 'review', status: RUNNING }, 'review'],
  ['a queued revise', { stage: 'revise', status: queuedAt('changes-requested') }, 'revise'],
  ['a running revise', { stage: 'revise', status: RUNNING }, 'revise'],
  ['a running refresh', { stage: 'refresh', status: RUNNING }, 'revise'],
  ['an escalated implement', { stage: 'implement', status: waiting('escalation') }, 'needs-you'],
  ['a merge awaiting the operator', { stage: 'merge', status: waiting('merge') }, 'needs-you'],
  ['a merged ticket', { stage: 'merge', status: { kind: 'done', at: NOW } }, 'needs-you'],
]

describe('boardColumns', () => {
  it('returns the six columns in order, even for no rows', () => {
    const columns = boardColumns([], [], { repo: null })
    expect(columns.map((c) => c.key)).toEqual(['queued', 'plan', 'implement', 'review', 'revise', 'needs-you'])
    expect(columns.map((c) => c.name)).toEqual(['Queued', 'Plan', 'Implement', 'Review', 'Revise', 'Needs you'])
    expect(columns.every((c) => c.cards.length === 0)).toBe(true)
  })

  it.each(CASES)('puts %s in %s', (_name, at, column) => {
    expect(columnOfRow(row({ at }))).toBe(column)
  })

  it('puts a blocked ticket in Queued, whatever stage it was in', () => {
    expect(columnOfRow(row({ at: { stage: 'implement', status: RUNNING }, blockedOn: HELD }))).toBe('queued')
  })

  it('puts an untracked row in Queued', () => {
    expect(columnOfRow(row({ at: null }))).toBe('queued')
  })

  it('puts an ungated row in Needs you, flagged, ahead of the others', () => {
    const gated = row({ at: { stage: 'merge', status: waiting('merge') }, number: 2 })
    const ungated = row({ at: { stage: 'review', status: queuedAt('new') }, number: 3 })
    const needsYou = boardColumns([gated], [ungated], { repo: null }).find((c) => c.key === 'needs-you')
    expect(needsYou?.cards.map((card) => [card.row.item.number, card.ungated])).toEqual([
      [3, true],
      [2, false],
    ])
  })

  it('shows every input row exactly once', () => {
    const rows = CASES.map(([, at], i) => row({ at, number: i + 1 }))
    const ungated = row({ at: { stage: 'implement', status: RUNNING }, number: 99 })
    const numbers = boardColumns(rows, [ungated], { repo: null }).flatMap((c) => c.cards.map((card) => card.row.item.number))
    expect([...numbers].sort((a, b) => a - b)).toEqual([...rows.map((r) => r.item.number), 99].sort((a, b) => a - b))
  })

  it('applies the repo filter to rows and ungated rows alike', () => {
    const a = row({ repoId: 'repo-a', at: { stage: 'plan', status: RUNNING }, number: 1 })
    const b = row({ repoId: 'repo-b', at: { stage: 'plan', status: RUNNING }, number: 2 })
    const ungatedB = row({ repoId: 'repo-b', at: { stage: 'merge', status: waiting('merge') }, number: 3 })
    const columns = boardColumns([a, b], [ungatedB], { repo: 'repo-a' as RepoId })
    expect(columns.flatMap((c) => c.cards.map((card) => card.row.item.number))).toEqual([1])
  })

  it('orders a column by pipeline stage, then by input order', () => {
    const rows = [
      row({ at: { stage: 'review', status: RUNNING }, number: 1 }),
      row({ at: { stage: 'review', status: queuedAt('new') }, number: 2 }),
      row({ at: { stage: 'review', status: RUNNING }, number: 3 }),
    ]
    const review = boardColumns(rows, [], { repo: null }).find((c) => c.key === 'review')
    expect(review?.cards.map((card) => card.row.item.number)).toEqual([2, 1, 3])
  })

  it('gives each header a filled, non-pulsing tone, with Queued idle', () => {
    const tones = boardColumns([], [], { repo: null }).map((c) => c.tone)
    expect(tones.map((t) => t.palette)).toEqual(['unstaged', 'plan', 'implement', 'review', 'revise', 'needs-you'])
    expect(tones.every((t) => t.fill === 'active' && !t.pulse)).toBe(true)
  })
})
