import { describe, expect, it } from 'vitest'
import { HANDBACK_TOKENS, eventWrites, expectFor, handbackRefusal, itemKindFor, pullRequestNumberOf, stageModeFor, transitionFor } from '@/main/dispatch/transitions'
import type { StageEvent, StageMode, StagePlanFile } from '@/types/stage-labels'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { resolveVocabulary } from '@/utils/labels/vocabulary'

function handback(mode: StageMode, observed: readonly LabelKey[], token: string, arg: string | null = null, extra: { prObserved?: readonly LabelKey[]; approvalGate?: boolean } = {}) {
  const event: StageEvent = { kind: 'outcome', outcome: 'completed', handback: { token, arg }, plan: { kind: 'read', body: '## Implementation Plan' } }
  return transitionFor({ event, mode, observed, approvalGate: extra.approvalGate ?? true, prObserved: extra.prObserved })
}

function onlyWrite(result: ReturnType<typeof transitionFor>) {
  if (result.kind !== 'write') throw new Error(`expected a write, got ${result.kind}`)
  return result.writes
}

describe('claim', () => {
  const claim = (mode: StageMode, observed: readonly LabelKey[]) => transitionFor({ event: { kind: 'claim' }, mode, observed, approvalGate: true })

  it('plan from ready claims planning and adds the marker', () => {
    expect(onlyWrite(claim('plan', ['ready']))).toEqual([{ itemKind: 'issue', numberFrom: 'item', add: ['planning', 'marker'], remove: ['ready'], action: 'stage-claim' }])
  })

  it('plan from planChangesRequested claims planning only', () => {
    expect(onlyWrite(claim('plan', ['planChangesRequested']))[0]).toMatchObject({ add: ['planning'], remove: ['planChangesRequested'] })
  })

  it.each([
    ['impl', 'planApproved', 'inProgress', 'issue'],
    ['review', 'readyForReview', 'reviewing', 'pull-request'],
    ['revise', 'needsRevision', 'revising', 'pull-request'],
  ] as const)('%s moves its trigger to its in-flight label', (mode, trigger, inFlight, itemKind) => {
    expect(onlyWrite(claim(mode, [trigger]))).toEqual([{ itemKind, numberFrom: 'item', add: [inFlight], remove: [trigger], action: 'stage-claim' }])
  })

  it('refresh claims refreshing and leaves approved in place', () => {
    expect(onlyWrite(claim('refresh', ['refreshBranch', 'approved']))[0]).toMatchObject({ add: ['refreshing'], remove: ['refreshBranch'] })
  })

  it('refresh also removes one leftover trigger', () => {
    expect(onlyWrite(claim('refresh', ['refreshBranch', 'needsRevision']))[0]).toMatchObject({ add: ['refreshing'], remove: ['refreshBranch', 'needsRevision'] })
  })

  it('is moved when a second role-bearing label is present', () => {
    expect(claim('impl', ['planApproved', 'blocked'])).toEqual({ kind: 'refused', reason: 'moved' })
  })

  it('is moved when the trigger is gone', () => {
    expect(claim('impl', [])).toEqual({ kind: 'refused', reason: 'moved' })
    expect(claim('impl', ['inProgress'])).toEqual({ kind: 'refused', reason: 'moved' })
  })

  it('is moved when refresh finds two leftover triggers', () => {
    expect(claim('refresh', ['refreshBranch', 'readyForReview', 'needsRevision'])).toEqual({ kind: 'refused', reason: 'moved' })
  })

  it('is moved when a non-refresh claim finds approved beside its trigger', () => {
    expect(claim('review', ['readyForReview', 'approved'])).toEqual({ kind: 'refused', reason: 'moved' })
  })
})

