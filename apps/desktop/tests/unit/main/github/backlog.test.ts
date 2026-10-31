import { describe, expect, it } from 'vitest'
import type { GhResult } from '@/types/platform'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { fetchBacklog } from '@/main/github/backlog'
import type { GhRunner } from '@/types/platform'

function fakeRunner(result: GhResult): GhRunner {
  return () => Promise.resolve(result)
}

const VOCABULARY = resolveVocabulary({})
const READY_LABEL = VOCABULARY.labels.find((label) => label.key === 'ready')?.name ?? 'ready'
const NO_BLOCKERS = { totalCount: 0, nodes: [] }

function issueNode(number: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { number, title: `t${String(number)}`, url: `u${String(number)}`, updatedAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] }, ...extra }
}

async function fetchNodes(nodes: readonly Record<string, unknown>[], errors?: readonly unknown[]) {
  const stdout = JSON.stringify({ data: { repository: { issues: { totalCount: nodes.length, nodes } }, viewer: { login: 'octo-dev' } }, ...(errors === undefined ? {} : { errors }) })
  const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
  if (!result.ok) throw new Error('expected an ok read')
  return result
}

describe('fetchBacklog', () => {
  it('resolves every open issue, dropping any carrying a vocabulary label', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount: 2,
            nodes: [
              { number: 47, title: 'Add dark mode', url: 'u47', updatedAt: '2026-01-01T00:00:00Z', labels: { nodes: [] }, assignees: { nodes: [] }, blockedBy: NO_BLOCKERS },
              { number: 45, title: 'Already claimed', url: 'u45', updatedAt: '2026-01-02T00:00:00Z', labels: { nodes: [{ name: READY_LABEL }] }, assignees: { nodes: [{ login: 'alice' }] }, blockedBy: NO_BLOCKERS },
            ],
          },
        },
        viewer: { login: 'octo-dev' },
      },
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([{ number: 47, title: 'Add dark mode', url: 'u47', updatedAt: '2026-01-01T00:00:00Z', assignees: [], labels: [], subIssueCount: 0, blockers: { ok: true, open: [], shown: 0, total: 0 } }])
    expect(result.scanned).toBe(2)
    expect(result.total).toBe(2)
    expect(result.viewer).toBe('octo-dev')
  })

  it('carries each label with a lowercased colour, null when missing or malformed, and the sub-issue count', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount: 3,
            nodes: [
              {
                number: 1,
                title: 'parent',
                url: 'u1',
                updatedAt: 'x',
                labels: { nodes: [{ name: 'bug', color: 'D73A4A' }, { name: 'odd', color: 'xyz' }, { name: 'bare' }, { color: 'ffffff' }] },
                assignees: { nodes: [] },
                subIssues: { totalCount: 3 },
              },
              { number: 2, title: 'no field', url: 'u2', updatedAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] } },
              { number: 3, title: 'bad count', url: 'u3', updatedAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] }, subIssues: { totalCount: -1 } },
            ],
          },
        },
        viewer: { login: 'octo-dev' },
      },
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]?.labels).toEqual([
      { name: 'bug', color: 'd73a4a' },
      { name: 'odd', color: null },
      { name: 'bare', color: null },
    ])
    expect(result.items.map((item) => item.subIssueCount)).toEqual([3, 0, 0])
  })

  it('keeps only the open blockers, counting closed ones toward shown and total', async () => {
    const blockedBy = {
      totalCount: 2,
      nodes: [
        { number: 43, title: 'Open one', url: 'u43', state: 'OPEN' },
        { number: 40, title: 'Closed one', url: 'u40', state: 'CLOSED' },
      ],
    }
    const result = await fetchNodes([issueNode(45, { blockedBy })])
    expect(result.items[0]?.blockers).toEqual({ ok: true, open: [{ number: 43, title: 'Open one', url: 'u43', state: 'OPEN' }], shown: 2, total: 2 })
  })

  it('reads a missing blockedBy connection as unreadable, never as no blockers', async () => {
    const result = await fetchNodes([issueNode(45, {})])
    expect(result.items[0]?.blockers.ok).toBe(false)
  })

  it('degrades only the node whose blockedBy path errored', async () => {
    const errors = [{ path: ['repository', 'issues', 'nodes', 1, 'blockedBy'], message: 'boom' }]
    const result = await fetchNodes([issueNode(1, { blockedBy: NO_BLOCKERS }), issueNode(2, { blockedBy: null })], errors)
    expect(result.items.map((item) => item.blockers.ok)).toEqual([true, false])
  })

  it('indexes a blockedBy error by the raw node position, not the position after dropping claimed issues', async () => {
    const claimed = issueNode(1, { labels: { nodes: [{ name: READY_LABEL }] }, blockedBy: NO_BLOCKERS })
    const errors = [{ path: ['repository', 'issues', 'nodes', 1, 'blockedBy'], message: 'boom' }]
    const result = await fetchNodes([claimed, issueNode(2, { blockedBy: NO_BLOCKERS })], errors)
    expect(result.items.map((item) => [item.number, item.blockers.ok])).toEqual([[2, false]])
  })

  it('reports shown and total diverging when the blocker page is truncated', async () => {
    const blockedBy = { totalCount: 14, nodes: [{ number: 9, title: 'b', url: 'u9', state: 'OPEN' }] }
    const result = await fetchNodes([issueNode(45, { blockedBy })])
    const blockers = result.items[0]?.blockers
    expect(blockers?.ok === true && blockers.shown === 1 && blockers.total === 14).toBe(true)
  })

  it('reports scanned/total divergence as truncation, never as complete', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount: 150,
            nodes: [{ number: 1, title: 't', url: 'u', updatedAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] } }],
          },
        },
        viewer: { login: 'octo-dev' },
      },
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scanned).toBe(1)
    expect(result.total).toBe(150)
  })

  it('leaves viewer null on a viewer-query error, without failing the fetch', async () => {
    const stdout = JSON.stringify({
      data: { repository: { issues: { totalCount: 0, nodes: [] } }, viewer: null },
      errors: [{ path: ['viewer'], message: 'boom' }],
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBeNull()
  })

  it.each([
    ['unauthenticated', { ok: false as const, kind: 'unauthenticated' as const, stdout: '', stderr: 'gh: 401' }],
    ['rate-limited', { ok: false as const, kind: 'rate-limited' as const, stdout: '', stderr: 'rate limited' }],
    ['network', { ok: false as const, kind: 'network' as const, stdout: '', stderr: 'net down' }],
    ['not-found', { ok: false as const, kind: 'not-found' as const, searched: [] }],
    ['forbidden', { ok: false as const, kind: 'forbidden' as const, stdout: '', stderr: 'forbidden' }],
    ['http-not-found', { ok: false as const, kind: 'http-not-found' as const, stdout: '', stderr: '404' }],
  ])('maps a %s gh failure through the shared envelope classifier', async (kind, ghResult) => {
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner(ghResult as GhResult) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe(kind)
  })

  it('maps a repository the envelope reports as absent to repo-not-found', async () => {
    const stdout = JSON.stringify({ data: { repository: null } })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('repo-not-found')
  })

  it('maps any other unclassified failure to unknown', async () => {
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout: 'not json', stderr: '' }) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unparseable')
  })
})
