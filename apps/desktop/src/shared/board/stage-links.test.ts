import { describe, expect, it } from 'vitest'
import { operatorJoinedOf, stageLinksFor } from './stage-links'
import type { DispatchRecord } from '../dispatch/types'
import type { SessionKey } from '../hosting/types'

function record(patch: Partial<DispatchRecord>): DispatchRecord {
  return {
    agent: 'impl',
    number: 52,
    kind: 'pull-request',
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

describe('stageLinksFor', () => {
  it('resolves a started record with a sessionKey as live', () => {
    const links = stageLinksFor([record({})], 52, 'pull-request')
    expect(links).toEqual([{ kind: 'live', agent: 'impl', sessionKey: 'hosted-1', at: '2026-01-01T00:00:00.000Z', operatorJoined: false }])
  })

  it('resolves an ended record with a claudeSessionId as a transcript', () => {
    const links = stageLinksFor([record({ state: 'ended', claudeSessionId: 'sess-1' })], 52, 'pull-request')
    expect(links).toEqual([{ kind: 'transcript', agent: 'impl', sessionId: 'sess-1', at: '2026-01-01T00:00:00.000Z', operatorJoined: false }])
  })

  it('skips a failed record', () => {
    expect(stageLinksFor([record({ state: 'failed', sessionKey: null })], 52, 'pull-request')).toEqual([])
  })

  it('skips an ended record with no claudeSessionId — it died before init', () => {
    expect(stageLinksFor([record({ state: 'ended', claudeSessionId: null })], 52, 'pull-request')).toEqual([])
  })

  it('resolves only the newest of two started records as live, the older as if ended', () => {
    const older = record({ at: '2026-01-01T00:00:00.000Z', sessionKey: 'hosted-1' as SessionKey, claudeSessionId: 'sess-old' })
    const newer = record({ at: '2026-01-01T01:00:00.000Z', sessionKey: 'hosted-2' as SessionKey, claudeSessionId: 'sess-new' })
    const links = stageLinksFor([older, newer], 52, 'pull-request')
    expect(links).toEqual([
      { kind: 'live', agent: 'impl', sessionKey: 'hosted-2', at: '2026-01-01T01:00:00.000Z', operatorJoined: false },
      { kind: 'transcript', agent: 'impl', sessionId: 'sess-old', at: '2026-01-01T00:00:00.000Z', operatorJoined: false },
    ])
  })

  it('orders links newest first', () => {
    const plan = record({ agent: 'plan', state: 'ended', claudeSessionId: 'sess-plan', at: '2026-01-01T00:00:00.000Z' })
    const impl = record({ agent: 'impl', state: 'started', sessionKey: 'hosted-9' as SessionKey, at: '2026-01-02T00:00:00.000Z' })
    const links = stageLinksFor([plan, impl], 52, 'pull-request')
    expect(links.map((l) => l.agent)).toEqual(['impl', 'plan'])
  })

  it('reports operatorJoined from the matching record', () => {
    const links = stageLinksFor([record({ operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], 52, 'pull-request')
    expect(links[0]?.operatorJoined).toBe(true)
  })

  it('ignores records for a different number or kind', () => {
    expect(stageLinksFor([record({ number: 53 })], 52, 'pull-request')).toEqual([])
    expect(stageLinksFor([record({ kind: 'issue' })], 52, 'pull-request')).toEqual([])
  })
})

describe('operatorJoinedOf', () => {
  it('is true when any matching record has an operator join', () => {
    expect(operatorJoinedOf([record({ operatorJoinedAt: '2026-01-01T00:05:00.000Z' })], 52, 'pull-request')).toBe(true)
  })

  it('is false when no matching record has one', () => {
    expect(operatorJoinedOf([record({})], 52, 'pull-request')).toBe(false)
  })
})
