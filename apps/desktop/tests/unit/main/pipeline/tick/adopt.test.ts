import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import type { TickClaim } from '@/types/tick'
import type { Event, Stage, Ticket } from '@/utils/pipeline/ticket'
import { adoptionsOf, heldVerdictAdoption, heldVerdictOf, openPullRequestAdoption } from '@/main/pipeline/tick/adopt'
import { reconciledItem as item } from '../../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../../support/tickets'

const CLAIMED_AT = '2026-01-01T00:10:00.000Z'
const BEFORE_CLAIM = '2026-01-01T00:05:00.000Z'
const AFTER_CLAIM = '2026-01-01T00:20:00.000Z'

function claim(stage: Stage, overrides: Partial<TickClaim> = {}): TickClaim {
  return { number: 1, kind: stage === 'review' || stage === 'revise' || stage === 'refresh' ? 'pull-request' : 'issue', stage, class: 'suspect', retryable: false, ...overrides }
}

function adopt(items: readonly ReconciledItem[], claims: readonly TickClaim[]) {
  return adoptionsOf({ items, claims, viewer: 'op' })
}

const event = (action: string, to: Event['to'], at: string): Event => ({ at, action, actor: null, to, legacy: null })

/** A ticket whose latest claim began at `CLAIMED_AT`, queued beforehand by `queuedBy`. */
function claimedTicket(stage: Stage, queuedBy = 'seed'): Ticket {
  const history = [event(queuedBy, { stage, status: 'queued' }, BEFORE_CLAIM), event('claim', { stage, status: 'running' }, CLAIMED_AT)]
  return ticketAt(stage, { kind: 'running', runId: 'run-1' }, { ticket: 1, history })
}

const prs = [{ number: 780, state: 'OPEN' as const, headRefName: '1-the-fix' }]
const review = (verdict: string, submittedAt: string, commitOid: string | null = 'sha1') => ({ body: `## Code Review — Cycle 1 · ${verdict}\n0 open`, submittedAt, commitOid })

const implementing = (overrides: Partial<ReconciledItem> = {}): ReconciledItem => item({ ticket: claimedTicket('implement'), ...overrides })
const reviewing = (overrides: Partial<ReconciledItem> = {}): ReconciledItem => item({ number: 2, kind: 'pull-request', ticket: claimedTicket('review'), headRefOid: 'sha1', ...overrides })
const revising = (overrides: Partial<ReconciledItem> = {}): ReconciledItem => item({ number: 3, kind: 'pull-request', ticket: claimedTicket('revise'), ...overrides })

