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

describe('observationWrite — withdraw-approval route', () => {
  const vocabulary = customVocabulary({ needsHuman: 'needs human' })
  const approved = item({ kind: 'pull-request', stage: 'terminal', stages: [{ key: 'approved', name: 'approved', role: 'terminal' }], matchedKeys: ['approved'] })
  const red = [{ name: 'audit', conclusion: 'FAILURE', url: null }]

  it('a revise route swaps approved for needsRevision with the plain comment', () => {
    const observation: TickObservation = { kind: 'withdraw-approval', route: 'revise', number: 52, itemKind: 'pull-request', red, headRefOid: 'abc1234' }
    const plan = observationWrite(observation, approved, vocabulary, 'dev')
    expect(plan.add).toEqual(['needsRevision'])
    expect(plan.remove).toEqual(['approved'])
    expect(plan.comment).not.toContain('instead of revision')
  })

  it('a human route swaps approved for needsHuman and names the label in the comment', () => {
    const observation: TickObservation = { kind: 'withdraw-approval', route: 'human', number: 52, itemKind: 'pull-request', red, headRefOid: 'abc1234' }
    const plan = observationWrite(observation, approved, vocabulary, 'dev')
    expect(plan.add).toEqual(['needsHuman'])
    expect(plan.remove).toEqual(['approved'])
    expect(plan.comment).toMatch(/^## Approval withdrawn\n/)
    expect(plan.comment).toContain('moved to `needs human` instead of revision. A new head is the way past it.')
  })
})

describe('observationWrite — zero-diff reason', () => {
  const vocabulary = customVocabulary({})
  const pr = item({ kind: 'pull-request', stage: 'trigger', stages: [{ key: 'readyForReview', name: 'readyForReview', role: 'trigger' }], matchedKeys: ['readyForReview'] })

  it('a sha-cap escalation names the head and that a new head is the way past it', () => {
    const observation: TickObservation = { kind: 'zero-diff', reason: 'sha-cap', number: 52, itemKind: 'pull-request', count: 3, headRefOid: 'abc1234' }
    const plan = observationWrite(observation, pr, vocabulary, 'dev')
    expect(plan.add).toEqual(['needsHuman'])
    expect(plan.remove).toEqual(['readyForReview'])
    expect(plan.comment).toContain('Cycle 3 was the second review of `abc1234`, the most one head gets. A new head is the way past it.')
  })

  it('a plain zero-diff escalation keeps its own comment', () => {
    const observation: TickObservation = { kind: 'zero-diff', reason: 'zero-diff', number: 52, itemKind: 'pull-request', count: 3, headRefOid: 'abc1234' }
    const plan = observationWrite(observation, pr, vocabulary, 'dev')
    expect(plan.comment).toContain('the head has not moved')
  })

  it('ends each escalation with the marker for its cause and head', () => {
    const sha = (reason: 'zero-diff' | 'sha-cap'): string | null => {
      const observation: TickObservation = { kind: 'zero-diff', reason, number: 52, itemKind: 'pull-request', count: 3, headRefOid: 'abc1234' }
      return observationWrite(observation, pr, vocabulary, 'dev').comment
    }
    expect(sha('zero-diff')?.endsWith('\n<!-- port:escalation zero-diff abc1234 -->')).toBe(true)
    expect(sha('sha-cap')?.endsWith('\n<!-- port:escalation sha-cap abc1234 -->')).toBe(true)
  })
})

describe('observationWrite — escalation markers', () => {
  const vocabulary = customVocabulary({})
  const pr = item({ kind: 'pull-request', headRefOid: 'def5678', stage: 'trigger', stages: [{ key: 'needsRevision', name: 'needsRevision', role: 'trigger' }], matchedKeys: ['needsRevision'] })

  it('marks the cycle-cap escalation with the item head', () => {
    const observation: TickObservation = { kind: 'cycle-cap', number: 52, itemKind: 'pull-request', count: 5, cap: 5 }
    expect(observationWrite(observation, pr, vocabulary, 'dev').comment?.endsWith('\n<!-- port:escalation cycle-cap def5678 -->')).toBe(true)
  })

  it('marks the integration-red escalation with its head', () => {
    const observation: TickObservation = { kind: 'integration-red', number: 52, itemKind: 'pull-request', checks: ['test'], headRefOid: 'abc1234' }
    expect(observationWrite(observation, pr, vocabulary, 'dev').comment?.endsWith('\n<!-- port:escalation integration-red abc1234 -->')).toBe(true)
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
