import { describe, expect, it } from 'vitest'
import { LABEL_KEYS, type LabelKey } from '@/utils/labels/vocabulary'
import { V1_KEY_MEANING, ticketSchema, type Status } from '@/utils/pipeline/ticket'
import { NOW, ticketOf } from '../../../support/tickets'

const parses = (value: unknown) => ticketSchema.safeParse(value).success

describe('V1_KEY_MEANING', () => {
  it.each([
    ['ready', 'plan', 'queued', 'new'],
    ['planChangesRequested', 'plan', 'queued', 'changes-requested'],
    ['planning', 'plan', 'running', undefined],
    ['planReview', 'plan', 'waiting-on-you', 'plan-approval'],
    ['planApproved', 'implement', 'queued', 'new'],
    ['inProgress', 'implement', 'running', undefined],
    ['blocked', 'implement', 'blocked', undefined],
    ['readyForReview', 'review', 'queued', 'new'],
    ['reviewing', 'review', 'running', undefined],
    ['needsRevision', 'revise', 'queued', 'changes-requested'],
    ['revising', 'revise', 'running', undefined],
    ['refreshBranch', 'refresh', 'queued', 'new'],
    ['refreshing', 'refresh', 'running', undefined],
    ['approved', 'merge', 'waiting-on-you', 'merge'],
  ] as const)('%s maps to %s / %s %s', (key, stage, status, discriminator) => {
    const meaning = V1_KEY_MEANING[key as LabelKey] as Record<string, unknown>
    expect(meaning).toMatchObject({ kind: 'state', stage, status })
    expect(meaning.reason ?? meaning.gate).toBe(discriminator)
  })

  it.each([
    ['needsHuman', 'escalation'],
    ['prOpened', 'pull-request'],
    ['marker', 'record'],
    ['autoPlan', 'auto-plan'],
  ] as const)('%s is a %s meaning', (key, kind) => {
    expect(V1_KEY_MEANING[key].kind).toBe(kind)
  })

  it('covers every version-1 key', () => {
    expect(Object.keys(V1_KEY_MEANING).sort()).toEqual([...LABEL_KEYS].sort())
  })

  it('gives no two state keys the same pair', () => {
    const pairs = Object.values(V1_KEY_MEANING)
      .filter((m) => m.kind === 'state')
      .map((m) => JSON.stringify([m.stage, m.status, 'reason' in m ? m.reason : null, 'gate' in m ? m.gate : null]))
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})

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
        {
          id: 'run-1',
          stage: 'plan',
          sessionKey: 'key' as never,
          claudeSessionId: 'abc',
          startedAt: NOW,
          endedAt: NOW,
          outcome: 'completed',
          handback: { token: 'plan-ready', arg: null },
          costUsd: 0.5,
          operatorJoinedAt: null,
          failure: null,
          denials: [{ toolName: 'Bash', inputSummary: 'rm', rule: 'deny', at: NOW }],
        },
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
