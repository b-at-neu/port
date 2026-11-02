import { describe, expect, it } from 'vitest'
import type { NeedsYouItem } from '@/types/board'
import { groupNeedsYou } from '@/renderer/needs-you/groups'

const KINDS: readonly NeedsYouItem['kind'][] = [
  'plan-review',
  'ready-to-merge',
  'needs-human',
  'budget',
  'held',
  'stalled',
  'stage-question',
  'stage-questions',
  'stage-approval',
  'stage-denial',
  'stage-interrupted',
  'usage-limit',
  'half-labelled',
  'dispatch-failed',
]

function item(kind: NeedsYouItem['kind'], number: number): NeedsYouItem {
  return { kind, repoId: null, repo: null, number, title: null, url: null, ticket: null, at: null, matchedRow: null } as unknown as NeedsYouItem
}

describe('groupNeedsYou', () => {
  it('gives every kind a group', () => {
    const groups = groupNeedsYou(KINDS.map((kind, index) => item(kind, index)))
    expect(groups.flatMap((g) => g.items)).toHaveLength(KINDS.length)
  })

  it('names the groups the way the screen shows them', () => {
    const groups = groupNeedsYou(KINDS.map((kind, index) => item(kind, index)))
    expect(groups.map((g) => g.name)).toEqual(['Plan reviews', 'Ready to merge', 'Escalated', 'Over budget', 'Held', 'Stalled', 'Questions', 'Edit approvals', 'Denied commands', 'Interrupted', 'Usage limit', 'Label problems', 'Launch failures'])
  })

  it('shares one Questions group between a live question and a questions hand-back', () => {
    const groups = groupNeedsYou([item('stage-question', 1), item('stage-questions', 2)])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Questions')
  })

  it('collects protected-edit approvals in their own Edit approvals group', () => {
    const groups = groupNeedsYou([item('stage-approval', 1), item('stage-question', 2), item('stage-approval', 3)])
    expect(groups.map((g) => [g.key, g.name, g.items.map((i) => i.number)])).toEqual([
      ['approvals', 'Edit approvals', [1, 3]],
      ['questions', 'Questions', [2]],
    ])
  })

  it('orders groups by their first item and keeps each group’s own order', () => {
    const groups = groupNeedsYou([item('held', 1), item('plan-review', 2), item('held', 3), item('plan-review', 4)])
    expect(groups.map((g) => [g.key, g.items.map((i) => i.number)])).toEqual([
      ['held', [1, 3]],
      ['plan-review', [2, 4]],
    ])
  })

  it('returns no groups for no items', () => {
    expect(groupNeedsYou([])).toEqual([])
  })
})
