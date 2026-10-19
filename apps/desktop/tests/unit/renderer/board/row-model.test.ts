import { describe, expect, it } from 'vitest'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import type { BoardItemRow, ItemActionState, LiveStage } from '@/types/board'
import type { AttachedAgent, AttachedSession, ReconciledItem, StageLabel } from '@/types/state'
import type { RepoId } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'
import type { DispatchRecord } from '@/types/dispatch'
import type { Ticket } from '@/types/ticket'
import { ticketIndex } from '@/utils/tickets/ticket'
import { actionNoteFor, agentSummaryOf, decisionNoteFor, isDispatchedRow, nextActionFor, operatorJoinedOf, ownershipNoteFor, phaseLabelFor, phaseToneFor, stageKeyOf, stopAttachedAgentNote } from '@/renderer/board/row-model'

const LIVE_PLAN: LiveStage = { agent: 'plan', trigger: 'ready', sessionKey: 'hosted-1' as SessionKey }

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

function row(overrides: {
  readonly kind?: 'issue' | 'pull-request'
  readonly stageKey?: string | null
  readonly status?: 'waiting' | 'in-flight' | 'stalled' | 'interrupted' | 'gated' | 'terminal' | 'unstaged'
  readonly actions?: Partial<Record<OperatorAction, ActionAvailability>>
  readonly decisions?: Partial<Record<OperatorDecision, DecisionAvailability>>
  readonly agents?: readonly AttachedAgent[]
  readonly sessions?: readonly AttachedSession[]
  readonly liveStage?: LiveStage | null
}): BoardItemRow {
  const stageLabel: StageLabel | null = overrides.stageKey != null ? { key: overrides.stageKey as never, name: overrides.stageKey, role: 'trigger' } : null
  const item = {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: overrides.kind ?? 'issue',
    number: 41,
    title: 't',
    url: 'https://github.com/o/a/pull/41',
    assignees: ['op'],
    stage: stageLabel?.key ?? null,
    stages: stageLabel !== null ? [stageLabel] : [],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: overrides.status ?? 'waiting',
    statusEvidence: null,
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: overrides.agents ?? [],
    sessions: overrides.sessions ?? [],
    worktrees: [],
    state: 'OPEN',
    mergedAt: null,
    matchedKeys: [],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
  } as unknown as ReconciledItem
  return {
    item,
    ticket: ticketIndex([item]).tickets[0] as Ticket,
    displayStatus: { status: overrides.status ?? 'waiting', staleGithub: false, githubAgeMs: null },
    liveStage: overrides.liveStage ?? null,
    stageLabel,
    actions: { ...NO_ACTIONS, ...overrides.actions },
    decisions: { ...NO_DECISIONS, ...overrides.decisions },
    viewer: null,
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
    const state = { kind: 'result', action: 'retry', result: { ok: false, reason: 'no-pause-record' } } as unknown as ItemActionState
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
    expect(decisionNoteFor(r)).toBe("#41's agent is still waiting in its session. Answer it there and it clears the block itself.")
  })

  it('null when no decision carries an actionable refusal', () => {
    expect(decisionNoteFor(row({}))).toBeNull()
  })
})

describe('phaseLabelFor', () => {
  it('Interrupted wins over a live session', () => {
    const base = row({ stageKey: 'ready', liveStage: LIVE_PLAN })
    expect(phaseLabelFor({ ...base, displayStatus: { status: 'interrupted', staleGithub: false, githubAgeMs: null } })).toBe('Interrupted')
  })

  it("names the dispatched stage while the label still says it's queued", () => {
    expect(phaseLabelFor(row({ stageKey: 'ready', status: 'waiting', liveStage: LIVE_PLAN }))).toBe('Planning')
  })

  it("falls back to the label's own phase once the item is in flight, or with no live session", () => {
    expect(phaseLabelFor(row({ stageKey: 'inProgress', status: 'in-flight', liveStage: LIVE_PLAN }))).toBe('Implementing')
    expect(phaseLabelFor(row({ stageKey: 'ready', status: 'waiting' }))).toBe('Queued')
    expect(phaseLabelFor(row({ stageKey: null }))).toBe('Unstaged')
  })
})

