import { describe, expect, it } from 'vitest'
import { readItemStates } from '@/main/github/item-states'
import type { GitHubTransport } from '@/types/platform'
import { fakeTransport, githubCtx, graphqlBodyOf, httpFail, httpOk, queryOf } from '../../../fixtures/github-http'
import { createFakeGithub } from '../../../fixtures/reclaimer-harness'

const repo = { owner: 'acme', name: 'widgets' }

const read = (github: GitHubTransport, numbers: readonly number[]) => readItemStates(githubCtx(github), { repo, numbers })
const respond = (body: unknown) => fakeTransport(httpOk(JSON.stringify(body)))

describe('readItemStates', () => {
  it('sends one aliased round trip with owner and name as variables', async () => {
    const { github, requests } = createFakeGithub({ states: { 36: 'MERGED', 41: 'OPEN' } })
    expect(await read(github, [36, 41])).toEqual({
      ok: true,
      states: new Map([
        [36, 'MERGED'],
        [41, 'OPEN'],
      ]),
    })
    expect(requests).toHaveLength(1)
    expect(graphqlBodyOf(requests[0]).variables).toEqual({ owner: 'acme', name: 'widgets' })
    expect(queryOf(requests[0])).toContain('n36: issueOrPullRequest(number: 36)')
  })

  it('makes no call for no numbers', async () => {
    const { github, requests } = createFakeGithub()
    expect(await read(github, [])).toEqual({ ok: true, states: new Map() })
    expect(requests).toEqual([])
  })

  it('maps an alias that came back absent, without a state, or named in errors to null', async () => {
    const reply = respond({ data: { repository: { n1: null, n2: { __typename: 'Issue' }, n3: { state: 'CLOSED' }, n4: { state: 'MERGED' } } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'n4'], message: 'x' }] })
    expect(await read(reply, [1, 2, 3, 4, 5])).toEqual({
      ok: true,
      states: new Map([
        [1, null],
        [2, null],
        [3, 'CLOSED'],
        [4, null],
        [5, null],
      ]),
    })
  })

  const failures: readonly { readonly name: string; readonly github: GitHubTransport; readonly expected: object }[] = [
    { name: 'a transport error', github: fakeTransport({ ok: false, kind: 'network', status: null, body: '', message: 'offline' }), expected: { ok: false, kind: 'network', message: 'offline' } },
    { name: 'a reply with no data', github: respond({ errors: [{ message: 'boom' }] }), expected: { ok: false, kind: 'no-data' } },
    { name: 'an unparseable reply', github: fakeTransport(httpOk('not json')), expected: { ok: false, kind: 'unparseable' } },
    { name: 'a rate limit even with data present', github: respond({ data: { repository: {} }, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] }), expected: { ok: false, kind: 'rate-limited' } },
    { name: 'an HTTP rate limit', github: fakeTransport(httpFail('rate-limited', 403)), expected: { ok: false, kind: 'rate-limited' } },
  ]
  it.each(failures)('fails on $name', async ({ github, expected }) => {
    expect(await read(github, [1])).toMatchObject(expected)
  })
})
