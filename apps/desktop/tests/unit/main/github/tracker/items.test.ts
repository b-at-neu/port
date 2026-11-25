import { describe, expect, it } from 'vitest'
import { fetchClaimPreflight, fetchItemsByNumber } from '@/main/github/tracker/items'
import type { ItemsByNumberFetch, ResolvedItem } from '@/types/github'
import { fakeTransport, githubCtx, graphqlBodyOf, httpFail, httpOk, recordingTransport } from '../../../../fixtures/github-http'

const REPO = { owner: 'o', name: 'r' }

const issue = (number: number, extra: Record<string, unknown> = {}) => ({ __typename: 'Issue', number, title: 't', url: 'u', state: 'OPEN', closedAt: null, ...extra })
const pull = (number: number, extra: Record<string, unknown> = {}) => ({ __typename: 'PullRequest', number, title: 't', url: 'u', state: 'OPEN', ...extra })

function resolvedOf(read: ItemsByNumberFetch): readonly ResolvedItem[] {
  if (!read.ok) throw new Error(`read failed: ${read.message}`)
  return read.resolved
}

describe('fetchItemsByNumber', () => {
  it('returns an empty result for no numbers without a request', async () => {
    const { transport, requests } = recordingTransport(() => '{}')
    const result = await fetchItemsByNumber(githubCtx(transport), { repo: REPO, numbers: [] })
    expect(result).toMatchObject({ ok: true, resolved: [], unavailable: [] })
    expect(requests).toHaveLength(0)
  })

  it('resolves each node by its own __typename and reads pull-request-only fields from pull requests alone', async () => {
    const reply = JSON.stringify({
      data: {
        repository: {
          n0: issue(79, { assignees: { nodes: [{ login: 'alice' }] }, labels: { nodes: [{ name: 'ready' }] }, headRefName: 'stray', headRefOid: 'stray', author: { login: 'stray' } }),
          n1: pull(196, {
            state: 'MERGED',
            mergedAt: '2026-01-01T00:00:00Z',
            closedAt: '2026-01-01T00:00:00Z',
            headRefName: '195-the-branch',
            headRefOid: 'a1b2c3d4',
            author: { login: 'octocat' },
            labels: { nodes: [{ name: 'claude' }, { name: 'approved' }] },
          }),
          n2: pull(7, { author: null }),
        },
      },
    })
    const resolved = resolvedOf(await fetchItemsByNumber(githubCtx(fakeTransport(httpOk(reply))), { repo: REPO, numbers: [79, 196, 7] }))
    expect(resolved).toEqual([
      { number: 79, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['ready'], assignees: ['alice'], headRefName: null, headRefOid: null, author: null },
      {
        number: 196,
        kind: 'pull-request',
        state: 'MERGED',
        mergedAt: '2026-01-01T00:00:00Z',
        closedAt: '2026-01-01T00:00:00Z',
        title: 't',
        url: 'u',
        labels: ['claude', 'approved'],
        assignees: [],
        headRefName: '195-the-branch',
        headRefOid: 'a1b2c3d4',
        author: 'octocat',
      },
      { number: 7, kind: 'pull-request', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: [], headRefName: null, headRefOid: null, author: null },
    ])
  })

  const outcomes: readonly { readonly name: string; readonly reply: ReturnType<typeof httpOk> | ReturnType<typeof httpFail>; readonly expected: object }[] = [
    { name: 'a null node is unavailable, never a state', reply: httpOk(JSON.stringify({ data: { repository: { n0: null, n1: null } } })), expected: { ok: true, resolved: [], unavailable: [1, 2] } },
    {
      name: 'a partial error keeps the survivors and names the errored alias',
      reply: httpOk(JSON.stringify({ data: { repository: { n0: issue(1), n1: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'n1'], message: 'boom' }] })),
      expected: { ok: true, unavailable: [2] },
    },
    { name: 'a 401 is unauthenticated, never no data', reply: httpFail('unauthenticated', 401, '{"message":"Bad credentials"}', 'GitHub: Bad credentials (HTTP 401)'), expected: { ok: false, kind: 'unauthenticated', message: 'GitHub: Bad credentials (HTTP 401)' } },
    { name: 'a 422 carrying usable data falls through to the envelope', reply: httpFail('unknown', 422, JSON.stringify({ data: { repository: { n0: issue(1) } } })), expected: { ok: true } },
    { name: 'an unparseable body fails', reply: httpOk('not json'), expected: { ok: false, kind: 'unparseable' } },
  ]
  it.each(outcomes)('$name', async ({ reply, expected }) => {
    expect(await fetchItemsByNumber(githubCtx(fakeTransport(reply)), { repo: REPO, numbers: [1, 2] })).toMatchObject(expected)
  })
})