describe('rollback and error', () => {
  const rollback = (mode: StageMode, observed: readonly LabelKey[]) => transitionFor({ event: { kind: 'rollback' }, mode, observed, approvalGate: true })

  it.each([
    ['plan', 'planning', 'ready'],
    ['impl', 'inProgress', 'planApproved'],
    ['review', 'reviewing', 'readyForReview'],
    ['revise', 'revising', 'needsRevision'],
    ['refresh', 'refreshing', 'refreshBranch'],
  ] as const)('%s returns to its trigger', (mode, inFlight, trigger) => {
    expect(onlyWrite(rollback(mode, [inFlight]))[0]).toMatchObject({ add: [trigger], remove: [inFlight], action: 'stage-rollback' })
  })

  it('impl also accepts a blocked ticket', () => {
    expect(onlyWrite(rollback('impl', ['blocked']))[0]).toMatchObject({ add: ['planApproved'], remove: ['blocked'] })
  })

  it('another stage does not accept blocked', () => {
    expect(rollback('review', ['blocked'])).toEqual({ kind: 'refused', reason: 'moved' })
  })

  it('refresh tolerates approved', () => {
    expect(onlyWrite(rollback('refresh', ['refreshing', 'approved']))[0]).toMatchObject({ add: ['refreshBranch'], remove: ['refreshing'] })
  })

  it('an error outcome resets under its own action', () => {
    const result = transitionFor({ event: { kind: 'outcome', outcome: 'error', handback: null, plan: null }, mode: 'impl', observed: ['inProgress'], approvalGate: true })
    expect(onlyWrite(result)[0]).toMatchObject({ add: ['planApproved'], remove: ['inProgress'], action: 'stage-error-reset' })
  })
})

describe('blocked and the next turn', () => {
  it('impl moves inProgress to blocked', () => {
    const result = transitionFor({ event: { kind: 'outcome', outcome: 'blocked', handback: null, plan: null }, mode: 'impl', observed: ['inProgress'], approvalGate: true })
    expect(onlyWrite(result)).toEqual([{ itemKind: 'issue', numberFrom: 'item', add: ['blocked'], remove: ['inProgress'], action: 'stage-blocked' }])
  })

  it.each(['plan', 'review', 'revise', 'refresh'] as const)('%s writes nothing on blocked', (mode) => {
    expect(transitionFor({ event: { kind: 'outcome', outcome: 'blocked', handback: null, plan: null }, mode, observed: [], approvalGate: true })).toEqual({ kind: 'none' })
  })

  it('impl moves blocked back to inProgress on the next turn', () => {
    const result = transitionFor({ event: { kind: 'resumed-turn' }, mode: 'impl', observed: ['blocked'], approvalGate: true })
    expect(onlyWrite(result)[0]).toMatchObject({ add: ['inProgress'], remove: ['blocked'], action: 'stage-unblocked' })
  })

  it('the next turn is moved once the human has already cleared the block', () => {
    expect(transitionFor({ event: { kind: 'resumed-turn' }, mode: 'impl', observed: ['inProgress'], approvalGate: true })).toEqual({ kind: 'refused', reason: 'moved' })
  })

  it.each(['questions', 'interrupted', 'usage-limit'] as const)('%s writes nothing', (outcome) => {
    expect(transitionFor({ event: { kind: 'outcome', outcome, handback: null, plan: null }, mode: 'impl', observed: ['inProgress'], approvalGate: true })).toEqual({ kind: 'none' })
  })
})

describe('hand-back tokens', () => {
  it('plan-written moves planning to planReview', () => {
    expect(onlyWrite(handback('plan', ['planning'], 'plan-written'))).toEqual([{ itemKind: 'issue', numberFrom: 'item', add: ['planReview'], remove: ['planning'], action: 'stage-handback-plan-written' }])
  })

  it.each([
    ['approved', 'approved'],
    ['needs-revision', 'needsRevision'],
    ['checks-pending', 'needsHuman'],
    ['rebase-required', 'refreshBranch'],
    ['head-moved', 'readyForReview'],
  ] as const)('review %s moves reviewing to %s', (token, target) => {
    expect(onlyWrite(handback('review', ['reviewing'], token))).toEqual([{ itemKind: 'pull-request', numberFrom: 'item', add: [target], remove: ['reviewing'], action: `stage-handback-${token}` }])
  })

  it('revised moves revising to readyForReview', () => {
    expect(onlyWrite(handback('revise', ['revising'], 'revised'))[0]).toMatchObject({ add: ['readyForReview'], remove: ['revising'] })
  })

  it('escalated moves revising to needsHuman', () => {
    expect(onlyWrite(handback('revise', ['revising'], 'escalated'))[0]).toMatchObject({ add: ['needsHuman'], remove: ['revising'] })
  })

  it('refreshed clean on an unapproved pull request returns it to review', () => {
    expect(onlyWrite(handback('refresh', ['refreshing'], 'refreshed', 'clean'))[0]).toMatchObject({ add: ['readyForReview'], remove: ['refreshing'] })
  })

  it('refreshed clean on an approved pull request keeps it approved', () => {
    expect(onlyWrite(handback('refresh', ['refreshing', 'approved'], 'refreshed', 'clean'))[0]).toMatchObject({ add: [], remove: ['refreshing'] })
  })

  it('refreshed resolved withdraws approval and returns to review', () => {
    expect(onlyWrite(handback('refresh', ['refreshing', 'approved'], 'refreshed', 'resolved'))[0]).toMatchObject({ add: ['readyForReview'], remove: ['refreshing', 'approved'] })
    expect(onlyWrite(handback('refresh', ['refreshing'], 'refreshed', 'resolved'))[0]).toMatchObject({ add: ['readyForReview'], remove: ['refreshing'] })
  })

  it('a refresh escalation withdraws approval', () => {
    expect(onlyWrite(handback('refresh', ['refreshing', 'approved'], 'escalated'))[0]).toMatchObject({ add: ['needsHuman'], remove: ['refreshing', 'approved'] })
  })

  it('is moved when the in-flight label is gone or a second role-bearing label is present', () => {
    expect(handback('review', ['approved'], 'approved')).toEqual({ kind: 'refused', reason: 'moved' })
    expect(handback('revise', ['revising', 'needsHuman'], 'revised')).toEqual({ kind: 'refused', reason: 'moved' })
    expect(handback('plan', ['planning', 'approved'], 'plan-written')).toEqual({ kind: 'refused', reason: 'moved' })
  })
})

