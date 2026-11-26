import { describe, expect, it } from 'vitest'
import { displayNamesOf, halvesOf, issueNumberOfBranch, itemsOf, legacyKeysOf, mirrorDiff, mirrorNamesOf } from '@/main/pipeline/state/mirror'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { Event, Ticket } from '@/utils/pipeline/ticket'
import { NOW, ticketOf } from '../../../../support/tickets'

const waiting = (gate: 'plan-approval' | 'merge' | 'escalation') => ({ kind: 'waiting-on-you' as const, gate, detail: '' })
const running = { kind: 'running' as const, runId: null }
const prOf = (approvedAt: string | null = null) => ({ pr: { number: 9, approvedAt } })

describe('legacyKeysOf', () => {
  it.each([
    ['a queued plan', { stage: 'plan', status: { kind: 'queued', reason: 'new', since: NOW } }, ['marker', 'ready'], null],
    ['plan changes requested', { stage: 'plan', status: { kind: 'queued', reason: 'changes-requested', since: NOW } }, ['marker', 'planChangesRequested'], null],
    ['an auto-plan gate', { stage: 'plan', status: waiting('plan-approval'), autoPlan: true }, ['marker', 'autoPlan', 'planReview'], null],
    ['a blocked implementation', { stage: 'implement', status: { kind: 'blocked', on: [], reason: '' } }, ['marker', 'blocked'], null],
    ['a held ticket', { stage: 'implement', status: { kind: 'held', on: 'paused', detail: '' } }, ['marker'], null],
    ['a review in flight', { stage: 'review', status: running, ...prOf() }, ['marker', 'prOpened'], ['marker', 'reviewing']],
    ['a refresh of an approved pull request', { stage: 'refresh', status: { kind: 'queued', reason: 'new', since: NOW }, ...prOf(NOW) }, ['marker', 'prOpened'], ['marker', 'refreshBranch', 'approved']],
    ['an escalated revision', { stage: 'revise', status: waiting('escalation'), ...prOf() }, ['marker', 'prOpened'], ['marker', 'needsHuman']],
    ['the merge gate', { stage: 'merge', status: waiting('merge'), ...prOf(NOW) }, ['marker', 'prOpened'], ['marker', 'approved']],
    ['a merged ticket', { stage: 'merge', status: { kind: 'done', at: NOW }, ...prOf(NOW) }, ['marker', 'prOpened'], ['marker', 'approved']],
  ] as const)('%s', (_name, shape, issueKeys, prKeys) => {
    const ticket = ticketOf(shape as Partial<Ticket>)
    expect(legacyKeysOf(ticket, 'issue')).toEqual(issueKeys)
    expect(legacyKeysOf(ticket, 'pull-request')).toEqual(prKeys)
  })

  it('leaves the issue half untracked for a pull request-only ticket', () => {
    const ticket = ticketOf({ ticket: 9, pr: { number: 9, approvedAt: null }, stage: 'review' })
    expect(legacyKeysOf(ticket, 'issue')).toBeNull()
    expect(halvesOf(ticket)).toEqual([{ kind: 'pull-request', number: 9 }])
  })
})

