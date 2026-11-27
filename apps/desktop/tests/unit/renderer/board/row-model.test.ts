import { describe, expect, it } from 'vitest'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import type { BoardItemRow, ItemActionState, LiveStage } from '@/types/board'
import type { AttachedAgent, AttachedSession } from '@/types/state'
import type { RepoId } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'
import type { DispatchRecord } from '@/types/dispatch'
import type { Ticket } from '@/types/ticket'
import type { Stage, Status } from '@/utils/pipeline/ticket'
import { ticketIndex } from '@/utils/tickets/ticket'
import { reconciledItem } from '../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'
import { actionNoteFor, agentSummaryOf, decisionNoteFor, isDispatchedRow, nextActionFor, operatorJoinedOf, ownershipNoteFor, phaseLabelFor, phaseToneFor, stopAttachedAgentNote } from '@/renderer/board/row-model'

const LIVE_PLAN: LiveStage = { agent: 'plan', sessionKey: 'hosted-1' as SessionKey }

interface At {
  readonly stage: Stage
  readonly status: Status
}

const RUNNING: Status = { kind: 'running', runId: null }
const waiting = (gate: 'plan-approval' | 'merge' | 'escalation'): Status => ({ kind: 'waiting-on-you', gate, detail: '' })
const PLAN_QUEUED: At = { stage: 'plan', status: queuedAt('new') }
const PLAN_GATE: At = { stage: 'plan', status: waiting('plan-approval') }
const IMPLEMENTING: At = { stage: 'implement', status: RUNNING }

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

function row(overrides: {
  readonly kind?: 'issue' | 'pull-request'
  readonly at?: At | null
  readonly status?: 'waiting' | 'in-flight' | 'stalled' | 'interrupted' | 'gated' | 'terminal' | 'unstaged'
  readonly actions?: Partial<Record<OperatorAction, ActionAvailability>>
  readonly decisions?: Partial<Record<OperatorDecision, DecisionAvailability>>
  readonly agents?: readonly AttachedAgent[]
  readonly sessions?: readonly AttachedSession[]
  readonly liveStage?: LiveStage | null
  readonly autoApproving?: boolean
}): BoardItemRow {
  const at = overrides.at === undefined ? PLAN_QUEUED : overrides.at
  const item = reconciledItem({
    repoId: 'repo-a' as RepoId,
    kind: overrides.kind ?? 'issue',
    number: 41,
    url: 'https://github.com/o/a/pull/41',
    status: overrides.status ?? 'waiting',
    waitingOn: null,
    agents: overrides.agents ?? [],
    sessions: overrides.sessions ?? [],
    ticket: at === null ? null : ticketAt(at.stage, at.status, { ticket: 41 }),
  })
  return {
    item,
    ticket: ticketIndex([item]).tickets[0] as Ticket,
    displayStatus: { status: overrides.status ?? 'waiting', staleGithub: false, githubAgeMs: null },
    liveStage: overrides.liveStage ?? null,
    actions: { ...NO_ACTIONS, ...overrides.actions },
    decisions: { ...NO_DECISIONS, ...overrides.decisions },
    viewer: null,
    autoApproving: overrides.autoApproving ?? false,
    blockedOn: null,
    held: null,
  }
}

function dispatchRecord(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return { agent: 'impl', number: 41, kind: 'issue', state: 'started', at: '2026-01-01T00:00:00.000Z', detail: null, outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null, ...overrides }
}

