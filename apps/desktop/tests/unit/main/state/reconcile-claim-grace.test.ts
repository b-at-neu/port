import { describe, expect, it } from 'vitest'
import { agent, item, reconcile, sessionsOf } from './reconcile-fixtures'

describe('reconcileRepository — claim scan grace', () => {
  const claimed = [{ label: 'in progress', actor: 'op', at: '2026-01-01T00:00:00Z' }]

  it('no claimant, scan 5s after the label → in-flight/awaiting-scan', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'], labelEvents: claimed })], { repoSessions: sessionsOf({ freshness: { at: '2026-01-01T00:00:05Z' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('awaiting-scan')
  })

  it('no claimant, scan 20s after the label → stalled/no-claimant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'], labelEvents: claimed })], { repoSessions: sessionsOf({ freshness: { at: '2026-01-01T00:00:20Z' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })

  it('no claimant, no label event → stalled/no-claimant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ freshness: { at: '2026-01-01T00:00:05Z' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })

  it('dormant attached agent, scan 5s after the label → stalled/all-dormant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'], labelEvents: claimed })], {
      repoSessions: sessionsOf({ agents: [agent({ activity: 'dormant' })], freshness: { at: '2026-01-01T00:00:05Z' } }),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('all-dormant')
  })

  it('sessions unavailable → in-flight/sessions-unavailable', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'], labelEvents: claimed })], { repoSessions: sessionsOf({ available: false, freshness: { unavailable: 'x' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.statusEvidence).toBe('sessions-unavailable')
  })
})
