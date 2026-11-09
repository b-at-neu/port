import { describe, expect, it } from 'vitest'
import { readItemStates } from '@/main/github/item-states'
import { fakeTransport, graphqlBodyOf, httpFail, httpOk, queryOf } from '../../../fixtures/github-http'
import { createFakeGithub } from '../../../fixtures/reclaimer-harness'

const repo = { owner: 'acme', name: 'widgets' }

function respond(body: unknown) {
  return fakeTransport(httpOk(JSON.stringify(body)))
}

describe('readItemStates', () => {
  it('sends one aliased round trip with owner and name as variables', async () => {
    const { github, requests } = createFakeGithub({ states: { 36: 'MERGED', 41: 'OPEN' } })
    const result = await readItemStates({ repo, numbers: [36, 41], github })
    expect(result).toEqual({
      ok: true,
      states: new Map([
        [36, 'MERGED'],
        [41, 'OPEN'],
      ]),
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', path: 'graphql' })
    expect(graphqlBodyOf(requests[0]).variables).toEqual({ owner: 'acme', name: 'widgets' })
    const query = queryOf(requests[0])
    expect(query).toContain('n36: issueOrPullRequest(number: 36)')
    expect(query).toContain('n41: issueOrPullRequest(number: 41)')
    expect(query).toContain('... on PullRequest { state }')
  })

  it('makes no call for no numbers', async () => {
    const { github, requests } = createFakeGithub()
    expect(await readItemStates({ repo, numbers: [], github })).toEqual({ ok: true, states: new Map() })
    expect(requests).toEqual([])
  })

  it('maps an alias that came back absent, or without a state, to null', async () => {
    const github = respond({ data: { repository: { n1: null, n2: { __typename: 'Issue' }, n3: { state: 'CLOSED' } } } })
    const result = await readItemStates({ repo, numbers: [1, 2, 3, 4], github })
    expect(result).toEqual({
      ok: true,
      states: new Map([
        [1, null],
        [2, null],
        [3, 'CLOSED'],
        [4, null],
      ]),
    })
  })

  it('treats an alias named in errors as unavailable and trusts every other alias', async () => {
    const { github } = createFakeGithub({ states: { 1: 'MERGED', 2: 'MERGED' }, erroredAliases: [2] })
    const result = await readItemStates({ repo, numbers: [1, 2], github })
    expect(result).toEqual({
      ok: true,
      states: new Map([
        [1, 'MERGED'],
        [2, null],
      ]),
    })
  })

  it('fails on a transport error, and on a reply with no data', async () => {
    const network = fakeTransport({ ok: false, kind: 'network', status: null, body: '', message: 'offline' })
    expect(await readItemStates({ repo, numbers: [1], github: network })).toEqual({ ok: false, kind: 'network', message: 'offline' })
    expect(await readItemStates({ repo, numbers: [1], github: respond({ errors: [{ message: 'boom' }] }) })).toMatchObject({ ok: false, kind: 'no-data' })
    expect(await readItemStates({ repo, numbers: [1], github: fakeTransport(httpOk('not json')) })).toMatchObject({ ok: false, kind: 'unparseable' })
  })

  it('fails on a rate limit even when data is present', async () => {
    const limited = respond({ data: { repository: {} }, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] })
    expect(await readItemStates({ repo, numbers: [1], github: limited })).toMatchObject({ ok: false, kind: 'rate-limited' })
  })

  it('classifies an HTTP failure by its status', async () => {
    expect(await readItemStates({ repo, numbers: [1], github: fakeTransport(httpFail('rate-limited', 403)) })).toMatchObject({ ok: false, kind: 'rate-limited' })
  })
})
