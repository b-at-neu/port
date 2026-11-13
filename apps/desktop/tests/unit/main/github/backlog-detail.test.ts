import { describe, expect, it } from 'vitest'
import { fetchBacklogDetail } from '@/main/github/backlog-detail'
import { fakeTransport, graphqlBodyOf, httpFail, httpOk, recordingTransport } from '../../../fixtures/github-http'

const REPO = { owner: 'o', name: 'r' }

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'Issue',
    number: 45,
    title: 'Document the retry policy',
    url: 'https://github.com/o/r/issues/45',
    state: 'OPEN',
    body: '## Scope\n\nText.',
    updatedAt: '2026-09-04T10:00:00Z',
    author: { login: 'alice' },
    assignees: { nodes: [{ login: 'alice' }] },
    parent: { number: 41, title: 'Epic', url: 'u41', state: 'OPEN' },
    blockedBy: {
      totalCount: 2,
      nodes: [
        { number: 43, title: 'Open blocker', url: 'u43', state: 'OPEN' },
        { number: 40, title: 'Closed blocker', url: 'u40', state: 'CLOSED' },
      ],
    },
    blocking: { totalCount: 0, nodes: [] },
    ...overrides,
  }
}

function reply(node: unknown, errors?: readonly unknown[]): string {
  return JSON.stringify({ data: { repository: { detail: node } }, ...(errors === undefined ? {} : { errors }) })
}

function run(stdout: string) {
  return fetchBacklogDetail({ repo: REPO, number: 45, github: fakeTransport(httpOk(stdout)) })
}

describe('fetchBacklogDetail', () => {
  it('maps every field of an open issue', async () => {
    const result = await run(reply(issueNode()))
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.detail).toEqual({
      number: 45,
      title: 'Document the retry policy',
      url: 'https://github.com/o/r/issues/45',
      body: '## Scope\n\nText.',
      author: 'alice',
      updatedAt: '2026-09-04T10:00:00Z',
      assignees: ['alice'],
      parent: { ok: true, parent: { number: 41, title: 'Epic', url: 'u41', state: 'OPEN' } },
      blockedBy: {
        ok: true,
        total: 2,
        items: [
          { number: 43, title: 'Open blocker', url: 'u43', state: 'OPEN' },
          { number: 40, title: 'Closed blocker', url: 'u40', state: 'CLOSED' },
        ],
      },
      blocking: { ok: true, items: [], total: 0 },
    })
  })

  it('asks for issueOrPullRequest(number: 45) with the owner and name variables', async () => {
    const { transport, requests } = recordingTransport(() => reply(issueNode()))
    await fetchBacklogDetail({ repo: REPO, number: 45, github: transport })
    const body = graphqlBodyOf(requests[0])
    expect(body.query).toContain('issueOrPullRequest(number: 45)')
    expect(body.variables).toEqual({ owner: 'o', name: 'r' })
  })

  it('reports a truncated blocking list as total above items', async () => {
    const result = await run(reply(issueNode({ blocking: { totalCount: 30, nodes: [{ number: 50, title: 't', url: 'u', state: 'OPEN' }] } })))
    if (!result.ok) throw new Error('unexpected failure')
    expect(result.detail.blocking).toEqual({ ok: true, total: 30, items: [{ number: 50, title: 't', url: 'u', state: 'OPEN' }] })
  })

  it('gives a null author for a deleted account and an empty body for a non-string body', async () => {
    const result = await run(reply(issueNode({ author: null, body: null })))
    if (!result.ok) throw new Error('unexpected failure')
    expect(result.detail.author).toBeNull()
    expect(result.detail.body).toBe('')
  })

  it('treats a null parent as no parent', async () => {
    const result = await run(reply(issueNode({ parent: null })))
    if (!result.ok) throw new Error('unexpected failure')
    expect(result.detail.parent).toEqual({ ok: true, parent: null })
  })

  describe('missing and closed', () => {
    it('maps a null node with a NOT_FOUND error to issue-missing', async () => {
      const result = await run(reply(null, [{ type: 'NOT_FOUND', path: ['repository', 'detail'], message: 'nope' }]))
      expect(result).toMatchObject({ ok: false, kind: 'issue-missing', message: '#45 does not exist in o/r' })
    })

    it('maps a null node with no error to issue-missing', async () => {
      expect(await run(reply(null))).toMatchObject({ ok: false, kind: 'issue-missing' })
    })

    it('maps a pull request to issue-missing', async () => {
      const result = await run(reply({ __typename: 'PullRequest', number: 45 }))
      expect(result).toMatchObject({ ok: false, kind: 'issue-missing', message: '#45 is a pull request, not an issue' })
    })

    it('maps a closed issue to issue-closed', async () => {
      expect(await run(reply(issueNode({ state: 'CLOSED' })))).toMatchObject({ ok: false, kind: 'issue-closed', message: '#45 is closed' })
    })
  })

  describe('read failures', () => {
    it.each(['network', 'unauthenticated'] as const)('passes a %s transport failure through', async (kind) => {
      const result = await fetchBacklogDetail({ repo: REPO, number: 45, github: fakeTransport(httpFail(kind, 500)) })
      expect(result).toMatchObject({ ok: false, kind })
    })

    it('reports a non-JSON body as unparseable', async () => {
      expect(await run('<html>')).toMatchObject({ ok: false, kind: 'unparseable' })
    })

    it('reports a null repository as repo-not-found', async () => {
      expect(await run(JSON.stringify({ data: { repository: null } }))).toMatchObject({ ok: false, kind: 'repo-not-found' })
    })

    it('reports a RATE_LIMITED error as rate-limited', async () => {
      const result = await run(reply(null, [{ type: 'RATE_LIMITED', message: 'slow down' }]))
      expect(result).toMatchObject({ ok: false, kind: 'rate-limited' })
    })
  })

  describe('node-level errors', () => {
    it('fails closed as no-data on a non-NOT_FOUND error on the node', async () => {
      const result = await run(reply(null, [{ type: 'INTERNAL', path: ['repository', 'detail'], message: 'boom' }]))
      expect(result).toMatchObject({ ok: false, kind: 'no-data', message: 'GitHub reported an error reading #45: boom' })
    })

    it('fails the whole read as no-data on an error under body', async () => {
      const result = await run(reply(issueNode({ body: null }), [{ type: 'INTERNAL', path: ['repository', 'detail', 'body'], message: 'boom' }]))
      expect(result).toMatchObject({ ok: false, kind: 'no-data' })
    })
  })

  describe('field-level errors', () => {
    it.each([
      ['blockedBy', { blockedBy: null }],
      ['blocking', { blocking: null }],
      ['parent', { parent: null }],
    ] as const)('marks only %s as failed', async (field, nulled) => {
      const result = await run(reply(issueNode(nulled), [{ type: 'INTERNAL', path: ['repository', 'detail', field], message: 'boom' }]))
      if (!result.ok) throw new Error('unexpected failure')
      expect(result.detail[field]).toMatchObject({ ok: false })
      const others = (['blockedBy', 'blocking', 'parent'] as const).filter((other) => other !== field)
      for (const other of others) expect(result.detail[other]).toMatchObject({ ok: true })
      expect(result.detail.body).toBe('## Scope\n\nText.')
    })

    it('marks a malformed blocking connection as failed', async () => {
      const result = await run(reply(issueNode({ blocking: { nodes: 'x' } })))
      if (!result.ok) throw new Error('unexpected failure')
      expect(result.detail.blocking).toMatchObject({ ok: false })
    })
  })
})