describe('itemsOf', () => {
  const history: Event[] = [
    { at: '2026-11-23T10:00:00.000Z', action: 'stage-claim', actor: null, to: { stage: 'implement', status: 'running' }, legacy: { add: ['issue:inProgress'], remove: ['issue:planApproved'] } },
    { at: '2026-11-23T11:00:00.000Z', action: 'stage-handback-pr-opened', actor: 'op', to: { stage: 'review', status: 'queued' }, legacy: { add: ['issue:prOpened', 'pull-request:readyForReview'], remove: ['issue:inProgress'] } },
    { at: '2026-11-23T11:30:00.000Z', action: 'noop', actor: null, to: null, legacy: null },
  ]
  const ticket = ticketOf({ ticket: 7, pr: { number: 70, approvedAt: null }, stage: 'review', reviewCycles: 2, autoPlan: true, history })

  it('projects each half with its own keys, its own history rows and the ticket link', () => {
    expect(itemsOf(ticket)).toMatchObject([
      { kind: 'issue', number: 7, keys: ['prOpened'], marked: true, autoPlan: true, issue: null, reviewCycles: 2, claimedAt: '2026-11-23T10:00:00.000Z' },
      { kind: 'pull-request', number: 70, keys: ['readyForReview'], marked: true, autoPlan: false, issue: 7 },
    ])
    expect(itemsOf(ticket).map((item) => item.history)).toEqual([
      [
        { at: history[0]?.at, action: 'stage-claim', add: ['inProgress'], remove: ['planApproved'], actor: null },
        { at: history[1]?.at, action: 'stage-handback-pr-opened', add: ['prOpened'], remove: ['inProgress'], actor: 'op' },
      ],
      [{ at: history[1]?.at, action: 'stage-handback-pr-opened', add: ['readyForReview'], remove: [], actor: 'op' }],
    ])
  })

  it('has no ticket link for a pull request that is its own ticket', () => {
    expect(itemsOf(ticketOf({ ticket: 9, pr: { number: 9, approvedAt: null }, stage: 'review' }))).toMatchObject([{ kind: 'pull-request', number: 9, issue: null }])
  })
})

describe('issueNumberOfBranch', () => {
  it.each([
    ['751-one-way-display-mirror', 751],
    ['7-x', 7],
  ])('%s → %i', (branch, number) => {
    expect(issueNumberOfBranch(branch)).toBe(number)
  })

  it.each([null, '', 'main', 'feature-12-thing', 'v2-x', '12'])('%s names no ticket', (branch) => {
    expect(issueNumberOfBranch(branch)).toBeNull()
  })
})

describe('mirrorDiff', () => {
  const all = ['port', 'needs you', 'planning', 'implementing', 'reviewing', 'revising', 'approved']

  it('adds what is missing and removes every other vocabulary label that is present', () => {
    expect(mirrorDiff(['port', 'implementing'], all, ['planning', 'approved'])).toEqual({ addNames: ['port', 'implementing'], removeNames: ['planning', 'approved'] })
  })

  it('writes nothing when the labels already match', () => {
    expect(mirrorDiff(['port', 'planning'], all, ['port', 'planning'])).toEqual({ addNames: [], removeNames: [] })
  })

  it('compares case-insensitively and writes the configured casing', () => {
    expect(mirrorDiff(['Port', 'Planning'], all, ['port', 'PLANNING', 'Approved'])).toEqual({ addNames: [], removeNames: ['approved'] })
    expect(mirrorDiff(['Port'], all, [])).toEqual({ addNames: ['Port'], removeNames: [] })
  })

  it('never touches a label outside the vocabulary', () => {
    expect(mirrorDiff(['port'], all, ['port', 'bug', 'good first issue'])).toEqual({ addNames: [], removeNames: [] })
  })
})

describe('display names', () => {
  const vocabulary = resolveDisplayVocabulary({ labels: { needsYou: 'help' }, states: { implementing: 'building' } })

  it('resolves keys through the configured names', () => {
    expect(displayNamesOf(vocabulary, ['port', 'implementing', 'needsYou'])).toEqual(['port', 'building', 'help'])
  })

  it('removes a legacy label an item still carries, since the legacy names are part of what is cleaned up', () => {
    const names = mirrorNamesOf(['port', 'implementing'], vocabulary, resolveVocabulary({}))
    expect(names.desired).toEqual(['port', 'building'])
    expect(names.all).toEqual(expect.arrayContaining(['port', 'help', 'building', 'claude', 'plan approved', 'in progress']))
    expect(mirrorDiff(names.desired, names.all, ['claude', 'in progress', 'bug'])).toEqual({ addNames: ['port', 'building'], removeNames: ['claude', 'in progress'] })
  })
})
