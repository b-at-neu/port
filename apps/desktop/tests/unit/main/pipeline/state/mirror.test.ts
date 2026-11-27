import { describe, expect, it } from 'vitest'
import { displayNamesOf, halvesOf, issueNumberOfBranch, itemsOf, mirrorDiff, mirrorNamesOf } from '@/main/pipeline/state/mirror'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { ticketOf } from '../../../../support/tickets'

describe('halvesOf', () => {
  it('leaves the issue half untracked for a pull request-only ticket', () => {
    const ticket = ticketOf({ ticket: 9, pr: { number: 9, approvedAt: null }, stage: 'review' })
    expect(halvesOf(ticket)).toEqual([{ kind: 'pull-request', number: 9 }])
  })

  it('lists the issue first, then its pull request', () => {
    const ticket = ticketOf({ ticket: 7, pr: { number: 70, approvedAt: null }, stage: 'review' })
    expect(halvesOf(ticket)).toEqual([{ kind: 'issue', number: 7 }, { kind: 'pull-request', number: 70 }])
  })
})

describe('itemsOf', () => {
  it('projects each half with the ticket', () => {
    const ticket = ticketOf({ ticket: 7, pr: { number: 70, approvedAt: null }, stage: 'review' })
    expect(itemsOf(ticket)).toEqual([
      { kind: 'issue', number: 7, ticket },
      { kind: 'pull-request', number: 70, ticket },
    ])
  })

  it('has no issue half for a pull request that is its own ticket', () => {
    expect(itemsOf(ticketOf({ ticket: 9, pr: { number: 9, approvedAt: null }, stage: 'review' })).map((item) => item.kind)).toEqual(['pull-request'])
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

  it('cleans up every configured display name, and only those', () => {
    const names = mirrorNamesOf(['port', 'implementing'], vocabulary)
    expect(names.desired).toEqual(['port', 'building'])
    expect(names.all).toEqual(['port', 'help', 'planning', 'building', 'reviewing', 'revising', 'approved'])
    expect(mirrorDiff(names.desired, names.all, ['planning', 'bug'])).toEqual({ addNames: ['port', 'building'], removeNames: ['planning'] })
  })
})
