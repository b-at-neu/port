import { describe, expect, it } from 'vitest'
import type { BacklogLabel, BacklogLabelFilter } from '@/types/backlog'
import { EMPTY_FILTER, activeCount, applyLabelFilter, cycleLabel, labelOptionsOf, labelStateOf } from '@/renderer/backlog/filter'

function item(...names: string[]): { labels: BacklogLabel[] } {
  return { labels: names.map((name) => ({ name, color: null })) }
}

describe('cycleLabel and labelStateOf', () => {
  it.each([
    [EMPTY_FILTER, { include: ['bug'], exclude: [] }, 'any'],
    [{ include: ['bug'], exclude: [] }, { include: [], exclude: ['bug'] }, 'only'],
    [{ include: [], exclude: ['bug'] }, EMPTY_FILTER, 'hidden'],
    [{ include: ['bug', 'docs'], exclude: ['epic'] }, { include: ['docs'], exclude: ['epic', 'bug'] }, 'only'],
  ] as [BacklogLabelFilter, BacklogLabelFilter, string][])('cycles %j to %j from %s', (before, after, state) => {
    expect(labelStateOf(before, 'bug')).toBe(state)
    expect(cycleLabel(before, 'bug')).toEqual(after)
  })

  it('reads hidden before only', () => {
    expect(labelStateOf({ include: ['bug'], exclude: ['bug'] }, 'bug')).toBe('hidden')
  })
})

describe('applyLabelFilter', () => {
  const items = [item('bug'), item('epic'), item('bug', 'epic'), item()]

  it.each([
    ['everything for the empty filter', EMPTY_FILTER, [0, 1, 2, 3]],
    ['exclude winning over include', { include: ['bug'], exclude: ['epic'] }, [0]],
    ['several includes as OR', { include: ['bug', 'epic'], exclude: [] }, [0, 1, 2]],
    ['unlabelled items when only excluding', { include: [], exclude: ['epic'] }, [0, 3]],
  ])('keeps %s', (_name, filter, kept) => {
    expect(applyLabelFilter(items, filter)).toEqual(kept.map((i) => items[i]))
  })
})

describe('labelOptionsOf and activeCount', () => {
  it('counts across items sorted case-insensitively, and keeps a filtered name nothing carries at 0', () => {
    const options = labelOptionsOf([item('zeta', 'Alpha'), item('alpha2', 'zeta')], { include: [], exclude: ['gone'] })
    expect(options.map((option) => [option.label.name, option.count, option.state])).toEqual([
      ['Alpha', 1, 'any'],
      ['alpha2', 1, 'any'],
      ['gone', 0, 'hidden'],
      ['zeta', 2, 'any'],
    ])
    expect(activeCount({ include: ['a'], exclude: ['b', 'c'] })).toBe(3)
  })
})
