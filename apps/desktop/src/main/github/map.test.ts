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

  // #108: headRefOid/reviews/comments feed the cycle-cap and zero-diff
  // gates — populated only for a pull request, null for an issue. #265:
  // mergeable feeds the mergeability gate the same way.
  it('a pull request node carries headRefOid, mergeable, reviews, and comments', () => {
    const node = {
      number: 5,
      title: 'PR',
      url: 'u',
      body: '',
      state: 'OPEN',
      mergedAt: null,
      assignees: { nodes: [] },
      labels: { nodes: [] },
      headRefOid: 'sha123',
      mergeable: 'CONFLICTING',
      reviews: { totalCount: 1, nodes: [{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'sha123' } }] },
      comments: { totalCount: 1, nodes: [{ body: '## Gate cleared', createdAt: '2026-01-02T00:00:00Z' }] },
    }
    const aliases = [queriedLabel('readyForReview', 0)]
    const repository = { i0: { totalCount: 0, nodes: [] }, p0: { totalCount: 1, nodes: [node] } }
    const items = mapPipelineItems(repository, aliases, 'r')
    expect(items[0]?.headRefOid).toBe('sha123')
    expect(items[0]?.mergeable).toBe('CONFLICTING')
    expect(items[0]?.reviews).toEqual([{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha123' }])
    expect(items[0]?.comments).toEqual([{ body: '## Gate cleared', createdAt: '2026-01-02T00:00:00Z' }])
  })

  it('an unrecognized mergeable value maps to null, never guessed', () => {
    const node = {
      number: 5,
      title: 'PR',
      url: 'u',
      body: '',
      state: 'OPEN',
      mergedAt: null,
      assignees: { nodes: [] },
      labels: { nodes: [] },
      mergeable: 'something-new',
    }
    const aliases = [queriedLabel('readyForReview', 0)]
    const repository = { i0: { totalCount: 0, nodes: [] }, p0: { totalCount: 1, nodes: [node] } }
    const items = mapPipelineItems(repository, aliases, 'r')
    expect(items[0]?.mergeable).toBeNull()
  })

  it('an issue node carries null for headRefOid, mergeable, reviews, and comments — only a pull request has them', () => {
    const node = { number: 1, title: 'T', url: 'u', body: '', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [] } }
    const aliases = [queriedLabel('ready', 0)]
    const repository = { i0: { totalCount: 1, nodes: [node] }, p0: { totalCount: 0, nodes: [] } }
    const items = mapPipelineItems(repository, aliases, 'r')
    expect(items[0]?.headRefOid).toBeNull()
    expect(items[0]?.mergeable).toBeNull()
    expect(items[0]?.reviews).toBeNull()
    expect(items[0]?.comments).toBeNull()
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
