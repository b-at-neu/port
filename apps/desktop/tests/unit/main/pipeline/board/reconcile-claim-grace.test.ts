import { describe, expect, it } from 'vitest'
import type { PipelineView } from '@/types/pipeline-state'
import { runOf, ticketAt } from '../../../../support/tickets'
import { agent, item, reconcile, sessionsOf } from './reconcile-fixtures'

describe('reconcileRepository — claim scan grace', () => {
  const claimedTicket = ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 79, runs: [runOf({ id: 'run-1', startedAt: '2026-01-01T00:00:00Z' })] })
  const claimed: PipelineView = { kind: 'store', items: [{ kind: 'issue', number: 79, ticket: claimedTicket }] }

  it('no claimant, scan 5s after the run began → in-flight/awaiting-scan', () => {
    const state = reconcile([item()], { view: claimed, repoSessions: sessionsOf({ freshness: { at: '2026-01-01T00:00:05Z' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('awaiting-scan')
  })

  it('no claimant, scan 20s after the run began → stalled/no-claimant', () => {
    const state = reconcile([item()], { view: claimed, repoSessions: sessionsOf({ freshness: { at: '2026-01-01T00:00:20Z' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })

  it('no claimant, no run start on the ticket → stalled/no-claimant', () => {
    const state = reconcile([item({ matchedKeys: ['port', 'implementing'] })], { repoSessions: sessionsOf({ freshness: { at: '2026-01-01T00:00:05Z' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })

  it('dormant attached agent, scan 5s after the run began → stalled/all-dormant', () => {
    const state = reconcile([item()], {
      view: claimed,
      repoSessions: sessionsOf({ agents: [agent({ activity: 'dormant' })], freshness: { at: '2026-01-01T00:00:05Z' } }),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('all-dormant')
  })

  it('sessions unavailable → in-flight/sessions-unavailable', () => {
    const state = reconcile([item()], { view: claimed, repoSessions: sessionsOf({ available: false, freshness: { unavailable: 'x' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.statusEvidence).toBe('sessions-unavailable')
  })
})
