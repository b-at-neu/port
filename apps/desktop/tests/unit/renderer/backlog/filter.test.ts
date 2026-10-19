import { describe, expect, it } from 'vitest'
import type { BacklogLabel } from '@/types/backlog'
import { EMPTY_FILTER, activeCount, applyLabelFilter, cycleLabel, labelOptionsOf, labelStateOf } from '@/renderer/backlog/filter'

function item(...names: string[]): { labels: BacklogLabel[] } {
  return { labels: names.map((name) => ({ name, color: null })) }
}

describe('cycleLabel', () => {
  it('goes any → only → hidden → any', () => {
    const only = cycleLabel(EMPTY_FILTER, 'bug')
    expect(only).toEqual({ include: ['bug'], exclude: [] })
    const hidden = cycleLabel(only, 'bug')
    expect(hidden).toEqual({ include: [], exclude: ['bug'] })
    expect(cycleLabel(hidden, 'bug')).toEqual(EMPTY_FILTER)
  })

  it('never leaves a name in both lists and leaves other names alone', () => {
    const filter = cycleLabel({ include: ['bug', 'docs'], exclude: ['epic'] }, 'bug')
    expect(filter).toEqual({ include: ['docs'], exclude: ['epic', 'bug'] })
  })
})

describe('labelStateOf', () => {
  it('reads hidden before only', () => {
    expect(labelStateOf({ include: ['a'], exclude: ['a'] }, 'a')).toBe('hidden')
    expect(labelStateOf({ include: ['a'], exclude: [] }, 'a')).toBe('only')
    expect(labelStateOf(EMPTY_FILTER, 'a')).toBe('any')
  })
})

describe('applyLabelFilter', () => {
  const items = [item('bug'), item('epic'), item('bug', 'epic'), item()]

  it('keeps everything for the empty filter', () => {
    expect(applyLabelFilter(items, EMPTY_FILTER)).toHaveLength(4)
  })

  it('lets exclude win over include', () => {
    expect(applyLabelFilter(items, { include: ['bug'], exclude: ['epic'] })).toEqual([items[0]])
  })

  it('treats several includes as OR', () => {
    expect(applyLabelFilter(items, { include: ['bug', 'epic'], exclude: [] })).toEqual([items[0], items[1], items[2]])
  })

  it('keeps unlabelled items when only excluding', () => {
    expect(applyLabelFilter(items, { include: [], exclude: ['epic'] })).toEqual([items[0], items[3]])
  })
})

describe('labelOptionsOf', () => {
  it('counts across the items, sorted case-insensitively', () => {
    const options = labelOptionsOf([item('zeta', 'Alpha'), item('alpha2', 'zeta')], EMPTY_FILTER)
    expect(options.map((option) => [option.label.name, option.count])).toEqual([
      ['Alpha', 1],
      ['alpha2', 1],
      ['zeta', 2],
    ])
  })

  it('keeps a filtered name no item carries, at count 0, so it can be cleared', () => {
    const options = labelOptionsOf([item('bug')], { include: [], exclude: ['gone'] })
    expect(options.find((option) => option.label.name === 'gone')).toEqual({ label: { name: 'gone', color: null }, count: 0, state: 'hidden' })
  })
})

describe('activeCount', () => {
  it('sums both lists', () => {
    expect(activeCount({ include: ['a'], exclude: ['b', 'c'] })).toBe(3)
  })
})
