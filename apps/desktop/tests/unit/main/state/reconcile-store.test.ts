import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '@/main/state/reconcile'
import type { PipelineView, StoredItem } from '@/types/pipeline-state'
import { denialsOf, entry, fetchOf, item, sessionsOf, worktreesOf } from './reconcile-fixtures'

function stored(overrides: Partial<StoredItem> = {}): StoredItem {
  return { kind: 'issue', number: 79, keys: ['planReview'], marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: 't', issue: null, mirrorFailure: null, ...overrides }
}

function reconcile(items: Parameters<typeof fetchOf>[0], view: PipelineView | undefined) {
  const state = reconcileRepository({ entry: entry(), pipelineFetch: fetchOf(items), itemsByNumberFetch: null, repoSessions: sessionsOf(), worktrees: worktreesOf(), denials: denialsOf(), view })
  if (!state.ok) throw new Error('expected an ok repository state')
  return state
}

describe('reconcileRepository — store view', () => {
  it('reads stage from the store, whatever labels GitHub shows', () => {
    const state = reconcile([item({ labels: [], matchedKeys: ['ready'] })], { kind: 'store', items: [stored()] })
    expect(state.items[0]).toMatchObject({ stage: 'gate', matchedKeys: ['marker', 'planReview'], marked: true })
  })

  it('keeps a ticket at its stored stage when every label was removed on GitHub', () => {
    const state = reconcile([item({ labels: [], matchedKeys: [] })], { kind: 'store', items: [stored()] })
    expect(state.items[0]?.stage).toBe('gate')
  })

  it('drops an item the store does not track', () => {
    const state = reconcile([item({ number: 79 }), item({ number: 80 })], { kind: 'store', items: [stored({ number: 80 })] })
    expect(state.items.map((i) => i.number)).toEqual([80])
  })

  it('builds the stage history from the stored rows, so claimedAt and the blocked comment source read the store', () => {
    const history = [
      { at: '2026-01-02T00:00:00Z', action: 'stage-claim', add: ['inProgress' as const], remove: ['planApproved' as const], actor: 'op' },
      { at: '2026-01-01T00:00:00Z', action: 'seed', add: ['marker' as const, 'planApproved' as const], remove: [], actor: 'op' },
    ]
    const state = reconcile([item({ labels: [], matchedKeys: [] })], { kind: 'store', items: [stored({ keys: ['inProgress'], history })] })
    expect(state.items[0]?.stageHistory).toEqual([
      { key: 'planApproved', actor: 'op', at: '2026-01-01T00:00:00Z' },
      { key: 'inProgress', actor: 'op', at: '2026-01-02T00:00:00Z' },
    ])
  })

  it('takes the larger of the stored review count and the reviews GitHub shows, so the cap only holds earlier', () => {
    const pr = item({ kind: 'pull-request', number: 5, reviews: [{ body: '## Code Review — Cycle 1 · needs revision', submittedAt: 't', commitOid: null }], comments: [] })
    const high = reconcile([pr], { kind: 'store', items: [stored({ kind: 'pull-request', number: 5, keys: ['readyForReview'], reviewCycles: 4 })] })
    const low = reconcile([pr], { kind: 'store', items: [stored({ kind: 'pull-request', number: 5, keys: ['readyForReview'], reviewCycles: 0 })] })
    expect(high.items[0]?.reviewCycleCount).toBe(4)
    expect(low.items[0]?.reviewCycleCount).toBe(1)
  })

  it('copies the stored mirror failure onto the item, and sets nothing for an unseeded view', () => {
    const mirrorFailure = { at: '2026-01-01T00:00:00Z', outcome: { kind: 'item-unavailable' as const } }
    expect(reconcile([item()], { kind: 'store', items: [stored({ mirrorFailure })] }).items[0]?.mirrorFailure).toEqual(mirrorFailure)
    expect(reconcile([item()], { kind: 'store', items: [stored()] }).items[0]?.mirrorFailure).toBeNull()
    expect(reconcile([item()], { kind: 'unseeded' }).items[0]).not.toHaveProperty('mirrorFailure')
  })

  it('reads the matched keys from GitHub for an unseeded view or no view, the seed read', () => {
    const labelled = item({ labels: ['ready'], matchedKeys: ['ready'] })
    expect(reconcile([labelled], { kind: 'unseeded' }).items[0]?.matchedKeys).toEqual(['ready'])
    expect(reconcile([labelled], undefined).items[0]?.matchedKeys).toEqual(['ready'])
  })
})
