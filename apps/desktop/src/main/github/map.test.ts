import { describe, expect, it } from 'vitest'
import { applyItemStates, mapPipelineItems } from './map'
import type { QueriedLabel } from '../../shared/github/types'

function queriedLabel(key: QueriedLabel['key'], idx: number): QueriedLabel {
  return { key, name: key, source: 'default', issueAlias: `i${idx}`, prAlias: `p${idx}` }
}

describe('mapPipelineItems', () => {
  it('an item returned by three aliases appears once, with the union of three matchedKeys', () => {
    const node = { number: 76, title: 'T', url: 'https://x', body: 'B', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [] } }
    const aliases = [queriedLabel('ready', 0), queriedLabel('planApproved', 1), queriedLabel('inProgress', 2)]
    const repository = {
      i0: { totalCount: 1, nodes: [node] },
      p0: { totalCount: 0, nodes: [] },
      i1: { totalCount: 1, nodes: [node] },
      p1: { totalCount: 0, nodes: [] },
      i2: { totalCount: 1, nodes: [node] },
      p2: { totalCount: 0, nodes: [] },
    }
    const items = mapPipelineItems(repository, aliases, 'b-at-neu/port')
    expect(items).toHaveLength(1)
    expect([...(items[0]?.matchedKeys ?? [])].sort()).toEqual(['inProgress', 'planApproved', 'ready'].sort())
  })

  it('an item with no assignees maps to assignees: [] and is kept', () => {
    const node = { number: 1, title: 'T', url: 'u', body: '', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [] } }
    const aliases = [queriedLabel('ready', 0)]
    const repository = { i0: { totalCount: 1, nodes: [node] }, p0: { totalCount: 0, nodes: [] } }
    const items = mapPipelineItems(repository, aliases, 'r')
    expect(items).toHaveLength(1)
    expect(items[0]?.assignees).toEqual([])
  })

  it('an item carrying a non-pipeline label keeps it in labels but not matchedKeys', () => {
    const node = {
      number: 1,
      title: 'T',
      url: 'u',
      body: '',
      state: 'OPEN',
      assignees: { nodes: [] },
      labels: { nodes: [{ name: 'ready' }, { name: 'bug' }] },
    }
    const aliases = [queriedLabel('ready', 0)]
    const repository = { i0: { totalCount: 1, nodes: [node] }, p0: { totalCount: 0, nodes: [] } }
    const items = mapPipelineItems(repository, aliases, 'r')
    expect(items[0]?.labels).toEqual(['ready', 'bug'])
    expect(items[0]?.matchedKeys).toEqual(['ready'])
  })

  it('maps a pull request node, carrying mergedAt', () => {
    const node = { number: 5, title: 'PR', url: 'u', body: '', state: 'OPEN', mergedAt: null, assignees: { nodes: [] }, labels: { nodes: [] } }
    const aliases = [queriedLabel('readyForReview', 0)]
    const repository = { i0: { totalCount: 0, nodes: [] }, p0: { totalCount: 1, nodes: [node] } }
    const items = mapPipelineItems(repository, aliases, 'r')
    expect(items[0]?.kind).toBe('pull-request')
    expect(items[0]?.mergedAt).toBeNull()
  })

  it('returns an empty list when no alias yields a connection', () => {
    expect(mapPipelineItems({}, [queriedLabel('ready', 0)], 'r')).toEqual([])
  })
})

describe('applyItemStates', () => {
  it('mergedAt is null on the open sweep and populated from a fetchItemStates node', () => {
    const node = { number: 5, title: 'PR', url: 'u', body: '', state: 'OPEN', mergedAt: null, assignees: { nodes: [] }, labels: { nodes: [] } }
    const items = mapPipelineItems({ i0: { totalCount: 0, nodes: [] }, p0: { totalCount: 1, nodes: [node] } }, [queriedLabel('readyForReview', 0)], 'r')
    expect(items[0]?.mergedAt).toBeNull()

    const updated = applyItemStates(items, [{ kind: 'pull-request', number: 5, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', closedAt: '2026-01-01T00:00:00Z', url: 'u' }])
    expect(updated[0]?.mergedAt).toBe('2026-01-01T00:00:00Z')
    expect(updated[0]?.state).toBe('MERGED')
  })

  it('leaves an item unchanged when no matching state was returned', () => {
    const items = mapPipelineItems(
      { i0: { totalCount: 1, nodes: [{ number: 1, title: '', url: '', body: '', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [] } }] }, p0: { totalCount: 0, nodes: [] } },
      [queriedLabel('ready', 0)],
      'r',
    )
    expect(applyItemStates(items, [])).toEqual(items)
  })
})