describe('adoptionsOf — claims no live session holds', () => {
  it('implement: exactly one open pull request on the issue’s own branch adopts pr-opened', () => {
    expect(adopt([implementing({ closingPullRequests: prs })], [claim('implement')])).toEqual([
      { kind: 'adopt', number: 1, itemKind: 'issue', agent: 'impl', stage: 'implement', trigger: 'planApproved', handback: { token: 'pr-opened', arg: '#780' }, evidence: 'pr' },
    ])
  })

  it.each([
    ['two open pull requests', [{ number: 8, state: 'OPEN' as const, headRefName: '1-a' }, { number: 9, state: 'OPEN' as const, headRefName: '1-b' }]],
    ['a pull request on a foreign branch', [{ number: 8, state: 'OPEN' as const, headRefName: 'other' }]],
    ['a merged pull request', [{ number: 8, state: 'MERGED' as const, headRefName: '1-a' }]],
    ['a pull request with no branch name', [{ number: 8, state: 'OPEN' as const, headRefName: null }]],
    ['no pull request', []],
    ['closing pull requests that were never read', null],
  ])('implement: %s adopts nothing', (_name, closingPullRequests) => {
    expect(adopt([implementing({ closingPullRequests })], [claim('implement')])).toEqual([])
  })

  it('plan: a plan in the body, queued fresh, adopts plan-written', () => {
    const planning = item({ ticket: claimedTicket('plan'), planPresent: true })
    expect(adopt([planning], [claim('plan')])).toEqual([
      { kind: 'adopt', number: 1, itemKind: 'issue', agent: 'plan', stage: 'plan', trigger: 'ready', handback: { token: 'plan-written', arg: null }, evidence: 'plan' },
    ])
  })

  it('plan: a revision claim is never adopted, because the old plan already satisfies the body check', () => {
    const planning = item({ ticket: claimedTicket('plan', 'request-plan-changes'), planPresent: true })
    expect(adopt([planning], [claim('plan')])).toEqual([])
  })

  it('plan: no plan in the body adopts nothing', () => {
    expect(adopt([item({ ticket: claimedTicket('plan'), planPresent: false })], [claim('plan')])).toEqual([])
  })

  it('review: an approving review on the current head after the claim adopts approved', () => {
    expect(adopt([reviewing({ reviews: [review('approved', AFTER_CLAIM)] })], [claim('review', { number: 2 })])).toEqual([
      { kind: 'adopt', number: 2, itemKind: 'pull-request', agent: 'review', stage: 'review', trigger: 'readyForReview', handback: { token: 'approved', arg: null }, evidence: 'review' },
    ])
  })

  it('review: a needs-revision review adopts needs-revision', () => {
    const [adoption] = adopt([reviewing({ reviews: [review('needs revision', AFTER_CLAIM)] })], [claim('review', { number: 2 })])
    expect(adoption?.handback).toEqual({ token: 'needs-revision', arg: null })
  })

  it.each([
    ['a review posted before the claim', [review('approved', BEFORE_CLAIM)], 'sha1'],
    ['a review of an older head', [review('approved', AFTER_CLAIM, 'old')], 'sha1'],
    ['a verdict that is neither approved nor needs revision', [review('blocked — checks pending', AFTER_CLAIM)], 'sha1'],
    ['no review at all', [], 'sha1'],
    ['an unknown head', [review('approved', AFTER_CLAIM)], null],
  ])('review: %s adopts nothing', (_name, reviews, headRefOid) => {
    expect(adopt([reviewing({ reviews, headRefOid })], [claim('review', { number: 2 })])).toEqual([])
  })

  it('revise: a head that moved past the reviewed one adopts revised', () => {
    const moved = revising({ headRefOid: 'new', reviews: [review('needs revision', BEFORE_CLAIM, 'old')] })
    expect(adopt([moved], [claim('revise', { number: 3 })])).toEqual([
      { kind: 'adopt', number: 3, itemKind: 'pull-request', agent: 'revise', stage: 'revise', trigger: 'needsRevision', handback: { token: 'revised', arg: null }, evidence: 'head-moved' },
    ])
  })

  it('revise: an unmoved head adopts nothing', () => {
    const unmoved = revising({ headRefOid: 'old', reviews: [review('needs revision', BEFORE_CLAIM, 'old')] })
    expect(adopt([unmoved], [claim('revise', { number: 3 })])).toEqual([])
  })

  it('refresh: never adopted — a re-run is cheap and idempotent', () => {
    const refreshing = item({ number: 4, kind: 'pull-request', ticket: claimedTicket('refresh'), headRefOid: 'new' })
    expect(adopt([refreshing], [claim('refresh', { number: 4 })])).toEqual([])
  })

  it('a claim with no recorded claim instant adopts nothing', () => {
    const unclaimed = item({ ticket: ticketAt('implement', queuedAt(), { ticket: 1 }), closingPullRequests: prs })
    expect(adopt([unclaimed], [claim('implement')])).toEqual([])
  })

  it('an item the record does not track adopts nothing', () => {
    expect(adopt([item({ ticket: null, closingPullRequests: prs })], [claim('implement')])).toEqual([])
  })

  it.each(['matched', 'session-required'] as const)('a %s claim is never adopted, since a session or an operator still holds it', (cls) => {
    expect(adopt([implementing({ closingPullRequests: prs })], [claim('implement', { class: cls })])).toEqual([])
  })

  it.each(['no-record', 'suspect', 'stalled-confirmed', 'capped', 'interrupted'] as const)('a %s claim is adoptable', (cls) => {
    expect(adopt([implementing({ closingPullRequests: prs })], [claim('implement', { class: cls })])).toHaveLength(1)
  })

  it('an item the viewer does not own adopts nothing', () => {
    expect(adopt([implementing({ closingPullRequests: prs, assignees: ['someone-else'] })], [claim('implement')])).toEqual([])
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
  it('adopts the one open pull request on a queued issue’s own branch', () => {
    const queued = item({ number: 749, ticket: ticketAt('implement', queuedAt(), { ticket: 749 }), closingPullRequests: [{ number: 780, state: 'OPEN', headRefName: '749-the-thing' }] })
    expect(openPullRequestAdoption(queued)?.handback).toEqual({ token: 'pr-opened', arg: '#780' })
  })
})

describe('heldVerdictAdoption', () => {
  it('adopts approved for a queued review whose head already carries an approving review', () => {
    const queued = item({ number: 2, kind: 'pull-request', ticket: ticketAt('review', queuedAt()), headRefOid: 'sha1', reviews: [review('approved', AFTER_CLAIM)] })
    expect(heldVerdictAdoption(queued)?.handback).toEqual({ token: 'approved', arg: null })
  })
})
