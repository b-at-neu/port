import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import type { BlockedOn, BoardItemRow } from '@/types/board'
import type { SessionKey } from '@/types/hosting'
import type { ReconciledItem, StageLabel } from '@/types/state'
import type { Ticket } from '@/types/ticket'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { ticketIndex } from '@/utils/tickets/ticket'
import { boardSections } from '@/renderer/board/sections'

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

function row(overrides: {
  readonly repoId?: string
  readonly repo?: string
  readonly number?: number
  readonly stageKey?: StageLabel['key'] | null
  readonly status?: ReconciledItem['status']
  readonly autoApproving?: boolean
  readonly blockedOn?: BlockedOn
}): BoardItemRow {
  const repoId = (overrides.repoId ?? 'repo-a') as RepoId
  const stageLabel: StageLabel | null = overrides.stageKey != null ? { key: overrides.stageKey, name: overrides.stageKey, role: LABEL_DEFAULTS.find((def) => def.key === overrides.stageKey)?.role ?? 'trigger' } : null
  const item = {
    repoId,
    repo: overrides.repo ?? 'o/a',
    kind: 'issue',
    number: overrides.number ?? 1,
    title: 't',
    url: 'https://example.com',
    assignees: [],
    stage: stageLabel?.role ?? null,
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
    agents: [],
    sessions: [],
    worktrees: [],
    workSessions: [],
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
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
  } as unknown as ReconciledItem
  return {
    item,
    ticket: ticketIndex([item]).tickets[0] as Ticket,
    displayStatus: { status: overrides.status ?? 'waiting', staleGithub: false, githubAgeMs: null },
    liveStage: null,
    stageLabel,
    actions: NO_ACTIONS,
    decisions: NO_DECISIONS,
    viewer: null,
    autoApproving: overrides.autoApproving ?? false,
    blockedOn: overrides.blockedOn ?? null,
    held: null,
  }
}

const HELD: BlockedOn = { dependencies: null, session: null, comment: null }

describe('boardSections', () => {
  it('puts a planReview row in Waiting on you, an in-flight row in In progress, the rest in Queued', () => {
    const rows = [row({ number: 1, stageKey: 'planReview' }), row({ number: 2, stageKey: 'inProgress', status: 'in-flight' }), row({ number: 3, stageKey: 'ready', status: 'waiting' })]
    const sections = boardSections(rows, { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['waiting-on-you', 'in-progress', 'queued'])
    expect(sections[0]?.count).toBe(1)
    expect(sections[1]?.count).toBe(1)
    expect(sections[2]?.count).toBe(1)
  })

  it('puts an auto-approving plan-review row in In progress, never Waiting on you', () => {
    const sections = boardSections([row({ number: 1, stageKey: 'planReview', autoApproving: true })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['in-progress'])
  })

  it('keeps a plan-review row that is not auto-approving in Waiting on you', () => {
    const sections = boardSections([row({ number: 1, stageKey: 'planReview', autoApproving: false })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['waiting-on-you'])
  })

  it('puts a dispatched row, still labelled ready, in In progress', () => {
    const queued = row({ number: 1, stageKey: 'ready', status: 'waiting' })
    const dispatched: BoardItemRow = {
      ...queued,
      displayStatus: { status: 'in-flight', staleGithub: false, githubAgeMs: null },
      liveStage: { agent: 'plan', trigger: 'ready', sessionKey: 'hosted-1' as SessionKey },
    }
    const sections = boardSections([dispatched], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['in-progress'])
  })

  it('puts a blocked row in Blocked, between In progress and Queued, and out of Waiting on you', () => {
    const rows = [
      row({ number: 1, stageKey: 'blocked', blockedOn: HELD }),
      row({ number: 2, stageKey: 'ready', status: 'waiting' }),
      row({ number: 3, stageKey: 'inProgress', status: 'in-flight' }),
    ]
    const sections = boardSections(rows, { repo: null })
    expect(sections.map((s) => [s.key, s.name, s.count])).toEqual([
      ['in-progress', 'In progress', 1],
      ['blocked', 'Blocked', 1],
      ['queued', 'Queued', 1],
    ])
  })

  it('puts an in-flight row with a live BLOCKED: session in Blocked, whatever its stage label says', () => {
    const sections = boardSections([row({ number: 1, stageKey: 'inProgress', status: 'in-flight', blockedOn: HELD })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['blocked'])
  })

  it('keeps an escalated row in Waiting on you even when a BLOCKED: session is live on it', () => {
    const sections = boardSections([row({ number: 1, stageKey: 'needsHuman', blockedOn: HELD })], { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['waiting-on-you'])
  })

  it('omits an empty section entirely', () => {
    const rows = [row({ number: 1, stageKey: 'ready', status: 'waiting' })]
    const sections = boardSections(rows, { repo: null })
    expect(sections.map((s) => s.key)).toEqual(['queued'])
  })

  it('orders sub-groups by stage group, whatever order the rows arrive in', () => {
    const rows = [row({ number: 1, stageKey: 'reviewing', status: 'in-flight' }), row({ number: 2, stageKey: 'planning', status: 'in-flight' }), row({ number: 3, stageKey: 'refreshing', status: 'in-flight' })]
    const inProgress = boardSections(rows, { repo: null }).find((s) => s.key === 'in-progress')
    expect(inProgress?.subGroups.map((g) => g.key)).toEqual(['plan:running', 'review:running', 'refresh:running'])
  })

  it('a replanning row groups apart from a freshly queued one', () => {
    const rows = [row({ number: 1, stageKey: 'planChangesRequested', status: 'waiting' }), row({ number: 2, stageKey: 'ready', status: 'waiting' })]
    const queued = boardSections(rows, { repo: null }).find((s) => s.key === 'queued')
    expect(queued?.subGroups.map((g) => g.name)).toEqual(['Queued', 'Replanning'])
  })

  it('an unstaged row gets its own trailing phase sub-group', () => {
    const rows = [row({ number: 1, stageKey: null, status: 'waiting' })]
    const sections = boardSections(rows, { repo: null })
    expect(sections[0]?.subGroups).toEqual([{ key: 'unstaged', name: 'Unstaged', rows: [rows[0]] }])
  })

  it('a key with no stage (prOpened) also falls into Unstaged', () => {
    const rows = [row({ number: 1, stageKey: 'prOpened', status: 'terminal' })]
    const sections = boardSections(rows, { repo: null })
    expect(sections[0]?.subGroups.map((g) => g.key)).toEqual(['unstaged'])
  })

  it('the repo filter applies before sectioning', () => {
    const rows = [row({ repoId: 'repo-a', number: 1, stageKey: 'ready' }), row({ repoId: 'repo-b', number: 2, stageKey: 'ready' })]
    const sections = boardSections(rows, { repo:'repo-b' as RepoId })
    expect(sections[0]?.count).toBe(1)
    expect(sections[0]?.subGroups[0]?.rows[0]?.item.repoId).toBe('repo-b')
  })
})