describe('fetchClaimPreflight', () => {
  const viewer = { login: 'alice' }
  const preflight = (reply: string) => fetchClaimPreflight(githubCtx(fakeTransport(httpOk(reply))), { repo: REPO, number: 1 })

  it('resolves an Issue with its labels, assignees and only the open blockers, keeping shown and total', async () => {
    const blockers = {
      totalCount: 24,
      nodes: [
        { number: 90, title: 'a', url: 'u2', state: 'OPEN' },
        { number: 91, title: 'b', url: 'u3', state: 'CLOSED' },
      ],
    }
    const node = issue(93, { title: 'Claim a ticket', labels: { nodes: [{ name: 'enhancement' }] }, assignees: { nodes: [{ login: 'alice' }] }, blockedBy: blockers })
    const result = await preflight(JSON.stringify({ data: { repository: { c0: node }, viewer } }))
    expect(result).toMatchObject({
      ok: true,
      viewer: 'alice',
      item: { kind: 'issue', number: 93, title: 'Claim a ticket', labels: ['enhancement'], assignees: ['alice'], blockers: { ok: true, open: [{ number: 90, title: 'a', url: 'u2', state: 'OPEN' }], shown: 2, total: 24 } },
    })
  })

  it('a PullRequest carries only its identity fields', async () => {
    const result = await preflight(JSON.stringify({ data: { repository: { c0: pull(5, { title: 'pr' }) }, viewer } }))
    expect(result).toMatchObject({ ok: true, item: { kind: 'pull-request', number: 5, title: 'pr', labels: [], assignees: [], blockers: { ok: true, open: [], shown: 0, total: 0 } } })
  })

  const outcomes: readonly { readonly name: string; readonly reply: object; readonly expected: object }[] = [
    { name: 'a null c0 node is item: null, never a failure', reply: { data: { repository: { c0: null }, viewer } }, expected: { ok: true, item: null, viewer: 'alice' } },
    {
      name: 'an item-level partial error is item: null, never a failure',
      reply: { data: { repository: { c0: null }, viewer }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'c0'], message: 'boom' }] },
      expected: { ok: true, item: null },
    },
    {
      name: 'a blockedBy-only error reports blockers unreadable and keeps the rest of the item',
      reply: { data: { repository: { c0: issue(1, { labels: { nodes: [] }, assignees: { nodes: [] }, blockedBy: null }) }, viewer }, errors: [{ type: 'SOME_ERROR', path: ['repository', 'c0', 'blockedBy'], message: 'boom' }] },
      expected: { ok: true, item: { title: 't', blockers: { ok: false, reason: "GitHub reported an error reading this issue's blockers" } } },
    },
    { name: 'an unresolvable viewer login fails the whole preflight', reply: { data: { repository: { c0: null }, viewer: null } }, expected: { ok: false, kind: 'no-data' } },
    { name: 'a viewer-level error fails the whole preflight', reply: { data: { repository: { c0: null }, viewer: null }, errors: [{ type: 'SOME_ERROR', path: ['viewer'], message: 'boom' }] }, expected: { ok: false, kind: 'no-data' } },
  ]
  it.each(outcomes)('$name', async ({ reply, expected }) => {
    expect(await preflight(JSON.stringify(reply))).toMatchObject(expected)
  })

  it('sends the document and owner/name as string variables in one POST to graphql', async () => {
    const { transport, requests } = recordingTransport(() => JSON.stringify({ data: { repository: { c0: null }, viewer } }))
    await fetchClaimPreflight(githubCtx(transport), { repo: REPO, number: 7 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', path: 'graphql' })
    expect(graphqlBodyOf(requests[0]).variables).toEqual({ owner: 'o', name: 'r' })
  })
})