describe('operatorJoinedOf', () => {
  it('is true when a matching record carries an operator join', () => {
    expect(operatorJoinedOf([dispatchRecord({ operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], row({}))).toBe(true)
  })

  it('is false when no matching record carries one', () => {
    expect(operatorJoinedOf([dispatchRecord({})], row({}))).toBe(false)
  })

  it('ignores a record for a different item', () => {
    expect(operatorJoinedOf([dispatchRecord({ number: 99, operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], row({}))).toBe(false)
  })
})

describe('agentSummaryOf', () => {
  it('prefers an active agent over a dormant one', () => {
    const agents: readonly AttachedAgent[] = [
      { stage: 'review-agent', agentType: 'review-agent', activity: 'dormant', idleMs: 500_000, model: 'sonnet' } as AttachedAgent,
      { stage: 'impl-agent', agentType: 'impl-agent', activity: 'active', idleMs: 1_000, model: 'sonnet' } as AttachedAgent,
    ]
    expect(agentSummaryOf(agents, [])).toBe('impl-agent · sonnet · active 1s ago')
  })

  it('falls back to an attached implement session', () => {
    const sessions: readonly AttachedSession[] = [{ role: 'implement', activity: 'active', idleMs: 2_000 } as AttachedSession]
    expect(agentSummaryOf([], sessions)).toBe('/port:implement session · active 2s ago')
  })

  it('null when nothing is attached', () => {
    expect(agentSummaryOf([], [])).toBeNull()
  })
})

describe('ownershipNoteFor', () => {
  it('reports a not-owned refusal on pause/resume/retry/stop', () => {
    const actions = { ...NO_ACTIONS, pause: { available: false, reason: 'not-owned' } } as Record<OperatorAction, ActionAvailability>
    const note = ownershipNoteFor(actions, { number: 41, assignees: ['someone-else'] })
    expect(note).toContain('@someone-else owns #41')
  })

  it('null when every refusal is not-applicable', () => {
    expect(ownershipNoteFor(NO_ACTIONS, { number: 41, assignees: [] })).toBeNull()
  })
})

describe('actionNoteFor', () => {
  it('names the ticket number, not the status source, in the ownership note', () => {
    const base = row({ kind: 'pull-request', actions: { pause: { available: false, reason: 'not-owned' } } })
    const r: BoardItemRow = { ...base, ticket: { ...base.ticket, ref: { ...base.ticket.ref, number: 464 } } }
    const note = actionNoteFor(r, undefined)
    expect(note).toContain('owns #464')
    expect(note).toContain('work on #464')
    expect(note).not.toContain('#41')
  })

  it('names the ticket number in an action result', () => {
    const base = row({ kind: 'pull-request' })
    const r: BoardItemRow = { ...base, ticket: { ...base.ticket, ref: { ...base.ticket.ref, number: 464 } } }
    const state = { kind: 'result', action: 'retry', result: { ok: false, reason: 'moved', expected: 'Queued', observed: 'Running' } } as unknown as ItemActionState
    expect(actionNoteFor(r, state)).toContain('#464')
  })
})

describe('decisionNoteFor', () => {
  it('surfaces a cycle-cap refusal', () => {
    const r = row({ decisions: { unblock: { available: false, reason: 'cycle-cap' } } })
    expect(decisionNoteFor(r)).toContain('used all its review cycles')
  })

  it('surfaces an agent-live refusal', () => {
    const r = row({ kind: 'issue', decisions: { unblock: { available: false, reason: 'agent-live' } } })
    expect(decisionNoteFor(r)).not.toBeNull()
  })

  it('null when no decision carries an actionable refusal', () => {
    expect(decisionNoteFor(row({}))).toBeNull()
  })
})

describe('phaseLabelFor', () => {
  it('Interrupted wins over a live session', () => {
    const base = row({ liveStage: LIVE_PLAN })
    expect(phaseLabelFor({ ...base, displayStatus: { status: 'interrupted', staleGithub: false, githubAgeMs: null } })).toBe('Interrupted')
  })

  it('names a stalled row Stalled, not its stage', () => {
    expect(phaseLabelFor(row({ at: { stage: 'plan', status: RUNNING }, status: 'stalled' }))).toBe('Stalled')
  })

  it('names an auto-approving plan gate Plan auto-approving', () => {
    expect(phaseLabelFor(row({ at: PLAN_GATE, autoApproving: true }))).not.toBe(phaseLabelFor(row({ at: PLAN_GATE })))
  })

  it("names the dispatched stage while the record still says it's queued", () => {
    expect(phaseLabelFor(row({ at: PLAN_QUEUED, status: 'waiting', liveStage: LIVE_PLAN }))).toBe('Planning')
  })

  it("falls back to the ticket's own phase once the item is in flight, or with no live session", () => {
    expect(phaseLabelFor(row({ at: IMPLEMENTING, status: 'in-flight', liveStage: LIVE_PLAN }))).toBe('Implementing')
    expect(phaseLabelFor(row({ at: PLAN_QUEUED, status: 'waiting' }))).toBe('Queued')
    expect(phaseLabelFor(row({ at: null }))).toBe('Unstaged')
  })
})

describe('isDispatchedRow', () => {
  it('is true only for a live session on a still-queued item', () => {
    expect(isDispatchedRow(row({ at: PLAN_QUEUED, status: 'waiting', liveStage: LIVE_PLAN }))).toBe(true)
    expect(isDispatchedRow(row({ at: IMPLEMENTING, status: 'in-flight', liveStage: LIVE_PLAN }))).toBe(false)
    expect(isDispatchedRow(row({ at: PLAN_QUEUED, status: 'waiting' }))).toBe(false)
  })
})

describe('stopAttachedAgentNote', () => {
  it('names the attached agent', () => {
    const r = row({ agents: [{ stage: 'impl-agent', agentType: 'impl-agent', activity: 'active', idleMs: 0, model: 'sonnet' } as AttachedAgent] })
    expect(stopAttachedAgentNote(r)).toContain('impl-agent is attached to #41')
  })

  it('null when nothing is attached', () => {
    expect(stopAttachedAgentNote(row({}))).toBeNull()
  })
})

describe('phaseToneFor', () => {
  it('a plan gate pulses in the plan colour', () => {
    expect(phaseToneFor(row({ at: PLAN_GATE }))).toEqual({ palette: 'plan', fill: 'active', pulse: true })
  })

  it('a ready-to-merge row pulses in the done colour', () => {
    expect(phaseToneFor(row({ at: { stage: 'merge', status: waiting('merge') }, kind: 'pull-request' }))).toEqual({ palette: 'done', fill: 'active', pulse: true })
  })

  it('an escalation is red and pulsing', () => {
    expect(phaseToneFor(row({ at: { stage: 'implement', status: waiting('escalation') } }))).toEqual({ palette: 'needs-you', fill: 'active', pulse: true })
  })

  it('blocked keeps the red palette but does not pulse, since it is held rather than waiting on you', () => {
    expect(phaseToneFor(row({ at: { stage: 'implement', status: { kind: 'blocked', on: [], reason: 'x' } } }))).toEqual({ palette: 'needs-you', fill: 'active', pulse: false })
  })

  it('an in-flight stage is filled in its phase colour', () => {
    expect(phaseToneFor(row({ at: IMPLEMENTING, status: 'in-flight' }))).toEqual({ palette: 'implement', fill: 'active', pulse: false })
  })

  it('a queued stage is a ring in its phase colour', () => {
    expect(phaseToneFor(row({ at: PLAN_QUEUED, status: 'waiting' }))).toEqual({ palette: 'plan', fill: 'queued', pulse: false })
  })

  it('a stage whose agent is already running is filled', () => {
    expect(phaseToneFor(row({ at: { stage: 'review', status: RUNNING }, status: 'in-flight' }))).toEqual({ palette: 'review', fill: 'active', pulse: false })
  })

  it('a refresh stage is grey and never pulses', () => {
    expect(phaseToneFor(row({ at: { stage: 'refresh', status: queuedAt('new') }, kind: 'pull-request' }))).toEqual({ palette: 'refresh', fill: 'queued', pulse: false })
    expect(phaseToneFor(row({ at: { stage: 'refresh', status: RUNNING }, status: 'in-flight' }))).toEqual({ palette: 'refresh', fill: 'active', pulse: false })
  })

  it.each(['stalled', 'interrupted'] as const)('a %s row is red and pulsing over its phase colour', (status) => {
    expect(phaseToneFor(row({ at: IMPLEMENTING, status }))).toEqual({ palette: 'needs-you', fill: 'active', pulse: true })
  })

  it('an auto-approving plan gate is filled in the plan colour and does not pulse', () => {
    expect(phaseToneFor(row({ at: PLAN_GATE, autoApproving: true }))).toEqual({ palette: 'plan', fill: 'active', pulse: false })
  })

  it('an untracked row is the idle grey', () => {
    expect(phaseToneFor(row({ at: null, status: 'unstaged' }))).toEqual({ palette: 'unstaged', fill: 'active', pulse: false })
  })
})

describe('nextActionFor', () => {
  it('Review plan for an issue at the plan gate', () => {
    expect(nextActionFor(row({ kind: 'issue', at: PLAN_GATE }))).toMatchObject({ kind: 'review-plan' })
  })

  it('no Review plan action while the plan is auto-approving', () => {
    expect(nextActionFor(row({ kind: 'issue', at: PLAN_GATE, autoApproving: true }))).toBeNull()
  })

  it('a pull request at the plan gate carries no Review plan action (issue-only)', () => {
    expect(nextActionFor(row({ kind: 'pull-request', at: PLAN_GATE }))).toBeNull()
  })

  it('Open PR when the ticket waits on the merge', () => {
    expect(nextActionFor(row({ kind: 'pull-request', at: { stage: 'merge', status: waiting('merge') } }))).toEqual({ kind: 'open-pr', label: 'Open PR', url: 'https://github.com/o/a/pull/41' })
  })

  it('the decision label when a decision is available', () => {
    const r = row({ at: { stage: 'implement', status: waiting('escalation') }, decisions: { unblock: { available: true, context: { target: 'pull-request', reason: null, cyclesUsed: 1, cap: 5, decisions: [], routes: ['review', 'revision'] } } } })
    expect(nextActionFor(r)).toEqual({ kind: 'decision', label: 'Unblock', decision: 'unblock' })
  })

  it('null when nothing applies', () => {
    expect(nextActionFor(row({ kind: 'issue', at: PLAN_QUEUED }))).toBeNull()
  })
})
