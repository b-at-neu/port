import { describe, expect, it } from 'vitest'
import { displayOf } from '@/main/pipeline/state/display'
import { ticketOfKeys, type TicketOfKeysParams } from '@/main/pipeline/state/migrate'
import type { Ticket } from '@/utils/pipeline/ticket'
import { NOW, REPO, ticketOf } from '../../../../support/tickets'

type V1Key = TicketOfKeysParams['issueKeys'][number]

function fromKeys(issueKeys: readonly V1Key[], prKeys: readonly V1Key[] | null = null): Ticket {
  return ticketOfKeys({ repo: REPO, ticket: 1, issueKeys, pr: prKeys === null ? null : { number: 2, keys: prKeys, approvedAt: null }, history: [], at: NOW, mirrorFailure: null, reviewCycles: 0, stageHint: null }).ticket
}

describe('displayOf matches what each version-1 key set showed', () => {
  it.each([
    ['ready', ['port', 'planning']],
    ['planning', ['port', 'planning']],
    ['planReview', ['port', 'planning', 'needsYou']],
    ['planChangesRequested', ['port', 'planning']],
    ['planApproved', ['port', 'implementing']],
    ['inProgress', ['port', 'implementing']],
    ['blocked', ['port', 'implementing', 'needsYou']],
    ['readyForReview', ['port', 'reviewing']],
    ['reviewing', ['port', 'reviewing']],
    ['needsRevision', ['port', 'revising']],
    ['revising', ['port', 'revising']],
    ['refreshBranch', ['port', 'revising']],
    ['refreshing', ['port', 'revising']],
    ['approved', ['port', 'approved']],
    ['needsHuman', ['port', 'planning', 'needsYou']],
  ] as const)('an issue holding %s', (key, expected) => {
    expect(displayOf(fromKeys(['marker', key]))).toEqual(expected)
  })

  it('shows a pull request holding needsHuman alone as reviewing, and a refresh beside approved as revising', () => {
    expect(displayOf(fromKeys(['marker', 'prOpened'], ['marker', 'needsHuman']))).toEqual(['port', 'reviewing', 'needsYou'])
    expect(displayOf(fromKeys(['marker', 'prOpened'], ['marker', 'refreshBranch', 'approved']))).toEqual(['port', 'revising'])
  })

  it('shows a ticket and its pull request the same labels', () => {
    const merged = fromKeys(['marker', 'prOpened'], ['marker', 'reviewing'])
    expect(displayOf(merged)).toEqual(['port', 'reviewing'])
  })
})

describe('displayOf by stage and status', () => {
  it.each([
    ['plan', ['port', 'planning']],
    ['implement', ['port', 'implementing']],
    ['review', ['port', 'reviewing']],
    ['revise', ['port', 'revising']],
    ['refresh', ['port', 'revising']],
    ['merge', ['port', 'approved']],
  ] as const)('a running %s ticket', (stage, expected) => {
    expect(displayOf(ticketOf({ stage, status: { kind: 'running', runId: null } }))).toEqual(expected)
  })

  it.each([
    ['plan-approval', true],
    ['escalation', true],
    ['question', true],
    ['merge', false],
  ] as const)('a %s gate needs you: %s', (gate, needsYou) => {
    expect(displayOf(ticketOf({ stage: 'review', status: { kind: 'waiting-on-you', gate, detail: '' } })).includes('needsYou')).toBe(needsYou)
  })

  it('shows a held ticket as port alone and a done one as approved', () => {
    expect(displayOf(ticketOf({ status: { kind: 'held', on: 'paused', detail: '' } }))).toEqual(['port'])
    expect(displayOf(ticketOf({ stage: 'review', status: { kind: 'done', at: NOW } }))).toEqual(['port', 'approved'])
  })
})
