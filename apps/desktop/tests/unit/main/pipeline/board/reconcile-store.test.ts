import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '@/main/pipeline/board/reconcile'
import type { PipelineView, TrackedItem } from '@/types/pipeline-state'
import { ticketAt } from '../../../../support/tickets'
import { denialsOf, entry, fetchOf, item, sessionsOf, worktreesOf } from './reconcile-fixtures'

function stored(overrides: Partial<TrackedItem> = {}): TrackedItem {
  const ticket = ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }, { ticket: overrides.number ?? 79 })
  return { kind: 'issue', number: 79, ticket, ...overrides }
}

function reconcile(items: Parameters<typeof fetchOf>[0], view: PipelineView | undefined) {
  const state = reconcileRepository({ entry: entry(), pipelineFetch: fetchOf(items), itemsByNumberFetch: null, repoSessions: sessionsOf(), worktrees: worktreesOf(), denials: denialsOf(), view })
  if (!state.ok) throw new Error('expected an ok repository state')
  return state
}

describe('reconcileRepository — store view', () => {
  it('reads the ticket and its gate from the store, whatever labels GitHub shows', () => {
    const state = reconcile([item({ labels: [], matchedKeys: [] })], { kind: 'store', items: [stored()] })
    expect(state.items[0]).toMatchObject({ status: 'gated', ticket: { stage: 'plan', status: { kind: 'waiting-on-you', gate: 'plan-approval' } } })
  })

  it('drops an item the store does not track', () => {
    const state = reconcile([item({ number: 79 }), item({ number: 80 })], { kind: 'store', items: [stored({ number: 80 })] })
    expect(state.items.map((i) => i.number)).toEqual([80])
  })

  it('takes the larger of the stored review count and the reviews GitHub shows, so the cap only holds earlier', () => {
    const pr = item({ kind: 'pull-request', number: 5, reviews: [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: 't', commitOid: null }], comments: [] })
    const withCycles = (reviewCycles: number): TrackedItem => ({ kind: 'pull-request', number: 5, ticket: ticketAt('review', { kind: 'queued', reason: 'new', since: 't' }, { ticket: 5, reviewCycles }) })
    const high = reconcile([pr], { kind: 'store', items: [withCycles(4)] })
    const low = reconcile([pr], { kind: 'store', items: [withCycles(0)] })
    expect(high.items[0]?.reviewCycleCount).toBe(4)
    expect(low.items[0]?.reviewCycleCount).toBe(1)
  })

  it('copies the stored mirror failure onto the item, and sets nothing for an unseeded view', () => {
    const mirrorFailure = { at: '2026-01-01T00:00:00Z', outcome: { kind: 'item-unavailable' as const } }
    const base = stored()
    const failed: TrackedItem = { ...base, ticket: { ...base.ticket, mirror: { written: [], failure: mirrorFailure } } }
    expect(reconcile([item()], { kind: 'store', items: [failed] }).items[0]?.mirrorFailure).toEqual(mirrorFailure)
    expect(reconcile([item()], { kind: 'store', items: [stored()] }).items[0]?.mirrorFailure).toBeNull()
    expect(reconcile([item()], { kind: 'unseeded' }).items[0]).not.toHaveProperty('mirrorFailure')
  })

  it('seeds the ticket from the display labels for an unseeded view or no view', () => {
    const running = item({ labels: ['port', 'implementing'], matchedKeys: ['port', 'implementing'] })
    expect(reconcile([running], { kind: 'unseeded' }).items[0]?.ticket).toMatchObject({ stage: 'implement', status: { kind: 'running' } })
    expect(reconcile([running], undefined).items[0]?.ticket).toMatchObject({ stage: 'implement', status: { kind: 'running' } })
  })
})
