import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { EndedStage } from '@/types/tick'
import { repairsOf } from '@/main/tick/repair'

const VIEWER = 'op'
const READ_AT = '2026-01-01T01:00:00.000Z'

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: 'repo-a' as ReconciledItem['repoId'],
    repo: 'o/r',
    kind: 'issue',
    number: 52,
    title: 'a ticket',
    url: 'https://github.com/o/r/issues/52',
    assignees: [VIEWER],
    stage: 'in-flight',
    stages: [{ key: 'inProgress', name: 'inProgress', role: 'in-flight' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'in-flight',
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
    matchedKeys: ['inProgress'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    ...overrides,
  }
}

function ended(overrides: Partial<EndedStage> = {}): EndedStage {
  return { agent: 'impl', number: 52, outcome: 'error', at: '2026-01-01T00:00:00.000Z', ...overrides }
}

describe('repairsOf — guards', () => {
  it('skips an unmarked item', () => {
    const result = repairsOf({ items: [item({ marked: false })], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('skips an item not assigned to the viewer', () => {
    const result = repairsOf({ items: [item({ assignees: ['someone-else'] })], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('skips a number with a live stage session', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended()], liveNumbers: new Set([52]), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('skips a closed item', () => {
    const result = repairsOf({ items: [item({ state: 'CLOSED' })], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('skips a session shape when the read is older than the outcome', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ at: '2026-01-01T02:00:00.000Z' })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('skips a session shape when readAt is null', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: null })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })
})

describe('repairsOf — contradictory wins over every other shape', () => {
  it('reports contradictory even over a stage-error session', () => {
    const contradictory = item({ stages: [{ key: 'inProgress', name: 'inProgress', role: 'in-flight' }, { key: 'planReview', name: 'plan review', role: 'gate' }], matchedKeys: ['inProgress', 'planReview'] })
    const result = repairsOf({ items: [contradictory], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'contradictory', labels: ['inProgress', 'planReview'], agent: null }])
  })

  it('reports contradictory when both refresh-pair labels are present', () => {
    const both = item({ stages: [{ key: 'refreshBranch', name: 'refresh branch', role: 'trigger' }, { key: 'refreshing', name: 'refreshing', role: 'in-flight' }], matchedKeys: ['refreshBranch', 'refreshing'] })
    const result = repairsOf({ items: [both], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'contradictory', labels: ['refreshBranch', 'refreshing'], agent: null }])
  })
})

describe('repairsOf — session shapes', () => {
  it('stage-error with a retry key repairs via liveness-reset, evidence stage-error', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ outcome: 'error' })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([])
    expect(result.observations).toEqual([{ kind: 'liveness-reset', number: 52, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'planApproved', evidence: 'stage-error' }])
  })

  it('completed with the in-flight label still present reports handback-unlabelled', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ outcome: 'completed' })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'handback-unlabelled', labels: ['inProgress'], agent: 'impl' }])
  })

  it.each(['questions', 'blocked', 'interrupted', 'usage-limit'] as const)('%s produces nothing', (outcome) => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ outcome })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('the newest ended stage for a number wins when more than one is present', () => {
    const older = ended({ outcome: 'completed', at: '2025-12-31T00:00:00.000Z' })
    const newer = ended({ outcome: 'error', at: '2025-12-31T23:00:00.000Z' })
    const result = repairsOf({ items: [item()], endedStages: [older, newer], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([])
    expect(result.observations).toEqual([{ kind: 'liveness-reset', number: 52, itemKind: 'issue', inFlight: 'inProgress', retryKey: 'planApproved', evidence: 'stage-error' }])
  })
})

describe('repairsOf — artifact shapes (issues only)', () => {
  function atStage(key: ReconciledItem['stages'][number]['key'], role: ReconciledItem['stages'][number]['role'], rest: Partial<ReconciledItem> = {}): ReconciledItem {
    return item({ stage: role, stages: [{ key, name: key, role }], matchedKeys: [key], ...rest })
  }

  it('planReview with planPresent false repairs via plan-missing', () => {
    const result = repairsOf({ items: [atStage('planReview', 'gate', { planPresent: false })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([])
    expect(result.observations).toEqual([{ kind: 'plan-missing', number: 52, itemKind: 'issue' }])
  })

  it('planReview with planPresent true or null produces nothing', () => {
    const present = repairsOf({ items: [atStage('planReview', 'gate', { planPresent: true })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(present.observations).toEqual([])
    expect(present.reports).toEqual([])
    const unknown = repairsOf({ items: [atStage('planReview', 'gate', { planPresent: null })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(unknown.observations).toEqual([])
    expect(unknown.reports).toEqual([])
  })

  it('planApproved with planPresent false reports plan-missing-approved', () => {
    const result = repairsOf({ items: [atStage('planApproved', 'trigger', { planPresent: false })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'plan-missing-approved', labels: ['planApproved'], agent: null }])
  })

  it('prOpened with linkReason counterpart-not-open reports pr-missing', () => {
    const result = repairsOf({ items: [atStage('prOpened', 'terminal', { linkReason: 'counterpart-not-open' })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'pr-missing', labels: ['prOpened'], agent: null }])
  })

  it('a pull request never triggers an artifact shape', () => {
    const pr = atStage('prOpened', 'terminal', { kind: 'pull-request', linkReason: 'counterpart-not-open' })
    const result = repairsOf({ items: [pr], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })
})
