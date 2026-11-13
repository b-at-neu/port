import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '@/types/actions'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '@/types/actions'
import type { BlockedOn, BoardColumnKey, BoardItemRow } from '@/types/board'
import type { ReconciledItem, StageLabel } from '@/types/state'
import type { Ticket } from '@/types/ticket'
import { LABEL_KEYS } from '@/utils/labels/vocabulary'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { ticketIndex } from '@/utils/tickets/ticket'
import { boardColumns } from '@/renderer/board/columns'

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

function row(overrides: {
  readonly repoId?: string
  readonly number?: number
  readonly stageKey?: LabelKey | null
  readonly blockedOn?: BlockedOn
}): BoardItemRow {
  const repoId = (overrides.repoId ?? 'repo-a') as RepoId
  const stageLabel: StageLabel | null = overrides.stageKey != null ? { key: overrides.stageKey, name: overrides.stageKey, role: 'trigger' } : null
  const item = {
    repoId,
    repo: 'o/a',
    kind: 'issue',
    number: overrides.number ?? 1,
    title: 't',
    url: 'https://example.com',
    assignees: [],
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
  } as unknown as ReconciledItem
  return {
    item,
    ticket: ticketIndex([item]).tickets[0] as Ticket,
    displayStatus: { status: 'waiting', staleGithub: false, githubAgeMs: null },
    liveStage: null,
    stageLabel,
    actions: NO_ACTIONS,
    decisions: NO_DECISIONS,
    viewer: null,
    autoApproving: false,
    blockedOn: overrides.blockedOn ?? null,
  }
}

const HELD: BlockedOn = { dependencies: null, session: null, comment: null }

function columnOfRow(r: BoardItemRow): BoardColumnKey | undefined {
  return boardColumns([r], [], { repo: null }).find((column) => column.cards.length > 0)?.key
}

const EXPECTED: Readonly<Record<LabelKey, BoardColumnKey>> = {
  marker: 'queued',
  autoPlan: 'queued',
  ready: 'queued',
  planChangesRequested: 'plan',
  planning: 'plan',
  planReview: 'plan',
  planApproved: 'implement',
  inProgress: 'implement',
  prOpened: 'queued',
  readyForReview: 'review',
  reviewing: 'review',
  needsRevision: 'revise',
  revising: 'revise',
  approved: 'needs-you',
  needsHuman: 'needs-you',
  blocked: 'queued',
  refreshBranch: 'needs-you',
  refreshing: 'needs-you',
}

describe('boardColumns', () => {
  it('returns the six columns in order, even for no rows', () => {
    const columns = boardColumns([], [], { repo: null })
    expect(columns.map((c) => c.key)).toEqual(['queued', 'plan', 'implement', 'review', 'revise', 'needs-you'])
    expect(columns.map((c) => c.name)).toEqual(['Queued', 'Plan', 'Implement', 'Review', 'Revise', 'Needs you'])
    expect(columns.every((c) => c.cards.length === 0)).toBe(true)
  })

  it('classifies every label key, with none left out of the table', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...LABEL_KEYS].sort())
  })

  it.each(LABEL_KEYS.map((key): [LabelKey, BoardColumnKey] => [key, EXPECTED[key]]))('puts %s in %s', (key, column) => {
    const r = row({ stageKey: key, blockedOn: key === 'blocked' ? HELD : undefined })
    expect(columnOfRow(r)).toBe(column)
  })

  it('puts a blocked hand-back on an in-flight stage in Queued', () => {
    expect(columnOfRow(row({ stageKey: 'inProgress', blockedOn: HELD }))).toBe('queued')
  })

  it('keeps an approved ticket in Needs you when it is also refreshing', () => {
    expect(columnOfRow(row({ stageKey: 'approved' }))).toBe('needs-you')
    expect(columnOfRow(row({ stageKey: 'refreshing' }))).toBe('needs-you')
  })

  it('puts a row with no stage in Queued', () => {
    expect(columnOfRow(row({ stageKey: null }))).toBe('queued')
  })

  it('puts an ungated row in Needs you, flagged, ahead of the others', () => {
    const gated = row({ stageKey: 'approved', number: 2 })
    const ungated = row({ stageKey: 'readyForReview', number: 3 })
    const needsYou = boardColumns([gated], [ungated], { repo: null }).find((c) => c.key === 'needs-you')
    expect(needsYou?.cards.map((card) => [card.row.item.number, card.ungated])).toEqual([
      [3, true],
      [2, false],
    ])
  })

  it('shows every input row exactly once', () => {
    const rows = LABEL_KEYS.map((key, i) => row({ stageKey: key, number: i + 1, blockedOn: key === 'blocked' ? HELD : undefined }))
    const ungated = row({ stageKey: 'inProgress', number: 99 })
    const numbers = boardColumns(rows, [ungated], { repo: null }).flatMap((c) => c.cards.map((card) => card.row.item.number))
    expect([...numbers].sort((a, b) => a - b)).toEqual([...rows.map((r) => r.item.number), 99].sort((a, b) => a - b))
  })

  it('applies the repo filter to rows and ungated rows alike', () => {
    const a = row({ repoId: 'repo-a', stageKey: 'planning', number: 1 })
    const b = row({ repoId: 'repo-b', stageKey: 'planning', number: 2 })
    const ungatedB = row({ repoId: 'repo-b', stageKey: 'approved', number: 3 })
    const columns = boardColumns([a, b], [ungatedB], { repo: 'repo-a' as RepoId })
    expect(columns.flatMap((c) => c.cards.map((card) => card.row.item.number))).toEqual([1])
  })

  it('orders a column by pipeline stage, then by input order', () => {
    const rows = [row({ stageKey: 'reviewing', number: 1 }), row({ stageKey: 'readyForReview', number: 2 }), row({ stageKey: 'reviewing', number: 3 })]
    const review = boardColumns(rows, [], { repo: null }).find((c) => c.key === 'review')
    expect(review?.cards.map((card) => card.row.item.number)).toEqual([2, 1, 3])
  })

  it('gives each header a filled, non-pulsing tone, with Queued idle', () => {
    const tones = boardColumns([], [], { repo: null }).map((c) => c.tone)
    expect(tones.map((t) => t.palette)).toEqual(['unstaged', 'plan', 'implement', 'review', 'revise', 'needs-you'])
    expect(tones.every((t) => t.fill === 'active' && !t.pulse)).toBe(true)
  })
})
