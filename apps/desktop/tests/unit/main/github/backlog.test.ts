import { describe, expect, it } from 'vitest'
import type { GitHubHttpResult } from '@/types/platform'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { fetchBacklog } from '@/main/github/backlog'
import { fakeTransport, httpFail, httpOk, queryOf, recordingTransport } from '../../../fixtures/github-http'

const VOCABULARY = resolveVocabulary({})
const READY_LABEL = VOCABULARY.labels.find((label) => label.key === 'ready')?.name ?? 'ready'
const NO_BLOCKERS = { totalCount: 0, nodes: [] }
const NO_LINKS = { ok: true, open: [], shown: 0, total: 0 }
const NO_CHILDREN = { ok: true, children: [], shown: 0, total: 0 }

function epicNode(number: number): Record<string, unknown> {
  return issueNode(number, { subIssues: { totalCount: 3 }, blockedBy: NO_BLOCKERS, blocking: NO_BLOCKERS, parent: null })
}

function child(number: number, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number, title: `c${String(number)}`, state, labels: { nodes: [] }, blockedBy: NO_BLOCKERS, ...extra }
}

// Answers the list read first and the children read second, as `fetchBacklog` issues them.
async function fetchWithChildren(listNodes: readonly Record<string, unknown>[], childrenReply: unknown) {
  const list = JSON.stringify({ data: { repository: { issues: { totalCount: listNodes.length, nodes: listNodes } }, viewer: { login: 'octo-dev' } } })
  const recording = recordingTransport((_request, index) => (index === 0 ? list : typeof childrenReply === 'string' ? childrenReply : JSON.stringify(childrenReply)))
  const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: recording.transport })
  if (!result.ok) throw new Error('expected an ok read')
  return { result, requests: recording.requests }
}

function issueNode(number: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { number, title: `t${String(number)}`, url: `u${String(number)}`, updatedAt: 'x', labels: { nodes: [] }, assignees: { nodes: [] }, ...extra }
}

async function fetchNodes(nodes: readonly Record<string, unknown>[], errors?: readonly unknown[]) {
  const stdout = JSON.stringify({ data: { repository: { issues: { totalCount: nodes.length, nodes } }, viewer: { login: 'octo-dev' } }, ...(errors === undefined ? {} : { errors }) })
  const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk(stdout)) })
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
              { number: 47, title: 'Add dark mode', url: 'u47', updatedAt: '2026-01-01T00:00:00Z', labels: { nodes: [] }, assignees: { nodes: [] }, blockedBy: NO_BLOCKERS, blocking: NO_BLOCKERS, parent: null },
              { number: 45, title: 'Already claimed', url: 'u45', updatedAt: '2026-01-02T00:00:00Z', labels: { nodes: [{ name: READY_LABEL }] }, assignees: { nodes: [{ login: 'alice' }] }, blockedBy: NO_BLOCKERS },
            ],
          },
        },
        viewer: { login: 'octo-dev' },
      },
    })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([
      { number: 47, title: 'Add dark mode', url: 'u47', updatedAt: '2026-01-01T00:00:00Z', assignees: [], labels: [], subIssueCount: 0, blockers: NO_LINKS, blocking: NO_LINKS, parent: { ok: true, parent: null }, children: NO_CHILDREN },
    ])
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
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk(stdout)) })
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
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk(stdout)) })
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
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBeNull()
  })

  it.each<[string, GitHubHttpResult]>([
    ['unauthenticated', httpFail('unauthenticated', 401)],
    ['rate-limited', httpFail('rate-limited', 429)],
    ['network', httpFail('network', 502)],
    ['not-found', { ok: false, kind: 'not-found', command: 'gh', searched: [] }],
    ['forbidden', httpFail('forbidden', 403)],
    ['http-not-found', httpFail('http-not-found', 404)],
  ])('maps a %s failure through the shared envelope classifier', async (kind, failure) => {
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(failure) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe(kind)
  })

  it('maps a repository the envelope reports as absent to repo-not-found', async () => {
    const stdout = JSON.stringify({ data: { repository: null } })
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('repo-not-found')
  })

  it('maps any other unclassified failure to unknown', async () => {
    const result = await fetchBacklog({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, github: fakeTransport(httpOk('not json')) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unparseable')
  })
})

