import { describe, expect, it } from 'vitest'
import { conditionalGet, createEtagCache, etagKey } from '@/main/github/conditional'
import type { ConditionalHttpResult, ConditionalRequest, ConditionalTransport } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { httpFail, httpNotModified, recordingConditionalTransport } from '../../../fixtures/github-http'

const REPO_A = 'repo-a' as RepoId
const REPO_B = 'repo-b' as RepoId
const PATH = 'repos/o/r/branches/dev'
const RAW_ACCEPT = 'application/vnd.github.raw'

/** A GitHub whose resource has one current ETag; `remaining` drops on a 200 and never on a 304. */
function fakeGitHub() {
  const state = { etag: '"v1"', body: 'one', remaining: 5000 }
  const recorded = recordingConditionalTransport((request): ConditionalHttpResult => {
    if (request.ifNoneMatch === state.etag) return httpNotModified({ etag: state.etag, 'x-ratelimit-remaining': String(state.remaining) })
    state.remaining -= 1
    return { ok: true, notModified: false, status: 200, headers: { etag: state.etag, 'x-ratelimit-remaining': String(state.remaining) }, body: state.body }
  })
  return { state, ...recorded }
}

const request: Omit<ConditionalRequest, 'ifNoneMatch'> = { method: 'GET', path: PATH }

describe('conditionalGet', () => {
  it('an unchanged resource is not-modified on the second call and costs no rate limit', async () => {
    const github = fakeGitHub()
    const cache = createEtagCache()
    const first = await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    expect(first).toMatchObject({ ok: true, outcome: 'modified', etag: '"v1"', body: 'one' })
    expect(github.state.remaining).toBe(4999)

    const second = await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    expect(second).toMatchObject({ ok: true, outcome: 'not-modified', etag: '"v1"' })
    expect(github.requests[1]?.ifNoneMatch).toBe('"v1"')
    expect(github.state.remaining).toBe(4999)
  })

  it('a changed resource returns the new body and replaces the cached ETag', async () => {
    const github = fakeGitHub()
    const cache = createEtagCache()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    github.state.etag = '"v2"'
    github.state.body = 'two'

    expect(await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })).toMatchObject({ outcome: 'modified', etag: '"v2"', body: 'two' })
    expect(await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })).toMatchObject({ outcome: 'not-modified', etag: '"v2"' })
    expect(github.requests.map((sent) => sent.ifNoneMatch)).toEqual([undefined, '"v1"', '"v2"'])
  })

  it('a weak ETag is sent back unchanged', async () => {
    const github = fakeGitHub()
    github.state.etag = 'W/"weak"'
    const cache = createEtagCache()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    expect(github.requests[1]?.ifNoneMatch).toBe('W/"weak"')
  })

  it('a different Accept or query string never reuses another request shape’s ETag', async () => {
    const github = fakeGitHub()
    const cache = createEtagCache()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    await conditionalGet({ cache, repoId: REPO_A, request: { ...request, accept: RAW_ACCEPT }, conditional: github.transport })
    await conditionalGet({ cache, repoId: REPO_A, request: { ...request, path: `${PATH}?per_page=1` }, conditional: github.transport })
    expect(github.requests.map((sent) => sent.ifNoneMatch)).toEqual([undefined, undefined, undefined])
  })

  it('an explicit default Accept shares the key of an absent one', () => {
    expect(etagKey({ ...request, accept: 'application/vnd.github+json' })).toBe(etagKey(request))
  })

  it('never sends one repo’s ETag for another repo on the same path', async () => {
    const github = fakeGitHub()
    const cache = createEtagCache()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    await conditionalGet({ cache, repoId: REPO_B, request, conditional: github.transport })
    expect(github.requests[1]?.ifNoneMatch).toBeUndefined()
  })

  it('after forget, that repo is unconditional again and another repo’s entry is untouched', async () => {
    const github = fakeGitHub()
    const cache = createEtagCache()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    await conditionalGet({ cache, repoId: REPO_B, request, conditional: github.transport })
    cache.forget(REPO_A)

    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    await conditionalGet({ cache, repoId: REPO_B, request, conditional: github.transport })
    expect(github.requests.slice(2).map((sent) => sent.ifNoneMatch)).toEqual([undefined, '"v1"'])
  })

  it('a forget while a request is in flight drops that request’s store', async () => {
    const cache = createEtagCache()
    const github = fakeGitHub()
    const racing: ConditionalTransport = async (sent) => {
      const reply = await github.transport(sent)
      cache.forget(REPO_A)
      return reply
    }
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: racing })
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    expect(github.requests[1]?.ifNoneMatch).toBeUndefined()
  })

  it('a 200 without an etag header deletes the existing entry', async () => {
    const cache = createEtagCache()
    const github = fakeGitHub()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    const bare: ConditionalTransport = () => Promise.resolve({ ok: true, notModified: false, status: 200, headers: {}, body: 'x' })
    expect(await conditionalGet({ cache, repoId: REPO_A, request, conditional: bare })).toMatchObject({ outcome: 'modified', etag: null })
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    expect(github.requests[1]?.ifNoneMatch).toBeUndefined()
  })

  it('a 304 that carries a new etag replaces the cached one', async () => {
    const cache = createEtagCache()
    const github = fakeGitHub()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    const restated: ConditionalTransport = () => Promise.resolve(httpNotModified({ etag: '"v1b"' }))
    expect(await conditionalGet({ cache, repoId: REPO_A, request, conditional: restated })).toMatchObject({ outcome: 'not-modified', etag: '"v1b"' })
    expect(cache.lookup(REPO_A, etagKey(request)).etag).toBe('"v1b"')
  })

  it.each([
    ['a 500', Promise.resolve(httpFail('network', 500))],
    ['a 404', Promise.resolve(httpFail('http-not-found', 404))],
    ['a network failure', Promise.resolve({ ok: false, kind: 'network', status: null, body: '', message: 'GitHub is unreachable: down' } as const)],
  ])('%s passes through and leaves the entry in place', async (_name, failure) => {
    const cache = createEtagCache()
    const github = fakeGitHub()
    await conditionalGet({ cache, repoId: REPO_A, request, conditional: github.transport })
    const failing: ConditionalTransport = () => failure
    const result = await conditionalGet({ cache, repoId: REPO_A, request, conditional: failing })
    expect(result.ok).toBe(false)
    expect(cache.lookup(REPO_A, etagKey(request)).etag).toBe('"v1"')
  })
})
