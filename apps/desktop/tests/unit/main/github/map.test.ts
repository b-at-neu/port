import { describe, expect, it } from 'vitest'
import { applyItemDetails, applyItemStates, mapPipelineItems } from '@/main/github/map'
import { resolveVocabulary } from '@/utils/labels/vocabulary'

const VOCABULARY = resolveVocabulary({})

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 1, title: 'T', url: 'u', body: '', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: [{ name: 'ready' }] }, ...overrides }
}

function pullNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 5, title: 'PR', url: 'u', body: '', state: 'OPEN', mergedAt: null, assignees: { nodes: [] }, labels: { nodes: [{ name: 'ready for review' }] }, ...overrides }
}

function mapIssues(nodes: readonly unknown[]): ReturnType<typeof mapPipelineItems> {
  return mapPipelineItems(nodes, 'issue', VOCABULARY, 'r')
}

function mapPulls(nodes: readonly unknown[]): ReturnType<typeof mapPipelineItems> {
  return mapPipelineItems(nodes, 'pull-request', VOCABULARY, 'r')
}

describe('mapPipelineItems', () => {
  it('buckets an item carrying three vocabulary labels into three matchedKeys, in vocabulary order', () => {
    const items = mapIssues([issueNode({ number: 76, labels: { nodes: [{ name: 'in progress' }, { name: 'plan approved' }, { name: 'ready' }] } })])
    expect(items).toHaveLength(1)
    const order = VOCABULARY.labels.map((label) => label.key)
    const expected = order.filter((key) => ['inProgress', 'planApproved', 'ready'].includes(key))
    expect(items[0]?.matchedKeys).toEqual(expected)
    expect(items[0]?.matchedKeys).toHaveLength(3)
  })

  it('matches a label name case-insensitively, the way GitHub filters', () => {
    const items = mapIssues([issueNode({ labels: { nodes: [{ name: 'READY' }] } })])
    expect(items[0]?.matchedKeys).toEqual(['ready'])
    expect(items[0]?.labels).toEqual(['READY'])
  })

  it('an item carrying a non-pipeline label keeps it in labels but not matchedKeys', () => {
    const items = mapIssues([issueNode({ labels: { nodes: [{ name: 'ready' }, { name: 'bug' }] } })])
    expect(items[0]?.labels).toEqual(['ready', 'bug'])
    expect(items[0]?.matchedKeys).toEqual(['ready'])
  })

  it('drops a node matching no vocabulary label', () => {
    expect(mapIssues([issueNode({ labels: { nodes: [{ name: 'bug' }] } })])).toEqual([])
  })

  it('an item with no assignees maps to assignees: [] and is kept', () => {
    const items = mapIssues([issueNode()])
    expect(items).toHaveLength(1)
    expect(items[0]?.assignees).toEqual([])
  })

  it('keeps an item that appears on two pages once', () => {
    expect(mapIssues([issueNode(), issueNode()])).toHaveLength(1)
  })

  it('maps a pull request node, carrying mergedAt', () => {
    const items = mapPulls([pullNode()])
    expect(items[0]?.kind).toBe('pull-request')
    expect(items[0]?.mergedAt).toBeNull()
  })

  it('returns an empty list for no nodes', () => {
    expect(mapIssues([])).toEqual([])
  })

  it('a pull request node carries headRefOid and mergeable from the sweep', () => {
    const items = mapPulls([pullNode({ headRefOid: 'sha123', mergeable: 'CONFLICTING' })])
    expect(items[0]?.headRefOid).toBe('sha123')
    expect(items[0]?.mergeable).toBe('CONFLICTING')
  })

  it('an unrecognized mergeable value maps to null, never guessed', () => {
    expect(mapPulls([pullNode({ mergeable: 'something-new' })])[0]?.mergeable).toBeNull()
  })

  it('an issue node carries null for headRefOid, mergeable, reviews, and comments — only a pull request has them', () => {
    const items = mapIssues([issueNode()])
    expect(items[0]?.headRefOid).toBeNull()
    expect(items[0]?.mergeable).toBeNull()
    expect(items[0]?.reviews).toBeNull()
    expect(items[0]?.comments).toBeNull()
  })

  it('carries updatedAt and null when missing or non-string', () => {
    const items = mapIssues([issueNode({ number: 1, updatedAt: '2026-01-01T00:00:00Z' }), issueNode({ number: 2, updatedAt: 123 })])
    expect(items.find((i) => i.number === 1)?.updatedAt).toBe('2026-01-01T00:00:00Z')
    expect(items.find((i) => i.number === 2)?.updatedAt).toBeNull()
  })
})

