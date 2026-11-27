import { describe, expect, it, vi } from 'vitest'
import { emptyFile, parseFile, prune, recordMirror, seedFrom, ticketFor, trackedOf, viewOf, withTicket } from '@/main/pipeline/state/model'
import type { MirrorFailure, RepoRecord } from '@/types/pipeline-state'
import type { Ticket } from '@/utils/pipeline/ticket'
import { reconciledItem, repositoryState } from '../../../../support/board-snapshot'
import { NOW as AT, runOf, ticketOf } from '../../../../support/tickets'

function recordOf(...tickets: Ticket[]): RepoRecord {
  return tickets.reduce((record, ticket) => withTicket(record, ticket), { seededAt: AT, tickets: {} } as RepoRecord)
}

const withPr = (ticket: number, pr: number): Ticket => ticketOf({ ticket, pr: { number: pr, approvedAt: null }, stage: 'review' })

describe('parseFile', () => {
  it.each([undefined, null, '{', [], { version: 3 }, { version: 3, repositories: [] }, { version: 2, repositories: {} }, { version: 4, repositories: {} }])('reads %j as empty', (value) => {
    expect(parseFile(value)).toEqual(emptyFile())
  })

  it('keeps a good dispatch entry and drops a bad one, never the section', () => {
    const file = parseFile({ version: 3, dispatch: { a: { state: 'dispatching', since: AT }, b: { state: 'sleeping', since: null }, c: 'junk', d: { state: 'paused' } }, repositories: {} })
    expect(file.dispatch).toEqual({ a: { state: 'dispatching', since: AT }, d: { state: 'paused', since: null } })
  })

  it('keeps a good repository and drops a bad ticket, never the whole repository', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const file = parseFile({
      version: 3,
      dispatch: {},
      repositories: {
        'repo-a': { seededAt: AT, tickets: { '7': ticketOf({ ticket: 7 }), '8': { ticket: 8 }, '9': { ...ticketOf({ ticket: 9 }), stage: 'nowhere' } } },
        'repo-b': 'junk',
      },
    })
    expect(Object.keys(file.repositories)).toEqual(['repo-a'])
    expect(Object.keys(file.repositories['repo-a']?.tickets ?? {})).toEqual(['7'])
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})

describe('seedFrom', () => {
  it('stores one ticket per change, pairing a pull request with the issue it links', () => {
    const issue = ticketOf({ ticket: 5, stage: 'plan', status: { kind: 'held', on: 'paused', detail: '' } })
    const pr = ticketOf({ ticket: 5, pr: { number: 6, approvedAt: null }, stage: 'review', status: { kind: 'running', runId: null }, reviewCycles: 3 })
    const lone = ticketOf({ ticket: 8, stage: 'implement', status: { kind: 'running', runId: null } })
    const state = repositoryState([
      reconciledItem({ number: 5, linked: 6, ticket: issue }),
      reconciledItem({ number: 6, kind: 'pull-request', linked: 5, ticket: pr }),
      reconciledItem({ number: 8, ticket: lone }),
      reconciledItem({ number: 9, ticket: null }),
    ])
    const record = seedFrom(state, AT)
    expect(Object.keys(record.tickets).sort()).toEqual(['5', '8'])
    expect(record.tickets['5']).toMatchObject({ ticket: 5, pr: { number: 6, approvedAt: null }, stage: 'review', status: { kind: 'running' }, reviewCycles: 3 })
    expect(record.tickets['8']).toMatchObject({ pr: null, stage: 'implement', status: { kind: 'running' } })
  })
})

describe('ticketFor', () => {
  const record = recordOf(withPr(7, 70), ticketOf({ ticket: 9 }), ticketOf({ ticket: 80, pr: { number: 80, approvedAt: null } }))

  it.each([
    ['an issue by its number', { kind: 'issue' as const, number: 7 }, null, 7],
    ['a pull request by its own number', { kind: 'pull-request' as const, number: 70 }, null, 7],
    ['a new pull request by the issue its branch names', { kind: 'pull-request' as const, number: 90 }, 9, 9],
    ['a pull request-only ticket by its pull request', { kind: 'pull-request' as const, number: 80 }, null, 80],
  ])('finds %s', (_name, ref, issue, expected) => {
    expect(ticketFor(record, ref, issue)?.ticket).toBe(expected)
  })

  it.each([
    ['an unknown issue', { kind: 'issue' as const, number: 99 }, null],
    ['a new pull request naming no issue', { kind: 'pull-request' as const, number: 90 }, null],
    ['a new pull request whose issue already has one', { kind: 'pull-request' as const, number: 90 }, 7],
    ['the pull request number as an issue', { kind: 'issue' as const, number: 80 }, null],
  ])('does not find %s', (_name, ref, issue) => {
    expect(ticketFor(record, ref, issue)).toBeNull()
  })
})

describe('recordMirror', () => {
  const ref = { kind: 'issue' as const, number: 7 }
  const failure = (at: string, stderr = 'no label'): MirrorFailure => ({ at, outcome: { kind: 'write-failed', classification: 'unknown', stderr, reread: null } })
  const held = (): Ticket => ticketOf({ ticket: 7, mirror: { written: [], failure: failure(AT) } })

  it('sets and clears a failure', () => {
    const set = recordMirror(recordOf(ticketOf({ ticket: 7 })), ref, failure(AT))
    expect(set.tickets['7']?.mirror.failure).toEqual(failure(AT))
    expect(recordMirror(set, ref, null).tickets['7']?.mirror.failure).toBeNull()
  })

  it('returns the record unchanged for a missing ticket, a repeated clear, or the same failure again', () => {
    const record = recordOf(held())
    expect(recordMirror(record, { kind: 'issue', number: 99 }, failure(AT))).toBe(record)
    expect(recordMirror(record, ref, failure('2026-02-02T00:00:00.000Z'))).toBe(record)
    const clean = recordOf(ticketOf({ ticket: 7 }))
    expect(recordMirror(clean, ref, null)).toBe(clean)
  })

  it('replaces a failure that is a different one', () => {
    expect(recordMirror(recordOf(held()), ref, failure('2026-02-02T00:00:00.000Z', 'rate limited')).tickets['7']?.mirror.failure?.at).toBe('2026-02-02T00:00:00.000Z')
  })
})

describe('prune', () => {
  it.each([
    ['a closed issue with no pull request', [1], ['2', '3']],
    ['a closed pull request, with its issue', [20], ['1', '3']],
    ['a closed issue whose pull request is still open', [3], ['1', '2', '3']],
    ['nothing', [], ['1', '2', '3']],
  ])('drops %s', (_name, closed, kept) => {
    const record = recordOf(ticketOf({ ticket: 1 }), withPr(2, 20), withPr(3, 30))
    expect(Object.keys(prune(record, closed).tickets).sort()).toEqual(kept)
  })

  it.each([
    ['an open run', { endedAt: null }],
    ['an interrupted run', { endedAt: AT, interruption: { reason: 'crash' as const, detail: null, at: AT, resetsAt: null } }],
  ])('keeps a closed ticket with %s, so a kept worktree is never orphaned', (_name, run) => {
    const record = recordOf(ticketOf({ ticket: 1, runs: [runOf(run)] }), ticketOf({ ticket: 2, runs: [runOf({ id: 'done', endedAt: AT, outcome: 'completed' })] }))
    expect(Object.keys(prune(record, [1, 2]).tickets)).toEqual(['1'])
  })

  it('keeps the record identity when nothing matched', () => {
    const record = recordOf(ticketOf({ ticket: 1 }))
    expect(prune(record, [])).toBe(record)
    expect(prune(record, [99])).toBe(record)
  })
})

describe('view and tracked', () => {
  it('views a repository the store does not hold as unseeded, and tracks both halves of a ticket otherwise', () => {
    const record = recordOf(withPr(7, 70))
    expect(viewOf(undefined)).toEqual({ kind: 'unseeded' })
    expect(trackedOf(undefined)).toBeNull()
    expect(viewOf(record)).toMatchObject({ kind: 'store', items: [{ kind: 'issue', number: 7 }, { kind: 'pull-request', number: 70 }] })
    expect(trackedOf(record)).toEqual([
      { kind: 'issue', number: 7 },
      { kind: 'pull-request', number: 70 },
    ])
  })
})
