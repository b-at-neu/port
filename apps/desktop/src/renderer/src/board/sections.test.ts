import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS } from '../../../shared/actions/types'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '../../../shared/actions/types'
import type { BoardItemRow } from '../../../shared/board/types'
import type { ReconciledItem, StageLabel } from '../../../shared/state/types'
import { boardSections } from './sections'

const NO_ACTIONS = Object.fromEntries(OPERATOR_ACTIONS.map((a): [OperatorAction, ActionAvailability] => [a, { available: false, reason: 'not-applicable' }])) as Record<OperatorAction, ActionAvailability>
const NO_DECISIONS = Object.fromEntries(OPERATOR_DECISIONS.map((d): [OperatorDecision, DecisionAvailability] => [d, { available: false, reason: 'not-applicable' }])) as Record<OperatorDecision, DecisionAvailability>

function row(overrides: {
  readonly repoId?: string
  readonly repo?: string
  readonly number?: number
  readonly stageKey?: StageLabel['key'] | null
  readonly status?: ReconciledItem['status']
  readonly relay?: BoardItemRow['relay']
}): BoardItemRow {
  const repoId = (overrides.repoId ?? 'repo-a') as RepoId
  const stageLabel: StageLabel | null = overrides.stageKey != null ? { key: overrides.stageKey, name: overrides.stageKey, role: 'trigger' } : null
  const item = {
    repoId,
    repo: overrides.repo ?? 'o/a',
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
    status: overrides.status ?? 'waiting',
    statusEvidence: null,
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
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
    actions: NO_ACTIONS,
    decisions: NO_DECISIONS,
    relay: overrides.relay ?? null,
  }
}

describe('boardSections', () => {
  it('puts a planReview row in Waiting on you, an in-flight row in In progress, the rest in Queued', () => {
    const rows = [row({ number: 1, stageKey: 'planReview' }), row({ number: 2, stageKey: 'inProgress', status: 'in-flight' }), row({ number: 3, stageKey: 'ready', status: 'waiting' })]
    const sections = boardSections(rows, { group: 'repo', repo: null })
    expect(sections.map((s) => s.key)).toEqual(['waiting-on-you', 'in-progress', 'queued'])
    expect(sections[0]?.count).toBe(1)
    expect(sections[1]?.count).toBe(1)
    expect(sections[2]?.count).toBe(1)
  })

  it('a relay-pending row is Waiting on you even when in-flight', () => {
    const relay = { repoId: 'repo-a' as RepoId, number: 1, stage: 'impl-agent', sessionId: 's', agentId: null, parentSessionLabel: 'cockpit', agentLabel: 'impl-agent', lastActivityAt: '2026-01-01T00:00:00.000Z', kind: 'questions', questions: [] } as unknown as BoardItemRow['relay']
    const rows = [row({ number: 1, stageKey: 'inProgress', status: 'in-flight', relay })]
    const sections = boardSections(rows, { group: 'repo', repo: null })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.key).toBe('waiting-on-you')
  })

  it('omits an empty section entirely', () => {
    const rows = [row({ number: 1, stageKey: 'ready', status: 'waiting' })]
    const sections = boardSections(rows, { group: 'repo', repo: null })
    expect(sections.map((s) => s.key)).toEqual(['queued'])
  })

  it('phase grouping orders sub-groups in pipeline order and names them from PHASE_NAMES', () => {
    const rows = [row({ number: 1, stageKey: 'inProgress', status: 'in-flight' }), row({ number: 2, stageKey: 'ready', status: 'waiting' })]
    const sections = boardSections(rows, { group: 'phase', repo: null })
    const inProgress = sections.find((s) => s.key === 'in-progress')
    expect(inProgress?.subGroups.map((g) => g.name)).toEqual(['Implementing'])
    const queued = sections.find((s) => s.key === 'queued')
    expect(queued?.subGroups.map((g) => g.name)).toEqual(['Queued'])
  })

  it('an unstaged row gets its own trailing phase sub-group', () => {
    const rows = [row({ number: 1, stageKey: null, status: 'waiting' })]
    const sections = boardSections(rows, { group: 'phase', repo: null })
    expect(sections[0]?.subGroups).toEqual([{ key: 'unstaged', name: 'Unstaged', rows: [rows[0]] }])
  })

  it('a stage PHASE_NAMES marks null (prOpened) also falls into Unstaged', () => {
    const rows = [row({ number: 1, stageKey: 'prOpened', status: 'terminal' })]
    const sections = boardSections(rows, { group: 'phase', repo: null })
    expect(sections[0]?.subGroups.map((g) => g.key)).toEqual(['unstaged'])
  })

  it('repo grouping orders sub-groups by first appearance and names them from the row', () => {
    const rows = [row({ repoId: 'repo-a', repo: 'o/a', number: 1, stageKey: 'ready' }), row({ repoId: 'repo-b', repo: 'o/b', number: 2, stageKey: 'ready' })]
    const sections = boardSections(rows, { group: 'repo', repo: null })
    expect(sections[0]?.subGroups.map((g) => g.name)).toEqual(['o/a', 'o/b'])
  })

  it('the repo filter applies before sectioning', () => {
    const rows = [row({ repoId: 'repo-a', number: 1, stageKey: 'ready' }), row({ repoId: 'repo-b', number: 2, stageKey: 'ready' })]
    const sections = boardSections(rows, { group: 'repo', repo: 'repo-b' as RepoId })
    expect(sections[0]?.count).toBe(1)
    expect(sections[0]?.subGroups[0]?.rows[0]?.item.repoId).toBe('repo-b')
  })
})
