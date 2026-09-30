import { describe, expect, it } from 'vitest'
import { composeReply } from './compose'
import type { RelayPending } from './types'

const base = {
  repoId: 'r' as RelayPending['repoId'],
  number: 107,
  stage: 'plan-agent' as const,
  sessionId: 's1',
  agentId: null,
  parentSessionLabel: 'cockpit session',
  agentLabel: 'plan-agent #107',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
}

describe('composeReply — questions', () => {
  const pending: RelayPending = {
    ...base,
    kind: 'questions',
    questions: [
      { index: 0, text: 'Which branch is base?' },
      { index: 1, text: 'Should I rename the file?' },
    ],
  }

  it('composes numbered answers in order', () => {
    expect(composeReply(pending, ['dev', 'yes'])).toBe(['Answers for #107 (plan-agent):', '1. dev', '2. yes'].join('\n'))
  })

  it('returns null when any answer is blank', () => {
    expect(composeReply(pending, ['dev', '   '])).toBeNull()
  })

  it('returns null when the answer count does not match the question count', () => {
    expect(composeReply(pending, ['dev'])).toBeNull()
  })

  it('falls back to "this item" when the number could not be resolved', () => {
    const noNumber: RelayPending = { ...pending, number: null }
    expect(composeReply(noNumber, ['dev', 'yes'])).toBe(['Answers for this item (plan-agent):', '1. dev', '2. yes'].join('\n'))
  })
})

describe('composeReply — blocked', () => {
  const pending: RelayPending = { ...base, kind: 'blocked', request: 'the ci token is missing' }

  it('composes the decision', () => {
    expect(composeReply(pending, ['rotate it and retry'])).toBe(['Decision on the blocker for #107 (plan-agent):', 'rotate it and retry'].join('\n'))
  })

  it('returns null on a blank decision', () => {
    expect(composeReply(pending, ['  '])).toBeNull()
  })
})

describe('composeReply — usage-limit', () => {
  it('never composes a reply', () => {
    const pending: RelayPending = { ...base, kind: 'usage-limit' }
    expect(composeReply(pending, ['anything'])).toBeNull()
  })
})