describe('a hand-back that lands after a liveness reset', () => {
  it('review approved applies from readyForReview, the trigger the reset put back, and removes that label', () => {
    expect(onlyWrite(handback('review', ['readyForReview'], 'approved'))).toEqual([{ itemKind: 'pull-request', numberFrom: 'item', add: ['approved'], remove: ['readyForReview'], action: 'stage-handback-approved' }])
  })

  it.each([
    ['plan', 'plan-written', ['ready'], 'planReview', 'ready'],
    ['revise', 'revised', ['needsRevision'], 'readyForReview', 'needsRevision'],
    ['revise', 'escalated', ['needsRevision'], 'needsHuman', 'needsRevision'],
  ] as const)('%s %s applies from the reset trigger %s', (mode, token, observed, target, source) => {
    expect(onlyWrite(handback(mode, observed, token))[0]).toMatchObject({ add: [target], remove: [source] })
  })

  it('a refresh hand-back applies from refreshBranch', () => {
    expect(onlyWrite(handback('refresh', ['refreshBranch'], 'refreshed', 'resolved'))[0]).toMatchObject({ add: ['readyForReview'], remove: ['refreshBranch'] })
  })

  it('pr-opened applies from planApproved, removing it', () => {
    const writes = onlyWrite(handback('impl', ['planApproved'], 'pr-opened', '#8'))
    expect(writes[1]).toMatchObject({ add: ['prOpened'], remove: ['planApproved'] })
  })

  it('a head-moved hand-back onto a label that is already there writes nothing', () => {
    expect(handback('review', ['readyForReview'], 'head-moved')).toEqual({ kind: 'none' })
  })

  it('still tolerates nothing else: both the in-flight label and its trigger present is moved', () => {
    expect(handback('review', ['reviewing', 'readyForReview'], 'approved')).toEqual({ kind: 'refused', reason: 'moved' })
    expect(handback('review', ['needsRevision'], 'approved')).toEqual({ kind: 'refused', reason: 'moved' })
  })
})

