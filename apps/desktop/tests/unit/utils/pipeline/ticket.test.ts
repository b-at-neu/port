import { describe, expect, it } from 'vitest'
import { ticketSchema, type Status } from '@/utils/pipeline/ticket'
import { NOW, runOf, ticketOf } from '../../../support/tickets'

const parses = (value: unknown) => ticketSchema.safeParse(value).success

describe('ticketSchema', () => {
  const statuses: Status[] = [
    { kind: 'queued', reason: 'retry', since: NOW },
    { kind: 'held', on: 'budget', detail: 'over the cap' },
    { kind: 'running', runId: 'run-1' },
    { kind: 'running', runId: null },
    { kind: 'waiting-on-you', gate: 'question', detail: 'which branch?' },
    { kind: 'blocked', on: [12], reason: 'dependency open' },
    { kind: 'done', at: NOW },
  ]

  it.each(statuses.map((status) => [status.kind, status] as const))('accepts a %s ticket', (_kind, status) => {
    expect(parses(ticketOf({ status }))).toBe(true)
  })

  it('accepts a populated run, event and mirror failure', () => {
    const full = ticketOf({
      pr: { number: 7, approvedAt: NOW },
      runs: [
        runOf({ stage: 'plan', claudeSessionId: 'abc', endedAt: NOW, outcome: 'completed', handback: { token: 'plan-ready', arg: null }, costUsd: 0.5, denials: [{ id: 'd1', toolName: 'Bash', inputSummary: 'rm', rule: 'deny', at: NOW }] }),
      ],
      history: [{ at: NOW, action: 'dispatch', actor: 'me', to: { stage: 'plan', status: 'running' }, legacy: null }],
      mirror: { written: ['planning'], failure: { at: NOW, outcome: { kind: 'no-op' } } },
    })
    expect(parses(full)).toBe(true)
  })

  const base = ticketOf()
  it.each([
    ['an unknown status kind', { ...base, status: { kind: 'sleeping' } }],
    ['an unknown queue reason', { ...base, status: { kind: 'queued', reason: 'later', since: NOW } }],
    ['an unknown gate', { ...base, status: { kind: 'waiting-on-you', gate: 'vibes', detail: '' } }],
    ['a negative rev', { ...base, rev: -1 }],
    ['a fractional ticket number', { ...base, ticket: 1.5 }],
    ['a zero pull request number', { ...base, pr: { number: 0, approvedAt: null } }],
    ['a non-ISO timestamp', { ...base, status: { kind: 'queued', reason: 'new', since: 'yesterday' } }],
    ['an unknown mirror outcome kind', { ...base, mirror: { written: [], failure: { at: NOW, outcome: { kind: 'bogus' } } } }],
  ])('rejects %s', (_name, value) => {
    expect(parses(value)).toBe(false)
  })
})
