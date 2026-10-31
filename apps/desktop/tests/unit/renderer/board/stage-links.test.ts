import { describe, expect, it } from 'vitest'
import { operatorJoinedOf } from '@/renderer/board/stage-links'
import type { DispatchRecord } from '@/types/dispatch'
import type { SessionKey } from '@/types/hosting'

function record(patch: Partial<DispatchRecord>): DispatchRecord {
  return {
    agent: 'impl',
    number: 52,
    kind: 'pull-request',
    trigger: 'readyForReview',
    state: 'started',
    at: '2026-01-01T00:00:00.000Z',
    detail: null,
    outcome: null,
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: null,
    operatorJoinedAt: null,
    ...patch,
  }
}

const PR = [{ number: 52, kind: 'pull-request' as const }]

describe('operatorJoinedOf', () => {
  it('is true when any matching record has an operator join', () => {
    expect(operatorJoinedOf([record({ operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], PR)).toBe(true)
  })

  it('is false when no matching record has one', () => {
    expect(operatorJoinedOf([record({})], PR)).toBe(false)
  })

  it('ignores records for a different number or kind', () => {
    expect(operatorJoinedOf([record({ number: 53, operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], PR)).toBe(false)
    expect(operatorJoinedOf([record({ kind: 'issue', operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], PR)).toBe(false)
  })

  it("is true when a join sits on the ticket's other number", () => {
    const targets = [
      { number: 46, kind: 'issue' as const },
      { number: 52, kind: 'pull-request' as const },
    ]
    expect(operatorJoinedOf([record({ number: 46, kind: 'issue', operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], targets)).toBe(true)
  })
})
