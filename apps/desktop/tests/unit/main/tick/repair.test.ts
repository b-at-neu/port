import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { EndedStage } from '@/types/tick'
import { repairsOf } from '@/main/tick/repair'
import { reconciledItem } from '../../../fixtures/board-state'

const VIEWER = 'op'
const READ_AT = '2026-01-01T01:00:00.000Z'

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({
    repo: 'o/r',
    number: 52,
    title: 'a ticket',
    url: 'https://github.com/o/r/issues/52',
    assignees: [VIEWER],
    stage: 'in-flight',
    stages: [{ key: 'inProgress', name: 'inProgress', role: 'in-flight' }],
    status: 'in-flight',
    statusEvidence: null,
    waitingOn: null,
    matchedKeys: ['inProgress'],
    ...overrides,
  })
}

function ended(overrides: Partial<EndedStage> = {}): EndedStage {
  return { agent: 'impl', number: 52, outcome: 'completed', at: '2026-01-01T00:00:00.000Z', labels: { kind: 'refused', reason: 'moved', detail: null }, ...overrides }
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
  it('reports contradictory even over a refused hand-back', () => {
    const contradictory = item({ stages: [{ key: 'inProgress', name: 'inProgress', role: 'in-flight' }, { key: 'planReview', name: 'plan review', role: 'gate' }], matchedKeys: ['inProgress', 'planReview'] })
    const result = repairsOf({ items: [contradictory], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'contradictory', labels: ['inProgress', 'planReview'], agent: null, reason: null }])
  })

  it('reports contradictory when both refresh-pair labels are present', () => {
    const both = item({ stages: [{ key: 'refreshBranch', name: 'refresh branch', role: 'trigger' }, { key: 'refreshing', name: 'refreshing', role: 'in-flight' }], matchedKeys: ['refreshBranch', 'refreshing'] })
    const result = repairsOf({ items: [both], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'contradictory', labels: ['refreshBranch', 'refreshing'], agent: null, reason: null }])
  })
})

describe('repairsOf — session shapes', () => {
  it('an error outcome produces no observation', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ outcome: 'error', labels: { kind: 'applied' } })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([])
    expect(result.observations).toEqual([])
  })

  it('a refused completed hand-back reports handback-unlabelled with its reason', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ labels: { kind: 'refused', reason: 'no-handback', detail: null } })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'handback-unlabelled', labels: ['inProgress'], agent: 'impl', reason: 'no-handback' }])
  })

  it('a refused error write reports handback-unlabelled too', () => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ outcome: 'error', labels: { kind: 'refused', reason: 'write-failed', detail: 'boom' } })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'handback-unlabelled', labels: ['inProgress'], agent: 'impl', reason: 'write-failed' }])
  })

  it('an applied or pending hand-back reports nothing', () => {
    for (const labels of [{ kind: 'applied' as const }, null]) {
      const result = repairsOf({ items: [item()], endedStages: [ended({ labels })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
      expect(result.observations).toEqual([])
      expect(result.reports).toEqual([])
    }
  })

  it('an impl whose only label is blocked still reports a refused hand-back', () => {
    const blocked = item({ stages: [{ key: 'blocked', name: 'blocked', role: 'gate' }], matchedKeys: ['blocked'] })
    const result = repairsOf({ items: [blocked], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'handback-unlabelled', labels: ['blocked'], agent: 'impl', reason: 'moved' }])
  })

  it('a refused write reports nothing once the labels no longer sit alone on the in-flight key', () => {
    const moved = item({ stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], matchedKeys: ['planReview'] })
    const result = repairsOf({ items: [moved], endedStages: [ended()], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([])
  })

  it.each(['questions', 'blocked', 'interrupted', 'usage-limit'] as const)('%s produces nothing', (outcome) => {
    const result = repairsOf({ items: [item()], endedStages: [ended({ outcome })], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('the newest ended stage for a number wins when more than one is present', () => {
    const older = ended({ at: '2025-12-31T00:00:00.000Z' })
    const newer = ended({ outcome: 'error', labels: { kind: 'applied' }, at: '2025-12-31T23:00:00.000Z' })
    const result = repairsOf({ items: [item()], endedStages: [older, newer], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.reports).toEqual([])
    expect(result.observations).toEqual([])
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
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'plan-missing-approved', labels: ['planApproved'], agent: null, reason: null }])
  })

  it('prOpened with linkReason counterpart-not-open (closed unmerged) reports pr-missing', () => {
    const result = repairsOf({ items: [atStage('prOpened', 'terminal', { linkReason: 'counterpart-not-open' })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([{ number: 52, kind: 'issue', shape: 'pr-missing', labels: ['prOpened'], agent: null, reason: null }])
  })

  it('prOpened with linkReason counterpart-merged produces no report and no observation', () => {
    const result = repairsOf({ items: [atStage('prOpened', 'terminal', { linkReason: 'counterpart-merged' })], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })

  it('a pull request never triggers an artifact shape', () => {
    const pr = atStage('prOpened', 'terminal', { kind: 'pull-request', linkReason: 'counterpart-not-open' })
    const result = repairsOf({ items: [pr], endedStages: [], liveNumbers: new Set(), viewer: VIEWER, readAt: READ_AT })
    expect(result.observations).toEqual([])
    expect(result.reports).toEqual([])
  })
})
