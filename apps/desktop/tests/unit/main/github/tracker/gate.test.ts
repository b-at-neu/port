import { describe, expect, it } from 'vitest'
import { fetchGatePreflight } from '@/main/github/tracker/gate'
import type { GitHubHttpResult } from '@/types/platform'
import { fakeTransport, githubCtx, httpFail, httpOk } from '../../../../fixtures/github-http'

const viewer = { login: 'alice' }
const preflight = (reply: GitHubHttpResult, number = 1) => fetchGatePreflight(githubCtx(fakeTransport(reply)), { repo: { owner: 'o', name: 'r' }, number })
const replyOf = (body: object) => httpOk(JSON.stringify(body))

describe('fetchGatePreflight', () => {
  it('resolves an Issue with its body and assignees, and a PullRequest with identity fields only', async () => {
    const issue = { __typename: 'Issue', number: 148, title: 'Gate', url: 'u', state: 'OPEN', body: 'Ticket body.', assignees: { nodes: [{ login: 'alice' }] } }
    expect(await preflight(replyOf({ data: { repository: { c0: issue }, viewer } }), 148)).toMatchObject({
      ok: true,
      viewer: 'alice',
      item: { kind: 'issue', number: 148, title: 'Gate', body: 'Ticket body.', assignees: ['alice'] },
    })
    const pull = { __typename: 'PullRequest', number: 5, title: 't', url: 'u', state: 'OPEN', body: 'stray' }
    expect(await preflight(replyOf({ data: { repository: { c0: pull }, viewer } }), 5)).toMatchObject({ ok: true, item: { kind: 'pull-request', number: 5, body: '', assignees: [] } })
  })

  const outcomes: readonly { readonly name: string; readonly reply: GitHubHttpResult; readonly expected: object }[] = [
    { name: 'an unresolved number is item: null without failing the fetch', reply: replyOf({ data: { repository: { c0: null }, viewer } }), expected: { ok: true, item: null, viewer: 'alice' } },
    { name: 'an unresolvable viewer fails the whole preflight', reply: replyOf({ data: { repository: { c0: null }, viewer: null } }), expected: { ok: false, kind: 'no-data' } },
    {
      name: 'an HTTP failure is classified through the shared envelope',
      reply: httpFail('unauthenticated', 401, '', 'GitHub: Bad credentials (HTTP 401)'),
      expected: { ok: false, kind: 'unauthenticated', message: 'GitHub: Bad credentials (HTTP 401)' },
    },
  ]
  it.each(outcomes)('$name', async ({ reply, expected }) => {
    expect(await preflight(reply)).toMatchObject(expected)
  })
})
