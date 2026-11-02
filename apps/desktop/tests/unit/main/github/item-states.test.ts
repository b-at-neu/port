import { describe, expect, it } from 'vitest'
import { readItemStates } from '@/main/github/item-states'
import type { GhResult } from '@/types/platform'
import { createFakeGh } from '../../../fixtures/reclaimer-harness'

const repo = { owner: 'acme', name: 'widgets' }

function respond(body: unknown): GhResult {
  return { ok: true, stdout: JSON.stringify(body), stderr: '' }
}

describe('readItemStates', () => {
  it('sends one aliased round trip with owner and name as variables', async () => {
    const { gh, calls } = createFakeGh({ states: { 36: 'MERGED', 41: 'OPEN' } })
    const result = await readItemStates({ repo, numbers: [36, 41], gh })
    expect(result).toEqual({
      ok: true,
      states: new Map([
        [36, 'MERGED'],
        [41, 'OPEN'],
      ]),
    })
    expect(calls).toHaveLength(1)
    const args = calls[0] ?? []
    expect(args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(args).toContain('owner=acme')
    expect(args).toContain('name=widgets')
    const query = args.find((a) => a.startsWith('query=')) ?? ''
    expect(query).toContain('n36: issueOrPullRequest(number: 36)')
    expect(query).toContain('n41: issueOrPullRequest(number: 41)')
    expect(query).toContain('... on PullRequest { state }')
  })

  it('makes no call for no numbers', async () => {
    const { gh, calls } = createFakeGh()
    expect(await readItemStates({ repo, numbers: [], gh })).toEqual({ ok: true, states: new Map() })
    expect(calls).toEqual([])
  })

  it('maps an alias that came back absent, or without a state, to null', async () => {
    const gh = () => Promise.resolve(respond({ data: { repository: { n1: null, n2: { __typename: 'Issue' }, n3: { state: 'CLOSED' } } } }))
    const result = await readItemStates({ repo, numbers: [1, 2, 3, 4], gh })
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
    const { gh } = createFakeGh({ states: { 1: 'MERGED', 2: 'MERGED' }, erroredAliases: [2] })
    const result = await readItemStates({ repo, numbers: [1, 2], gh })
    expect(result).toEqual({
      ok: true,
      states: new Map([
        [1, 'MERGED'],
        [2, null],
      ]),
    })
  })

  it('fails on a transport error, and on a reply with no data', async () => {
    const network: GhResult = { ok: false, kind: 'network', stdout: '', stderr: 'offline' }
    expect(await readItemStates({ repo, numbers: [1], gh: () => Promise.resolve(network) })).toEqual({ ok: false, kind: 'network', message: 'offline' })
    expect(await readItemStates({ repo, numbers: [1], gh: () => Promise.resolve(respond({ errors: [{ message: 'boom' }] })) })).toMatchObject({ ok: false, kind: 'no-data' })
    expect(await readItemStates({ repo, numbers: [1], gh: () => Promise.resolve({ ok: true, stdout: 'not json', stderr: '' }) })).toMatchObject({ ok: false, kind: 'unparseable' })
  })

  it('fails on a rate limit even when data is present', async () => {
    const limited = respond({ data: { repository: {} }, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] })
    expect(await readItemStates({ repo, numbers: [1], gh: () => Promise.resolve(limited) })).toMatchObject({ ok: false, kind: 'rate-limited' })
  })
})