describe('applyItemDetails', () => {
  it('maps a good labeled-event node, drops a malformed one, and reads a null actor through', () => {
    const node = {
      timelineItems: {
        nodes: [
          { createdAt: '2026-01-01T00:00:00Z', actor: { login: 'octo-dev' }, label: { name: 'ready' } },
          { createdAt: '2026-01-02T00:00:00Z', actor: null, label: { name: 'in progress' } },
          { createdAt: '2026-01-03T00:00:00Z', actor: { login: 'x' } },
          { actor: { login: 'x' }, label: { name: 'ready' } },
        ],
      },
    }
    const items = applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node, erroredFields: [] }])
    expect(items[0]?.labelEvents).toEqual([
      { label: 'ready', actor: 'octo-dev', at: '2026-01-01T00:00:00Z' },
      { label: 'in progress', actor: null, at: '2026-01-02T00:00:00Z' },
    ])
  })

  it('an absent timelineItems connection maps to an empty labelEvents array', () => {
    const items = applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node: {}, erroredFields: [] }])
    expect(items[0]?.labelEvents).toEqual([])
  })

  it('an issue detail maps its open blockers, and drops a closed one', () => {
    const node = { blockedBy: { totalCount: 2, nodes: [{ number: 4, title: 'open one', url: 'u4', state: 'OPEN' }, { number: 5, title: 'done', url: 'u5', state: 'CLOSED' }] } }
    const items = applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node, erroredFields: [] }])
    expect(items[0]?.blockers).toEqual({ ok: true, open: [{ number: 4, title: 'open one', url: 'u4', state: 'OPEN' }], shown: 2, total: 2 })
  })

  it('an errored blockedBy field maps to an unreadable read, never an empty one', () => {
    const items = applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node: { blockedBy: null }, erroredFields: ['blockedBy'] }])
    expect(items[0]?.blockers?.ok).toBe(false)
  })

  it('maps blocker comments when selected, drops a malformed node, and reads null when unselected or errored', () => {
    const comments = { nodes: [{ body: 'why', createdAt: '2026-01-01T00:00:00Z', url: 'https://x/c1' }, { body: 'no url', createdAt: '2026-01-02T00:00:00Z' }] }
    const selected = applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node: { comments }, erroredFields: [] }])
    expect(selected[0]?.blockerComments).toEqual([{ body: 'why', createdAt: '2026-01-01T00:00:00Z', url: 'https://x/c1' }])
    expect(applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node: {}, erroredFields: [] }])[0]?.blockerComments).toBeNull()
    expect(applyItemDetails(mapIssues([issueNode()]), [{ kind: 'issue', number: 1, node: { comments: null }, erroredFields: ['comments'] }])[0]?.blockerComments).toBeNull()
  })

  it('a pull request carries neither blockers nor blocker comments', () => {
    const items = applyItemDetails(mapPulls([pullNode()]), [{ kind: 'pull-request', number: 5, node: {}, erroredFields: [] }])
    expect(items[0]?.blockers).toBeNull()
    expect(items[0]?.blockerComments).toBeNull()
  })

  it('a pull request detail carries reviews and comments, flattening the review commit', () => {
    const node = {
      reviews: { totalCount: 1, nodes: [{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'sha123' } }] },
      comments: { totalCount: 1, nodes: [{ body: '## Gate cleared', createdAt: '2026-01-02T00:00:00Z' }] },
    }
    const items = applyItemDetails(mapPulls([pullNode()]), [{ kind: 'pull-request', number: 5, node, erroredFields: [] }])
    expect(items[0]?.reviews).toEqual([{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha123' }])
    expect(items[0]?.comments).toEqual([{ body: '## Gate cleared', createdAt: '2026-01-02T00:00:00Z' }])
  })

  it('checkRollup is null unless the detail selected commits, and [] when selected but empty', () => {
    const swept = mapPulls([pullNode()])
    expect(applyItemDetails(swept, [{ kind: 'pull-request', number: 5, node: {}, erroredFields: [] }])[0]?.checkRollup).toBeNull()
    expect(applyItemDetails(swept, [{ kind: 'pull-request', number: 5, node: { commits: { nodes: [] } }, erroredFields: [] }])[0]?.checkRollup).toEqual([])
  })

  it('reads a check run and a status context off the rollup', () => {
    const node = {
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: 'FAILURE',
                contexts: {
                  nodes: [
                    { __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE', status: 'COMPLETED', startedAt: 's', completedAt: 'c', detailsUrl: 'https://x/run' },
                    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', createdAt: 'k', targetUrl: 'https://x/status' },
                  ],
                },
              },
            },
          },
        ],
      },
    }
    const checks = applyItemDetails(mapPulls([pullNode()]), [{ kind: 'pull-request', number: 5, node, erroredFields: [] }])[0]?.checkRollup
    expect(checks?.map((check) => [check.name, check.url])).toEqual([
      ['build', 'https://x/run'],
      ['ci/legacy', 'https://x/status'],
    ])
  })

  it('keys by kind and number, so an issue and a pull request sharing no number never cross', () => {
    const items = applyItemDetails([...mapIssues([issueNode({ number: 3 })]), ...mapPulls([pullNode({ number: 4 })])], [
      { kind: 'pull-request', number: 4, node: { comments: { nodes: [{ body: 'b', createdAt: 't' }] } }, erroredFields: [] },
    ])
    expect(items[0]?.comments).toBeNull()
    expect(items[1]?.comments).toEqual([{ body: 'b', createdAt: 't' }])
  })

  it('leaves an item with no detail on its placeholders', () => {
    const swept = mapPulls([pullNode()])
    expect(applyItemDetails(swept, [])).toEqual(swept)
  })
})

describe('applyItemStates', () => {
  it('mergedAt is null on the open sweep and populated from a fetchItemStates node', () => {
    const items = mapPulls([pullNode()])
    expect(items[0]?.mergedAt).toBeNull()

    const updated = applyItemStates(items, [{ kind: 'pull-request', number: 5, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', closedAt: '2026-01-01T00:00:00Z', url: 'u' }])
    expect(updated[0]?.mergedAt).toBe('2026-01-01T00:00:00Z')
    expect(updated[0]?.state).toBe('MERGED')
  })

  it('leaves an item unchanged when no matching state was returned', () => {
    const items = mapIssues([issueNode({ title: '' })])
    expect(applyItemStates(items, [])).toEqual(items)
  })
})
