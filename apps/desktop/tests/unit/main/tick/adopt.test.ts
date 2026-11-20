import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { TickClaim } from '@/types/tick'
import { adoptionsOf, heldVerdictOf, openPullRequestAdoption } from '@/main/tick/adopt'
import { reconciledItem as item } from '../../../fixtures/board-state'

const CLAIMED_AT = '2026-01-01T00:10:00.000Z'
const BEFORE_CLAIM = '2026-01-01T00:05:00.000Z'
const AFTER_CLAIM = '2026-01-01T00:20:00.000Z'

function claim(overrides: Partial<TickClaim> = {}): TickClaim {
  return { number: 1, kind: 'issue', inFlight: 'inProgress', class: 'suspect', retryKey: null, ...overrides }
}

function adopt(items: readonly ReconciledItem[], claims: readonly TickClaim[]) {
  return adoptionsOf({ items, claims, viewer: 'op' })
}

const history = (key: 'ready' | 'planChangesRequested' | 'planning' | 'inProgress' | 'reviewing' | 'revising', at: string) => ({ key, actor: null, at })

function inProgressItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return item({ stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], stageHistory: [history('inProgress', CLAIMED_AT)], ...overrides })
}

function reviewingItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return item({
    number: 2,
    kind: 'pull-request',
    stage: 'in-flight',
    stages: [{ key: 'reviewing', name: 'reviewing', role: 'in-flight' }],
    stageHistory: [history('reviewing', CLAIMED_AT)],
    headRefOid: 'sha1',
    ...overrides,
  })
}

const review = (verdict: string, submittedAt: string, commitOid: string | null = 'sha1') => ({ body: `## Code Review — Cycle 1 · ${verdict}\n0 open`, submittedAt, commitOid })