describe('adopt', () => {
  const adopt = (mode: StageMode, observed: readonly LabelKey[], token: string, arg: string | null = null, prObserved: readonly LabelKey[] = []) =>
    transitionFor({ event: { kind: 'adopt', handback: { token, arg } }, mode, observed, prObserved, approvalGate: true })

  it('plans the same rows as a completed hand-back, under its own action name', () => {
    expect(onlyWrite(adopt('review', ['reviewing'], 'approved'))).toEqual([{ itemKind: 'pull-request', numberFrom: 'item', add: ['approved'], remove: ['reviewing'], action: 'stage-adopt-approved' }])
    expect(onlyWrite(adopt('impl', ['planApproved'], 'pr-opened', '#780'))[1]).toMatchObject({ add: ['prOpened'], remove: ['planApproved'], action: 'stage-adopt-pr-opened' })
  })

  it('needs no plan file, since an adopted plan is already in the issue body', () => {
    expect(onlyWrite(adopt('plan', ['planning'], 'plan-written'))[0]).toMatchObject({ add: ['planReview'], remove: ['planning'] })
  })

  it('refuses an unknown token and an impl adoption with no pull request', () => {
    expect(adopt('review', ['reviewing'], 'nonsense')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
    expect(adopt('impl', ['planApproved'], 'pr-opened', null)).toEqual({ kind: 'refused', reason: 'unknown-handback' })
  })

  it('is moved when the labels are not exactly a source', () => {
    expect(adopt('review', ['approved'], 'approved')).toEqual({ kind: 'refused', reason: 'moved' })
  })
})

describe('pr-opened', () => {
  it('writes the pull request first, then the issue', () => {
    const writes = onlyWrite(handback('impl', ['inProgress'], 'pr-opened', '#8'))
    expect(writes).toEqual([
      { itemKind: 'pull-request', numberFrom: 'arg', add: ['readyForReview', 'marker'], remove: [], action: 'stage-handback-pr-opened' },
      { itemKind: 'issue', numberFrom: 'item', add: ['prOpened'], remove: ['inProgress'], action: 'stage-handback-pr-opened' },
    ])
  })

  it('adds no marker when the approval gate is off', () => {
    const writes = onlyWrite(handback('impl', ['inProgress'], 'pr-opened', '#8', { approvalGate: false }))
    expect(writes[0]).toMatchObject({ add: ['readyForReview'] })
  })

  it('accepts a blocked issue', () => {
    const writes = onlyWrite(handback('impl', ['blocked'], 'pr-opened', '8'))
    expect(writes[1]).toMatchObject({ remove: ['blocked'] })
  })

  it('is moved when the pull request already carries another role-bearing label', () => {
    expect(handback('impl', ['inProgress'], 'pr-opened', '#8', { prObserved: ['needsRevision'] })).toEqual({ kind: 'refused', reason: 'moved' })
  })

  it('tolerates a pull request that already carries the trigger', () => {
    expect(onlyWrite(handback('impl', ['inProgress'], 'pr-opened', '#8', { prObserved: ['readyForReview'] }))).toHaveLength(2)
  })
})

describe('unusable hand-backs', () => {
  it('completed with no hand-back line is no-handback', () => {
    expect(transitionFor({ event: { kind: 'outcome', outcome: 'completed', handback: null, plan: null }, mode: 'plan', observed: ['planning'], approvalGate: true })).toEqual({ kind: 'refused', reason: 'no-handback' })
  })

  const planWritten = (plan: StagePlanFile | null): StageEvent => ({ kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan })

  it('plan-written with no plan file is no-plan-file', () => {
    expect(handbackRefusal(planWritten(null), 'plan')).toBe('no-plan-file')
    expect(handbackRefusal(planWritten({ kind: 'missing', detail: null }), 'plan')).toBe('no-plan-file')
    expect(transitionFor({ event: planWritten({ kind: 'missing', detail: 'EACCES' }), mode: 'plan', observed: ['planning'], approvalGate: true })).toEqual({ kind: 'refused', reason: 'no-plan-file' })
  })

  it('plan-written with an empty plan file is empty-plan-file', () => {
    expect(transitionFor({ event: planWritten({ kind: 'empty' }), mode: 'plan', observed: ['planning'], approvalGate: true })).toEqual({ kind: 'refused', reason: 'empty-plan-file' })
  })

  it('plan-written with a read plan plans the planning to planReview swap unchanged', () => {
    const result = transitionFor({ event: planWritten({ kind: 'read', body: 'body' }), mode: 'plan', observed: ['planning'], approvalGate: true })
    expect(onlyWrite(result)[0]).toMatchObject({ add: ['planReview'], remove: ['planning'], action: 'stage-handback-plan-written' })
  })

  it('a token outside the stage vocabulary is unknown-handback', () => {
    expect(handback('plan', ['planning'], 'approved')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
    expect(handback('review', ['reviewing'], 'plan-written')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
  })

  it('a pr-opened without a usable pull request number is unknown-handback', () => {
    expect(handback('impl', ['inProgress'], 'pr-opened')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
    expect(handback('impl', ['inProgress'], 'pr-opened', 'eight')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
  })

  it('refreshed without clean or resolved is unknown-handback', () => {
    expect(handback('refresh', ['refreshing'], 'refreshed')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
    expect(handback('refresh', ['refreshing'], 'refreshed', 'dirty')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
  })

  it('tokens are case-sensitive', () => {
    expect(handback('plan', ['planning'], 'Plan-Written')).toEqual({ kind: 'refused', reason: 'unknown-handback' })
  })

  it('handbackRefusal reads no labels, so it can run before any read', () => {
    expect(handbackRefusal({ kind: 'outcome', outcome: 'completed', handback: null, plan: null }, 'impl')).toBe('no-handback')
    expect(handbackRefusal({ kind: 'outcome', outcome: 'completed', handback: { token: 'pr-opened', arg: '#8' }, plan: null }, 'impl')).toBeNull()
    expect(handbackRefusal({ kind: 'claim' }, 'impl')).toBeNull()
  })
})

describe('helpers', () => {
  it('the vocabulary covers every stage mode, and refresh shares escalated with revise', () => {
    expect(Object.keys(HANDBACK_TOKENS).sort()).toEqual(['impl', 'plan', 'refresh', 'review', 'revise'])
    expect(HANDBACK_TOKENS.refresh).toContain('escalated')
  })

  it('refresh mode follows the refreshBranch trigger', () => {
    expect(stageModeFor('revise', 'refreshBranch')).toBe('refresh')
    expect(stageModeFor('revise', 'needsRevision')).toBe('revise')
    expect(stageModeFor('impl', 'planApproved')).toBe('impl')
  })

  it('plan and impl write issues, the rest pull requests', () => {
    expect(['plan', 'impl', 'review', 'revise', 'refresh'].map((mode) => itemKindFor(mode as StageMode))).toEqual(['issue', 'issue', 'pull-request', 'pull-request', 'pull-request'])
  })

  it('pullRequestNumberOf accepts #n and n only', () => {
    expect(pullRequestNumberOf('#12')).toBe(12)
    expect(pullRequestNumberOf('12')).toBe(12)
    expect(pullRequestNumberOf('#0')).toBeNull()
    expect(pullRequestNumberOf('#12 more')).toBeNull()
    expect(pullRequestNumberOf(null)).toBeNull()
  })

  it('eventWrites skips the outcomes that wait for the session or for Resume', () => {
    expect(eventWrites({ kind: 'outcome', outcome: 'questions', handback: null, plan: null }, 'impl')).toBe(false)
    expect(eventWrites({ kind: 'outcome', outcome: 'interrupted', handback: null, plan: null }, 'impl')).toBe(false)
    expect(eventWrites({ kind: 'outcome', outcome: 'usage-limit', handback: null, plan: null }, 'impl')).toBe(false)
    expect(eventWrites({ kind: 'outcome', outcome: 'blocked', handback: null, plan: null }, 'review')).toBe(false)
    expect(eventWrites({ kind: 'outcome', outcome: 'blocked', handback: null, plan: null }, 'impl')).toBe(true)
    expect(eventWrites({ kind: 'outcome', outcome: 'completed', handback: null, plan: null }, 'plan')).toBe(true)
    expect(eventWrites({ kind: 'outcome', outcome: 'error', handback: null, plan: null }, 'plan')).toBe(true)
  })
})

describe('expectFor', () => {
  const vocabulary = resolveVocabulary({})

  it('names the exact observed set present and every other role-bearing key absent', () => {
    const expected = expectFor(['inProgress'], vocabulary, ['prOpened'], ['op'])
    expect(expected.present).toEqual(['inProgress'])
    expect(expected.absent).toContain('planApproved')
    expect(expected.absent).not.toContain('inProgress')
    expect(expected.absent).not.toContain('prOpened')
    expect(expected.absent).not.toContain('marker')
    expect(expected.assignees).toEqual({ kind: 'exactly', logins: ['op'] })
  })

  it('works over a renamed vocabulary, since it only ever names keys', () => {
    const renamed = resolveVocabulary({ labels: { inProgress: 'wip', planApproved: 'go' } })
    const expected = expectFor(['inProgress'], renamed, ['blocked'], ['op'])
    expect(expected.present).toEqual(['inProgress'])
    expect(expected.absent).toContain('planApproved')
  })
})

describe('renamed labels', () => {
  it('the table is keyed by label key, never by label name', () => {
    const renamed = resolveVocabulary({ labels: { ready: 'queued', planning: 'thinking' } })
    expect(renamed.labels.find((l) => l.key === 'ready')?.name).toBe('queued')
    expect(onlyWrite(transitionFor({ event: { kind: 'claim' }, mode: 'plan', observed: ['ready'], approvalGate: true }))[0]).toMatchObject({ add: ['planning', 'marker'], remove: ['ready'] })
  })
})
