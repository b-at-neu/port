import { describe, expect, it } from 'vitest'
import { failingDispatches, lastLaunchFailed } from '@/renderer/board/dispatch-failures'
import type { DispatchRecord } from '@/types/dispatch'

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return { agent: 'plan', number: 585, kind: 'issue', trigger: 'ready', state: 'failed', at: '2026-01-01T00:00:00.000Z', detail: 'boom', outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null, ...overrides }
}

describe('failingDispatches', () => {
  it('counts the consecutive failures at the tail of a ticket', () => {
    const result = failingDispatches([record({ at: '2026-01-01T00:00:00.000Z' }), record({ at: '2026-01-01T00:05:00.000Z' }), record({ at: '2026-01-01T00:10:00.000Z' })])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ attempts: 3, record: { at: '2026-01-01T00:10:00.000Z' } })
  })

  it('counts only the failures after the last success', () => {
    const result = failingDispatches([record({ at: '2026-01-01T00:00:00.000Z' }), record({ state: 'ended', at: '2026-01-01T00:05:00.000Z' }), record({ at: '2026-01-01T00:10:00.000Z' })])
    expect(result[0]?.attempts).toBe(1)
  })

  it('clears a failure once a later launch succeeds', () => {
    expect(failingDispatches([record({ at: '2026-01-01T00:00:00.000Z' }), record({ state: 'started', at: '2026-01-01T00:05:00.000Z' })])).toEqual([])
  })

  it('reads records newest-first or oldest-first alike, and breaks a tie by array position', () => {
    const older = record({ state: 'started', at: '2026-01-01T00:00:00.000Z' })
    const newer = record({ at: '2026-01-01T00:05:00.000Z' })
    expect(failingDispatches([newer, older])).toHaveLength(1)
    const tieStarted = record({ state: 'started' })
    expect(failingDispatches([record(), tieStarted])).toEqual([])
    expect(failingDispatches([tieStarted, record()])).toHaveLength(1)
  })

  it('keeps each agent and ticket apart', () => {
    const result = failingDispatches([record({ number: 1 }), record({ number: 2, state: 'ended' }), record({ number: 3, agent: 'impl' })])
    expect(result.map((entry) => entry.record.number)).toEqual([1, 3])
  })
})

describe('lastLaunchFailed', () => {
  it('is the newest record only when it failed', () => {
    const failed = record({ at: '2026-01-01T00:05:00.000Z' })
    expect(lastLaunchFailed([record({ state: 'started', at: '2026-01-01T00:00:00.000Z' }), failed])).toBe(failed)
    expect(lastLaunchFailed([failed, record({ number: 2, state: 'started', at: '2026-01-01T00:10:00.000Z' })])).toBeNull()
    expect(lastLaunchFailed([])).toBeNull()
  })
})
