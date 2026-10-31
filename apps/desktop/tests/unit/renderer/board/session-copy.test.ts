import { describe, expect, it } from 'vitest'
import { sessionLinkAccessibleName, sessionLinkMeta, sessionLinkName, yourSessionsLabel } from '@/renderer/board/session-copy'
import type { TicketSessionLink } from '@/types/board'

const NOW = new Date('2026-01-01T12:00:00.000Z')

function link(overrides: Partial<TicketSessionLink>): TicketSessionLink {
  return {
    key: 'k',
    who: { kind: 'stage', agent: 'plan' },
    state: 'ended',
    at: '2026-01-01T09:00:00.000Z',
    endedAt: '2026-01-01T10:00:00.000Z',
    costUsd: 1.18,
    operatorJoined: false,
    title: null,
    open: { kind: 'transcript', sessionId: 's', agentId: null },
    ...overrides,
  }
}

describe('session link copy', () => {
  it('names each agent and the operator', () => {
    expect(sessionLinkName({ kind: 'stage', agent: 'impl' })).toBe('Implement agent')
    expect(sessionLinkName({ kind: 'you' })).toBe('Your session')
    expect(yourSessionsLabel()).toBe('Your sessions')
  })

  it('writes the meta line per state', () => {
    expect(sessionLinkMeta(link({ state: 'live', endedAt: null, at: '2026-01-01T11:48:00.000Z', costUsd: 0.42 }), NOW)).toBe('Live · started 12m ago · $0.42')
    expect(sessionLinkMeta(link({}), NOW)).toBe('Ended 2h ago · $1.18')
    expect(sessionLinkMeta(link({ state: 'started', endedAt: null, at: '2026-01-01T09:00:00.000Z', costUsd: null }), NOW)).toBe('Started 3h ago')
    expect(sessionLinkMeta(link({ state: 'seen', endedAt: null, at: '2026-01-01T10:00:00.000Z', costUsd: null }), NOW)).toBe('Last active 2h ago')
  })

  it('appends you joined and never shows an unknown cost', () => {
    expect(sessionLinkMeta(link({ operatorJoined: true, costUsd: null }), NOW)).toBe('Ended 2h ago · you joined')
  })

  it('builds the accessible name', () => {
    expect(sessionLinkAccessibleName(link({ costUsd: null }), NOW)).toBe('Open Plan agent, Ended 2h ago')
  })
})