describe('isDispatchedRow', () => {
  it('is true only for a live session on a still-queued item', () => {
    expect(isDispatchedRow(row({ stageKey: 'ready', status: 'waiting', liveStage: LIVE_PLAN }))).toBe(true)
    expect(isDispatchedRow(row({ stageKey: 'inProgress', status: 'in-flight', liveStage: LIVE_PLAN }))).toBe(false)
    expect(isDispatchedRow(row({ stageKey: 'ready', status: 'waiting' }))).toBe(false)
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

describe('stageKeyOf', () => {
  const stages: readonly StageLabel[] = [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }]

  it('resolves the winning stage key', () => {
    expect(stageKeyOf(stages, 'in-flight')).toBe('inProgress')
  })

  it('null when stage is null', () => {
    expect(stageKeyOf(stages, null)).toBeNull()
  })

  it('null when no stage label has the given role', () => {
    expect(stageKeyOf(stages, 'gate')).toBeNull()
  })
})

describe('phaseToneFor', () => {
  it('a plan gate pulses in the plan colour', () => {
    expect(phaseToneFor(row({ stageKey: 'planReview' }))).toEqual({ palette: 'plan', fill: 'active', pulse: true })
  })

  it('a ready-to-merge row pulses in the done colour', () => {
    expect(phaseToneFor(row({ stageKey: 'approved', kind: 'pull-request' }))).toEqual({ palette: 'done', fill: 'active', pulse: true })
  })

  it.each(['blocked', 'needsHuman'])('%s is red and pulsing', (stageKey) => {
    expect(phaseToneFor(row({ stageKey }))).toEqual({ palette: 'needs-you', fill: 'active', pulse: true })
  })

  it('an in-flight stage is filled in its phase colour', () => {
    expect(phaseToneFor(row({ stageKey: 'inProgress', status: 'in-flight' }))).toEqual({ palette: 'implement', fill: 'active', pulse: false })
  })

  it('a queued trigger is a ring in its phase colour', () => {
    expect(phaseToneFor(row({ stageKey: 'ready', status: 'waiting' }))).toEqual({ palette: 'plan', fill: 'queued', pulse: false })
  })

  it('a trigger whose agent is already running is filled', () => {
    expect(phaseToneFor(row({ stageKey: 'readyForReview', status: 'in-flight' }))).toEqual({ palette: 'review', fill: 'active', pulse: false })
  })

  it('a refresh stage is grey', () => {
    expect(phaseToneFor(row({ stageKey: 'refreshing', status: 'in-flight' })).palette).toBe('refresh')
  })

  it.each(['stalled', 'interrupted'] as const)('a %s row is red and pulsing over its phase colour', (status) => {
    expect(phaseToneFor(row({ stageKey: 'inProgress', status }))).toEqual({ palette: 'needs-you', fill: 'active', pulse: true })
  })

  it('an unstaged row is the idle grey', () => {
    expect(phaseToneFor(row({ stageKey: null, status: 'unstaged' }))).toEqual({ palette: 'unstaged', fill: 'active', pulse: false })
  })
})

describe('nextActionFor', () => {
  it('Review plan for an issue at planReview', () => {
    expect(nextActionFor(row({ kind: 'issue', stageKey: 'planReview' }))).toEqual({ kind: 'review-plan', label: 'Review plan' })
  })

  it('a pull request at planReview carries no Review plan action (issue-only)', () => {
    expect(nextActionFor(row({ kind: 'pull-request', stageKey: 'planReview' }))).toBeNull()
  })


  it('Open PR when the stage is approved', () => {
    expect(nextActionFor(row({ kind: 'pull-request', stageKey: 'approved' }))).toEqual({ kind: 'open-pr', label: 'Open PR', url: 'https://github.com/o/a/pull/41' })
  })

  it('the decision label when a decision is available', () => {
    const r = row({ stageKey: 'needsHuman', decisions: { unblock: { available: true, context: { target: 'pull-request', reason: null, cyclesUsed: 1, cap: 5, decisions: [] } } } })
    expect(nextActionFor(r)).toEqual({ kind: 'decision', label: 'Unblock', decision: 'unblock' })
  })

  it('null when nothing applies', () => {
    expect(nextActionFor(row({ kind: 'issue', stageKey: 'ready' }))).toBeNull()
  })
})
