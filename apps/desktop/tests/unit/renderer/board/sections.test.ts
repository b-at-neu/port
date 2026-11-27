import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import type { BlockedOn, BoardItemRow } from '@/types/board'
import type { SessionKey } from '@/types/hosting'
import type { Ticket } from '@/types/ticket'
import type { Stage, Status } from '@/utils/pipeline/ticket'
import { ticketIndex } from '@/utils/tickets/ticket'
import { boardSections } from '@/renderer/board/sections'
import { reconciledItem } from '../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

const RUNNING: Status = { kind: 'running', runId: null }
const waiting = (gate: 'plan-approval' | 'escalation'): Status => ({ kind: 'waiting-on-you', gate, detail: '' })

interface At {
  readonly stage: Stage
  readonly status: Status
}

const QUEUED: At = { stage: 'plan', status: queuedAt('new') }

function row(overrides: {
  readonly repoId?: string
  readonly number?: number
  readonly at?: At | null
  readonly autoApproving?: boolean
  readonly blockedOn?: BlockedOn
}): BoardItemRow {
  const repoId = (overrides.repoId ?? 'repo-a') as RepoId
  const number = overrides.number ?? 1
  const at = overrides.at === undefined ? QUEUED : overrides.at
  const item = reconciledItem({
    repoId,
    repo: 'o/a',
    number,
    url: 'https://example.com',
    assignees: [],
    waitingOn: null,
    ticket: at === null ? null : ticketAt(at.stage, at.status, { ticket: number }),
  })
  return {
    item,
    ticket: ticketIndex([item]).tickets[0] as Ticket,
    displayStatus: { status: at?.status.kind === 'running' ? 'in-flight' : 'waiting', staleGithub: false, githubAgeMs: null },
    liveStage: null,
    actions: NO_ACTIONS,
    decisions: NO_DECISIONS,
    viewer: null,
    autoApproving: overrides.autoApproving ?? false,
    blockedOn: overrides.blockedOn ?? null,
    held: null,
  }
}

const HELD: BlockedOn = { dependencies: null, session: null, comment: null }
const PLAN_REVIEW: At = { stage: 'plan', status: waiting('plan-approval') }
const IMPLEMENTING: At = { stage: 'implement', status: RUNNING }

describe('boardSections', () => {
  it('puts a plan awaiting approval in Waiting on you, a running row in In progress, the rest in Queued', () => {
    const rows = [row({ number: 1, at: PLAN_REVIEW }), row({ number: 2, at: IMPLEMENTING }), row({ number: 3, at: QUEUED })]
    const sections = boardSections(rows, { repo: null })
    expect(sections.map((s) => [s.key, s.count])).toEqual([
      ['waiting-on-you', 1],
      ['in-progress', 1],
      ['queued', 1],
    ])
  })

  it('puts an auto-approving plan-review row in In progress, never Waiting on you', () => {
    const sections = boardSections([row({ number: 1, at: PLAN_REVIEW, autoApproving: true })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['in-progress'])
  })

  it('keeps a plan-review row that is not auto-approving in Waiting on you', () => {
    const sections = boardSections([row({ number: 1, at: PLAN_REVIEW, autoApproving: false })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['waiting-on-you'])
  })

  it('puts a dispatched row, still queued on the record, in In progress', () => {
    const dispatched: BoardItemRow = {
      ...row({ number: 1, at: QUEUED }),
      displayStatus: { status: 'in-flight', staleGithub: false, githubAgeMs: null },
      liveStage: { agent: 'plan', sessionKey: 'hosted-1' as SessionKey },
    }
    const sections = boardSections([dispatched], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['in-progress'])
  })

  it('puts a blocked row in Blocked, between In progress and Queued, and out of Waiting on you', () => {
    const rows = [row({ number: 1, at: QUEUED, blockedOn: HELD }), row({ number: 2, at: QUEUED }), row({ number: 3, at: IMPLEMENTING })]
    const sections = boardSections(rows, { repo: null })
    expect(sections.map((s) => [s.key, s.name, s.count])).toEqual([
      ['in-progress', 'In progress', 1],
      ['blocked', 'Blocked', 1],
      ['queued', 'Queued', 1],
    ])
  })

  it('puts a running row with a live BLOCKED: session in Blocked', () => {
    const sections = boardSections([row({ number: 1, at: IMPLEMENTING, blockedOn: HELD })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['blocked'])
  })

  it('keeps an escalated row in Waiting on you even when a BLOCKED: session is live on it', () => {
    const sections = boardSections([row({ number: 1, at: { stage: 'implement', status: waiting('escalation') }, blockedOn: HELD })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['waiting-on-you'])
  })

  it('omits an empty section entirely', () => {
    const sections = boardSections([row({ number: 1, at: QUEUED })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['queued'])
  })

  it('orders sub-groups by stage group, whatever order the rows arrive in', () => {
    const rows = [
      row({ number: 1, at: { stage: 'review', status: RUNNING } }),
      row({ number: 2, at: { stage: 'plan', status: RUNNING } }),
      row({ number: 3, at: { stage: 'refresh', status: RUNNING } }),
    ]
    const inProgress = boardSections(rows, { repo: null }).find((s) => s.key === 'in-progress')
    expect(inProgress?.subGroups.map((g) => g.key)).toEqual(['plan:running', 'review:running', 'refresh:running'])
  })

  it('a replanning row groups apart from a freshly queued one', () => {
    const rows = [row({ number: 1, at: { stage: 'plan', status: queuedAt('changes-requested') } }), row({ number: 2, at: QUEUED })]
    const queued = boardSections(rows, { repo: null }).find((s) => s.key === 'queued')
    expect(queued?.subGroups.map((g) => g.name)).toEqual(['Queued', 'Replanning'])
  })

  it('an untracked row gets its own trailing phase sub-group', () => {
    const rows = [row({ number: 1, at: null })]
    const sections = boardSections(rows, { repo: null })
    expect(sections[0]?.subGroups).toEqual([{ key: 'unstaged', name: 'Unstaged', rows: [rows[0]] }])
  })

  it('the repo filter applies before sectioning', () => {
    const rows = [row({ repoId: 'repo-a', number: 1 }), row({ repoId: 'repo-b', number: 2 })]
    const sections = boardSections(rows, { repo: 'repo-b' as RepoId })
    expect(sections[0]?.count).toBe(1)
    expect(sections[0]?.subGroups[0]?.rows[0]?.item.repoId).toBe('repo-b')
  })
})