describe('fetchBacklog parent and blocking', () => {
  it('reads no parent, a present parent, and a closed parent', async () => {
    const result = await fetchNodes([
      issueNode(1, { parent: null }),
      issueNode(2, { parent: { number: 41, title: 'Epic', state: 'OPEN' } }),
      issueNode(3, { parent: { number: 40, title: 'Old', state: 'CLOSED' } }),
    ])
    expect(result.items.map((item) => item.parent)).toEqual([
      { ok: true, parent: null },
      { ok: true, parent: { number: 41, title: 'Epic', state: 'OPEN' } },
      { ok: true, parent: { number: 40, title: 'Old', state: 'CLOSED' } },
    ])
  })

  it('reads an errored, missing or malformed parent as unreadable, never as no parent', async () => {
    const errors = [{ path: ['repository', 'issues', 'nodes', 0, 'parent'], message: 'boom' }]
    const result = await fetchNodes([issueNode(1, { parent: null }), issueNode(2, {}), issueNode(3, { parent: { number: 'x', state: 'OPEN' } }), issueNode(4, { parent: { number: 4, state: 'MERGED' } })], errors)
    expect(result.items.map((item) => item.parent.ok)).toEqual([false, false, false, false])
    expect(result.items[1]?.parent).toEqual({ ok: false, reason: 'parent is missing from the response' })
    expect(result.items[2]?.parent).toEqual({ ok: false, reason: 'parent is malformed' })
  })

  it('keeps only open blocking edges, counting closed ones toward shown', async () => {
    const blocking = {
      totalCount: 2,
      nodes: [
        { number: 50, title: 'Open', url: 'u50', state: 'OPEN' },
        { number: 49, title: 'Closed', url: 'u49', state: 'CLOSED' },
      ],
    }
    const result = await fetchNodes([issueNode(1, { blocking })])
    expect(result.items[0]?.blocking).toEqual({ ok: true, open: [{ number: 50, title: 'Open', url: 'u50', state: 'OPEN' }], shown: 2, total: 2 })
  })

  it('reports a truncated blocking page as shown below total', async () => {
    const blocking = { totalCount: 14, nodes: [{ number: 9, title: 'b', url: 'u9', state: 'OPEN' }] }
    const result = await fetchNodes([issueNode(1, { blocking })])
    const read = result.items[0]?.blocking
    expect(read?.ok === true && read.shown === 1 && read.total === 14).toBe(true)
  })

  it('degrades only the blocking field whose path errored, and names it', async () => {
    const errors = [{ path: ['repository', 'issues', 'nodes', 0, 'blocking'], message: 'boom' }]
    const result = await fetchNodes([issueNode(1, { blockedBy: NO_BLOCKERS, blocking: null }), issueNode(2, { blockedBy: NO_BLOCKERS, blocking: NO_BLOCKERS })], errors)
    expect(result.items.map((item) => [item.blockers.ok, item.blocking.ok])).toEqual([
      [true, false],
      [true, true],
    ])
    expect(result.items[0]?.blocking).toEqual({ ok: false, reason: 'GitHub reported an error reading the issues this one blocks' })
  })

  it('reads a missing blocking connection as unreadable', async () => {
    const result = await fetchNodes([issueNode(1, {})])
    expect(result.items[0]?.blocking).toEqual({ ok: false, reason: 'blocking is missing from the response' })
  })
})

