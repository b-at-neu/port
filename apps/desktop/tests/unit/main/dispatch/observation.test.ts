import { describe, expect, it } from 'vitest'
import type { LabelKey, LabelVocabulary, ResolvedLabel } from '@/utils/labels/vocabulary'
import type { ReconciledItem } from '@/types/state'
import type { TickObservation } from '@/types/tick'
import { observationWrite } from '@/main/dispatch/observation'
import type { WriteObservation } from '@/types/dispatch'

const REPO_ID = 'repo-a' as ReconciledItem['repoId']

function customVocabulary(overrides: Readonly<Partial<Record<LabelKey, string>>>): LabelVocabulary {
  const keys: readonly LabelKey[] = ['ready', 'planReview', 'planApproved', 'inProgress', 'needsHuman', 'approved', 'needsRevision', 'readyForReview', 'refreshBranch']
  const labels: ResolvedLabel[] = keys.map((key) => ({ key, name: overrides[key] ?? key, source: overrides[key] !== undefined ? 'config' : 'default', module: 'core', role: 'trigger' }))
  return { labels, disabled: [], problems: [] }
}

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: 'o/r',
    kind: 'issue',
    number: 52,
    title: 'a ticket',
    url: 'https://github.com/o/r/issues/52',
    assignees: ['op'],
    stage: 'gate',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'gated',
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
    updatedAt: null,
    stageHistory: [],
    matchedKeys: ['planReview'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: false,
    blockers: null,
    blockerComments: null,
    ...overrides,
  }
}

describe('observationWrite — plan-missing', () => {
  it('moves planReview back to ready and uses the repository\'s own resolved label names in the comment', () => {
    const vocabulary = customVocabulary({ planReview: 'needs plan review', ready: 'go' })
    const observation: WriteObservation = { kind: 'plan-missing', number: 52, itemKind: 'issue' }
    const plan = observationWrite(observation, item(), vocabulary, 'dev')
    expect(plan.add).toEqual(['ready'])
    expect(plan.remove).toEqual(['planReview'])
    expect(plan.action).toBe('observe-plan-missing')
    expect(plan.comment).toContain('`needs plan review`')
    expect(plan.comment).toContain('`go`')
  })

  it('falls back to the bare key when a label is missing from the vocabulary', () => {
    const vocabulary: LabelVocabulary = { labels: [], disabled: [], problems: [] }
    const observation: WriteObservation = { kind: 'plan-missing', number: 52, itemKind: 'issue' }
    const plan = observationWrite(observation, item(), vocabulary, 'dev')
    expect(plan.comment).toContain('`planReview`')
    expect(plan.comment).toContain('`ready`')
  })
})

describe('observationWrite — liveness-reset evidence', () => {
  const vocabulary = customVocabulary({})
  const base = item({ stage: 'in-flight', stages: [{ key: 'inProgress', name: 'inProgress', role: 'in-flight' }], matchedKeys: ['inProgress'] })

  it('a ledger-evidenced reset writes the ordinary action name', () => {
    const observation: TickObservation = { kind: 'liveness-reset', number: 52, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'planApproved', evidence: 'ledger' }
    const plan = observationWrite(observation, base, vocabulary, 'dev')
    expect(plan.action).toBe('observe-liveness-reset')
    expect(plan.add).toEqual(['planApproved'])
    expect(plan.remove).toEqual(['inProgress'])
  })

  it('a stage-error-evidenced reset writes the same labels, under a distinct action name', () => {
    const observation: TickObservation = { kind: 'liveness-reset', number: 52, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'planApproved', evidence: 'stage-error' }
    const plan = observationWrite(observation, base, vocabulary, 'dev')
    expect(plan.action).toBe('observe-stage-error-reset')
    expect(plan.add).toEqual(['planApproved'])
    expect(plan.remove).toEqual(['inProgress'])
  })
})