describe('adoptionsOf — claims no live session holds', () => {
  it('inProgress: exactly one open pull request on the issue’s own branch adopts pr-opened', () => {
    const prs = [{ number: 780, state: 'OPEN' as const, headRefName: '1-the-fix' }]
    expect(adopt([inProgressItem({ closingPullRequests: prs })], [claim()])).toEqual([
      { kind: 'adopt', number: 1, itemKind: 'issue', agent: 'impl', trigger: 'planApproved', handback: { token: 'pr-opened', arg: '#780' }, evidence: 'pr' },
    ])
  })

  it.each([
    ['two open pull requests', [{ number: 8, state: 'OPEN' as const, headRefName: '1-a' }, { number: 9, state: 'OPEN' as const, headRefName: '1-b' }]],
    ['a pull request on a foreign branch', [{ number: 8, state: 'OPEN' as const, headRefName: 'other' }]],
    ['a merged pull request', [{ number: 8, state: 'MERGED' as const, headRefName: '1-a' }]],
    ['a pull request with no branch name', [{ number: 8, state: 'OPEN' as const, headRefName: null }]],
    ['no pull request', []],
    ['closing pull requests that were never read', null],
  ])('inProgress: %s adopts nothing', (_name, closingPullRequests) => {
    expect(adopt([inProgressItem({ closingPullRequests })], [claim()])).toEqual([])
  })

  it('planning: a plan in the body, claimed from ready, adopts plan-written', () => {
    const planning = item({ stage: 'in-flight', stages: [{ key: 'planning', name: 'planning', role: 'in-flight' }], planPresent: true, stageHistory: [history('ready', BEFORE_CLAIM), history('planning', CLAIMED_AT)] })
    expect(adopt([planning], [claim({ inFlight: 'planning' })])).toEqual([
      { kind: 'adopt', number: 1, itemKind: 'issue', agent: 'plan', trigger: 'ready', handback: { token: 'plan-written', arg: null }, evidence: 'plan' },
    ])
  })

  it('planning: a revision claim is never adopted, because the old plan already satisfies the body check', () => {
    const planning = item({ stage: 'in-flight', stages: [{ key: 'planning', name: 'planning', role: 'in-flight' }], planPresent: true, stageHistory: [history('planChangesRequested', BEFORE_CLAIM), history('planning', CLAIMED_AT)] })
    expect(adopt([planning], [claim({ inFlight: 'planning' })])).toEqual([])
  })

  it('planning: no plan in the body adopts nothing', () => {
    const planning = item({ stage: 'in-flight', stages: [{ key: 'planning', name: 'planning', role: 'in-flight' }], planPresent: false, stageHistory: [history('ready', BEFORE_CLAIM), history('planning', CLAIMED_AT)] })
    expect(adopt([planning], [claim({ inFlight: 'planning' })])).toEqual([])
  })

  it('reviewing: an approving review on the current head after the claim adopts approved', () => {
    expect(adopt([reviewingItem({ reviews: [review('approved', AFTER_CLAIM)] })], [claim({ number: 2, kind: 'pull-request', inFlight: 'reviewing' })])).toEqual([
      { kind: 'adopt', number: 2, itemKind: 'pull-request', agent: 'review', trigger: 'readyForReview', handback: { token: 'approved', arg: null }, evidence: 'review' },
    ])
  })

  it('reviewing: a needs-revision review adopts needs-revision', () => {
    const [adoption] = adopt([reviewingItem({ reviews: [review('needs revision', AFTER_CLAIM)] })], [claim({ number: 2, kind: 'pull-request', inFlight: 'reviewing' })])
    expect(adoption?.handback).toEqual({ token: 'needs-revision', arg: null })
  })

  it.each([
    ['a review posted before the claim', [review('approved', BEFORE_CLAIM)], 'sha1'],
    ['a review of an older head', [review('approved', AFTER_CLAIM, 'old')], 'sha1'],
    ['a verdict that is neither approved nor needs revision', [review('blocked — checks pending', AFTER_CLAIM)], 'sha1'],
    ['no review at all', [], 'sha1'],
    ['an unknown head', [review('approved', AFTER_CLAIM)], null],
  ])('reviewing: %s adopts nothing', (_name, reviews, headRefOid) => {
    expect(adopt([reviewingItem({ reviews, headRefOid })], [claim({ number: 2, kind: 'pull-request', inFlight: 'reviewing' })])).toEqual([])
  })

  it('revising: a head that moved past the reviewed one adopts revised', () => {
    const revising = item({ number: 3, kind: 'pull-request', stage: 'in-flight', stages: [{ key: 'revising', name: 'revising', role: 'in-flight' }], stageHistory: [history('revising', CLAIMED_AT)], headRefOid: 'new', reviews: [review('needs revision', BEFORE_CLAIM, 'old')] })
    expect(adopt([revising], [claim({ number: 3, kind: 'pull-request', inFlight: 'revising' })])).toEqual([
      { kind: 'adopt', number: 3, itemKind: 'pull-request', agent: 'revise', trigger: 'needsRevision', handback: { token: 'revised', arg: null }, evidence: 'head-moved' },
    ])
  })

  it('revising: an unmoved head adopts nothing', () => {
    const revising = item({ number: 3, kind: 'pull-request', stage: 'in-flight', stages: [{ key: 'revising', name: 'revising', role: 'in-flight' }], stageHistory: [history('revising', CLAIMED_AT)], headRefOid: 'old', reviews: [review('needs revision', BEFORE_CLAIM, 'old')] })
    expect(adopt([revising], [claim({ number: 3, kind: 'pull-request', inFlight: 'revising' })])).toEqual([])
  })

  it('refreshing: never adopted — a re-run is cheap and idempotent', () => {
    const refreshing = item({ number: 4, kind: 'pull-request', stage: 'in-flight', stages: [{ key: 'refreshing', name: 'refreshing', role: 'in-flight' }], stageHistory: [{ key: 'refreshing', actor: null, at: CLAIMED_AT }], headRefOid: 'new' })
    expect(adopt([refreshing], [claim({ number: 4, kind: 'pull-request', inFlight: 'refreshing' })])).toEqual([])
  })

  it('a claim with no recorded claim instant adopts nothing', () => {
    const prs = [{ number: 780, state: 'OPEN' as const, headRefName: '1-the-fix' }]
    expect(adopt([inProgressItem({ closingPullRequests: prs, stageHistory: [] })], [claim()])).toEqual([])
  })

  it.each(['matched', 'session-required'] as const)('a %s claim is never adopted, since a session or an operator still holds it', (cls) => {
    const prs = [{ number: 780, state: 'OPEN' as const, headRefName: '1-the-fix' }]
    expect(adopt([inProgressItem({ closingPullRequests: prs })], [claim({ class: cls })])).toEqual([])
  })

  it.each(['no-record', 'suspect', 'stalled-confirmed', 'capped', 'interrupted'] as const)('a %s claim is adoptable', (cls) => {
    const prs = [{ number: 780, state: 'OPEN' as const, headRefName: '1-the-fix' }]
    expect(adopt([inProgressItem({ closingPullRequests: prs })], [claim({ class: cls })])).toHaveLength(1)
  })

  it('an item the viewer does not own adopts nothing', () => {
    const prs = [{ number: 780, state: 'OPEN' as const, headRefName: '1-the-fix' }]
    expect(adopt([inProgressItem({ closingPullRequests: prs, assignees: ['someone-else'] })], [claim()])).toEqual([])
  })
})

describe('heldVerdictOf', () => {
  it('reads an approving review on the current head', () => {
    expect(heldVerdictOf({ headRefOid: 'sha1', reviews: [review('approved', AFTER_CLAIM)] })).toBe('approved')
  })

  it('reads the newest review, so a later needs-revision supersedes an earlier approval', () => {
    expect(heldVerdictOf({ headRefOid: 'sha1', reviews: [review('approved', BEFORE_CLAIM), review('needs revision', AFTER_CLAIM)] })).toBeNull()
  })

  it('reads nothing for another head, an unknown head or no reviews', () => {
    expect(heldVerdictOf({ headRefOid: 'sha2', reviews: [review('approved', AFTER_CLAIM)] })).toBeNull()
    expect(heldVerdictOf({ headRefOid: null, reviews: [review('approved', AFTER_CLAIM)] })).toBeNull()
    expect(heldVerdictOf({ headRefOid: 'sha1', reviews: null })).toBeNull()
  })
})

describe('openPullRequestAdoption', () => {
  it('adopts the one open pull request on a planApproved issue’s own branch', () => {
    const planApproved = item({ number: 749, stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }], closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-the-thing' }] })
    expect(openPullRequestAdoption(planApproved)?.handback).toEqual({ token: 'pr-opened', arg: '#780' })
  })
})