describe('fetchBacklog children', () => {
  it('makes no second request when no kept item has sub-issues', async () => {
    const { result, requests } = await fetchWithChildren([issueNode(1, { blockedBy: NO_BLOCKERS })], {})
    expect(requests).toHaveLength(1)
    expect(result.items[0]?.children).toEqual(NO_CHILDREN)
  })

  it('reads closed, claimed and open children of an epic', async () => {
    const reply = {
      data: {
        repository: {
          e0: {
            subIssues: {
              totalCount: 3,
              nodes: [
                child(38, 'CLOSED'),
                child(39, 'OPEN', { labels: { nodes: [{ name: READY_LABEL }] } }),
                child(43, 'OPEN', { blockedBy: { totalCount: 1, nodes: [{ number: 39, title: 'c39', url: 'u39', state: 'OPEN' }] } }),
              ],
            },
          },
        },
      },
    }
    const { result, requests } = await fetchWithChildren([epicNode(41), issueNode(2, { blockedBy: NO_BLOCKERS })], reply)
    expect(requests).toHaveLength(2)
    expect(queryOf(requests[1])).toContain('e0: issue(number: 41)')
    expect(result.items[1]?.children).toEqual(NO_CHILDREN)
    expect(result.items[0]?.children).toEqual({
      ok: true,
      shown: 3,
      total: 3,
      children: [
        { number: 38, title: 'c38', state: 'CLOSED', claimed: false, blockers: NO_LINKS },
        { number: 39, title: 'c39', state: 'OPEN', claimed: true, blockers: NO_LINKS },
        { number: 43, title: 'c43', state: 'OPEN', claimed: false, blockers: { ok: true, open: [{ number: 39, title: 'c39', url: 'u39', state: 'OPEN' }], shown: 1, total: 1 } },
      ],
    })
  })

  it('carries no issue body in either query', async () => {
    const reply = { data: { repository: { e0: { subIssues: { totalCount: 0, nodes: [] } } } } }
    const { requests } = await fetchWithChildren([epicNode(41)], reply)
    expect(queryOf(requests[0])).not.toMatch(/\bbody\b/)
    expect(queryOf(requests[1])).not.toMatch(/\bbody\b/)
  })

  it('reports truncated children as shown below total', async () => {
    const reply = { data: { repository: { e0: { subIssues: { totalCount: 80, nodes: [child(1, 'OPEN')] } } } } }
    const { result } = await fetchWithChildren([epicNode(41)], reply)
    const read = result.items[0]?.children
    expect(read?.ok === true && read.shown === 1 && read.total === 80).toBe(true)
  })

  it('counts a malformed child toward shown without listing it', async () => {
    const reply = { data: { repository: { e0: { subIssues: { totalCount: 2, nodes: [child(1, 'OPEN'), { number: 'x', state: 'OPEN' }] } } } } }
    const { result } = await fetchWithChildren([epicNode(41)], reply)
    const read = result.items[0]?.children
    expect(read?.ok === true && read.children.length === 1 && read.shown === 2).toBe(true)
  })

  it('fails every epic when the children request fails, leaving the list ok', async () => {
    const { result } = await fetchWithChildren([epicNode(41), epicNode(42), issueNode(3, { blockedBy: NO_BLOCKERS })], httpFail('network', 502))
    expect(result.items.map((item) => item.children.ok)).toEqual([false, false, true])
    expect(result.items[0]?.children.ok === false && result.items[0].children.reason).toContain("Couldn't read this epic's sub-issues")
  })

  it('fails only the epic whose alias errored', async () => {
    const reply = {
      data: { repository: { e0: null, e1: { subIssues: { totalCount: 1, nodes: [child(7, 'OPEN')] } } } },
      errors: [{ path: ['repository', 'e0'], message: 'boom' }],
    }
    const { result } = await fetchWithChildren([epicNode(41), epicNode(42)], reply)
    expect(result.items.map((item) => item.children.ok)).toEqual([false, true])
  })

  it('degrades only the child whose blockedBy errored', async () => {
    const reply = {
      data: { repository: { e0: { subIssues: { totalCount: 2, nodes: [child(7, 'OPEN', { blockedBy: null }), child(8, 'OPEN')] } } } },
      errors: [{ path: ['repository', 'e0', 'subIssues', 'nodes', 0, 'blockedBy'], message: 'boom' }],
    }
    const { result } = await fetchWithChildren([epicNode(41)], reply)
    const read = result.items[0]?.children
    expect(read?.ok === true && read.children.map((entry) => entry.blockers.ok)).toEqual([false, true])
  })

  it('fails the whole epic when a child labels read errored, since claimed cannot be guessed', async () => {
    const reply = {
      data: { repository: { e0: { subIssues: { totalCount: 1, nodes: [child(7, 'OPEN', { labels: null })] } } } },
      errors: [{ path: ['repository', 'e0', 'subIssues', 'nodes', 0, 'labels'], message: 'boom' }],
    }
    const { result } = await fetchWithChildren([epicNode(41)], reply)
    expect(result.items[0]?.children.ok).toBe(false)
  })

  it('fails an epic whose subIssues connection is missing or malformed', async () => {
    const reply = { data: { repository: { e0: {}, e1: { subIssues: { totalCount: 'x', nodes: [] } } } } }
    const { result } = await fetchWithChildren([epicNode(41), epicNode(42)], reply)
    expect(result.items.map((item) => item.children.ok)).toEqual([false, false])
  })
})
