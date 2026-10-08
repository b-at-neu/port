import { describe, expect, it } from 'vitest'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '../../../shared/actions/types'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '../../../shared/actions/types'
import type { BoardItemRow } from '../../../shared/board/types'
import type { AttachedAgent, AttachedSession, ReconciledItem, StageLabel } from '../../../shared/state/types'
import type { RepoId } from '../../../shared/repos'
import { agentSummaryOf, decisionNoteFor, nextActionFor, ownershipNoteFor, pillStatusFor, stopAttachedAgentNote } from './row-model'

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

function row(overrides: {
  readonly kind?: 'issue' | 'pull-request'
  readonly stageKey?: string | null
  readonly status?: 'waiting' | 'in-flight' | 'stalled' | 'gated' | 'terminal' | 'unstaged'
  readonly actions?: Partial<Record<OperatorAction, ActionAvailability>>
  readonly decisions?: Partial<Record<OperatorDecision, DecisionAvailability>>
  readonly agents?: readonly AttachedAgent[]
  readonly sessions?: readonly AttachedSession[]
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
    status: 'waiting',
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
  } as unknown as ReconciledItem
  return {
    item,
    displayStatus: { status: overrides.status ?? 'waiting', staleGithub: false, githubAgeMs: null },
    stageLabel,
    actions: { ...NO_ACTIONS, ...overrides.actions },
    decisions: { ...NO_DECISIONS, ...overrides.decisions },
  }
}

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

describe('decisionNoteFor', () => {
  it('surfaces a cycle-cap refusal', () => {
    const r = row({ decisions: { unblock: { available: false, reason: 'cycle-cap' } } })
    expect(decisionNoteFor(r)).toContain('used all its review cycles')
  })

  it('null when no decision carries an actionable refusal', () => {
    expect(decisionNoteFor(row({}))).toBeNull()
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

describe('pillStatusFor', () => {
  it('attention when waiting on you (a needs-you stage)', () => {
    expect(pillStatusFor(row({ stageKey: 'planReview' }))).toBe('attention')
  })

  it('working when in-flight', () => {
    expect(pillStatusFor(row({ stageKey: 'inProgress', status: 'in-flight' }))).toBe('working')
  })

  it('danger when stalled', () => {
    expect(pillStatusFor(row({ stageKey: 'inProgress', status: 'stalled' }))).toBe('danger')
  })

  it('idle for everything else (queued)', () => {
    expect(pillStatusFor(row({ stageKey: 'ready', status: 'waiting' }))).toBe('idle')
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
    const r = row({ stageKey: 'needsHuman', decisions: { unblock: { available: true, context: { reason: null, cyclesUsed: 1, cap: 5 } } } })
    expect(nextActionFor(r)).toEqual({ kind: 'decision', label: 'Unblock', decision: 'unblock' })
  })

  it('null when nothing applies', () => {
    expect(nextActionFor(row({ kind: 'issue', stageKey: 'ready' }))).toBeNull()
  })
})
