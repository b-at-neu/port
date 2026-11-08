import { describe, expect, it } from 'vitest'
import { classifyHttpStatus, createGitHubClient } from '@/main/platform/github-http'
import type { ConditionalRequest, GitHubHttpResult, GitHubRequest } from '@/types/platform'

type TokenRead = { readonly ok: true; readonly token: string } | Exclude<GitHubHttpResult, { ok: true }>

interface Sent {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

const GRAPHQL: GitHubRequest = { method: 'POST', path: 'graphql', body: '{"query":"{ viewer { login } }","variables":{"owner":"o"}}' }
const REST: GitHubRequest = { method: 'GET', path: 'repos/o/r/commits/dev', accept: 'application/vnd.github.raw' }

function harness(replies: readonly (() => Promise<Response>)[], tokens: readonly TokenRead[] = [{ ok: true, token: 't1' }], options: { maxBytes?: number } = {}) {
  const sent: Sent[] = []
  let tokenReads = 0
  let call = 0
  let clock = 0
  const client = createGitHubClient({
    now: () => clock,
    tokenTtlMs: 30_000,
    fetch: (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers, body: init.body })
      const reply = replies[call++] ?? replies[replies.length - 1]
      if (reply === undefined) throw new Error('no reply scripted')
      return reply()
    },
    readToken: () => {
      const read = tokens[tokenReads++] ?? tokens[tokens.length - 1]
      if (read === undefined) throw new Error('no token scripted')
      return Promise.resolve(read)
    },
    apiBase: 'https://api.test',
    timeoutMs: 30_000,
    maxBytes: options.maxBytes ?? 1024,
  })
  return {
    transport: client.request,
    conditional: client.conditional,
    sent,
    tokenReads: () => tokenReads,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const reply = (status: number, body = '{}', headers: Record<string, string> = {}) => () => Promise.resolve(new Response(status === 304 ? null : body, { status, headers }))

describe('classifyHttpStatus', () => {
  it.each([
    [200, {}, '{}', 'ok'],
    [204, {}, '', 'ok'],
    [401, {}, '', 'unauthenticated'],
    [403, { 'x-ratelimit-remaining': '0' }, '', 'rate-limited'],
    [403, { 'retry-after': '30' }, '', 'rate-limited'],
    [403, {}, '{"message":"API rate limit exceeded"}', 'rate-limited'],
    [403, { 'x-ratelimit-remaining': '4000' }, '{"message":"Resource not accessible"}', 'forbidden'],
    [429, {}, '', 'rate-limited'],
    [404, {}, '', 'http-not-found'],
    [500, {}, '', 'network'],
    [503, {}, '', 'network'],
    [400, {}, '', 'unknown'],
    [422, {}, '', 'unknown'],
    [304, {}, '', 'unknown'],
  ])('%i with %j is %s', (status, headers, body, expected) => {
    expect(classifyHttpStatus(status, headers, body)).toBe(expected)
  })
})

const CONDITIONAL: ConditionalRequest = { method: 'GET', path: 'repos/o/r/branches/dev', ifNoneMatch: 'W/"abc"' }

describe('createGitHubClient conditional', () => {
  it('sends ifNoneMatch verbatim as If-None-Match, and nothing without it', async () => {
    const { conditional, sent } = harness([reply(200)])
    await conditional(CONDITIONAL)
    await conditional({ method: 'GET', path: 'repos/o/r/branches/dev' })
    expect(sent[0]?.headers['If-None-Match']).toBe('W/"abc"')
    expect(sent[1]?.headers).not.toHaveProperty('If-None-Match')
  })

  it('a 304 after a sent validator is notModified, with its headers', async () => {
    const { conditional } = harness([reply(304, '', { ETag: 'W/"abc"' })])
    expect(await conditional(CONDITIONAL)).toEqual({ ok: true, notModified: true, status: 304, headers: { etag: 'W/"abc"' } })
  })

  it('a 200 is notModified false with the body', async () => {
    const { conditional } = harness([reply(200, '{"a":1}', { ETag: '"new"' })])
    expect(await conditional(CONDITIONAL)).toEqual({ ok: true, notModified: false, status: 200, headers: { etag: '"new"', 'content-type': 'text/plain;charset=UTF-8' }, body: '{"a":1}' })
  })

  it('a 304 without a validator is unknown, as on the plain path', async () => {
    const { conditional } = harness([reply(304)])
    expect(await conditional({ method: 'GET', path: 'repos/o/r/branches/dev' })).toMatchObject({ ok: false, kind: 'unknown', status: 304 })
  })

  it('a 304 from the plain request is still unknown', async () => {
    const { transport } = harness([reply(304)])
    expect(await transport(REST)).toMatchObject({ ok: false, kind: 'unknown', status: 304 })
  })

  it('a 401 re-reads the token and retries once', async () => {
    const { conditional, sent, tokenReads } = harness([reply(401, '{"message":"Bad credentials"}'), reply(304)], [{ ok: true, token: 'old' }, { ok: true, token: 'new' }])
    expect(await conditional(CONDITIONAL)).toMatchObject({ ok: true, notModified: true })
    expect(tokenReads()).toBe(2)
    expect(sent.map((request) => request.headers.Authorization)).toEqual(['Bearer old', 'Bearer new'])
  })

  it('request and conditional share one token read', async () => {
    const { transport, conditional, tokenReads } = harness([reply(200)])
    await transport(REST)
    await conditional(CONDITIONAL)
    expect(tokenReads()).toBe(1)
  })

  it('a failure status is classified like any other read', async () => {
    const { conditional } = harness([reply(404, '{"message":"Not Found"}')])
    expect(await conditional(CONDITIONAL)).toMatchObject({ ok: false, kind: 'http-not-found', status: 404 })
  })
})

describe('createGitHubTransport', () => {
  it('sends a GraphQL request as one POST with the exact headers', async () => {
    const { transport, sent } = harness([reply(200)])
    const result = await transport(GRAPHQL)
    expect(result).toMatchObject({ ok: true, status: 200, body: '{}' })
    expect(sent).toEqual([
      {
        url: 'https://api.test/graphql',
        method: 'POST',
        headers: { Authorization: 'Bearer t1', 'User-Agent': 'port-desktop', 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: GRAPHQL.body,
      },
    ])
  })

  it('sends a REST read as a GET with the raw Accept the request names', async () => {
    const { transport, sent } = harness([reply(200, 'text')])
    await transport(REST)
    expect(sent[0]).toMatchObject({ url: 'https://api.test/repos/o/r/commits/dev', method: 'GET', body: undefined })
    expect(sent[0]?.headers.Accept).toBe('application/vnd.github.raw')
    expect(sent[0]?.headers['Content-Type']).toBeUndefined()
  })

  it('lower-cases response header names', async () => {
    const { transport } = harness([reply(200, '{}', { ETag: '"abc"' })])
    const result = await transport(REST)
    expect(result.ok && result.headers.etag).toBe('"abc"')
  })

  it('reads the token once across many calls', async () => {
    const { transport, tokenReads } = harness([reply(200)])
    await transport(GRAPHQL)
    await transport(GRAPHQL)
    await transport(REST)
    expect(tokenReads()).toBe(1)
  })

  it('re-reads the token once the TTL passes, so a gh auth logout shows as signed out', async () => {
    const signedOut: TokenRead = { ok: false, kind: 'unauthenticated', status: null, body: '', message: "gh isn't signed in to github.com" }
    const { transport, sent, tokenReads, advance } = harness([reply(200)], [{ ok: true, token: 't1' }, signedOut])
    expect((await transport(GRAPHQL)).ok).toBe(true)
    advance(29_999)
    expect((await transport(GRAPHQL)).ok).toBe(true)
    expect(tokenReads()).toBe(1)
    advance(1)
    expect(await transport(GRAPHQL)).toMatchObject({ ok: false, kind: 'unauthenticated', status: null })
    expect(tokenReads()).toBe(2)
    expect(sent).toHaveLength(2)
  })

  it('re-reads the token on a 401 and retries exactly once', async () => {
    const { transport, sent, tokenReads } = harness([reply(401, '{"message":"Bad credentials"}'), reply(200)], [{ ok: true, token: 'old' }, { ok: true, token: 'new' }])
    const result = await transport(GRAPHQL)
    expect(result.ok).toBe(true)
    expect(tokenReads()).toBe(2)
    expect(sent.map((request) => request.headers.Authorization)).toEqual(['Bearer old', 'Bearer new'])
  })

  it('a second 401 is unauthenticated, with no third request', async () => {
    const { transport, sent } = harness([reply(401, '{"message":"Bad credentials"}')], [{ ok: true, token: 'a' }, { ok: true, token: 'b' }])
    const result = await transport(GRAPHQL)
    expect(result).toMatchObject({ ok: false, kind: 'unauthenticated', status: 401, message: 'GitHub: Bad credentials (HTTP 401)' })
    expect(sent).toHaveLength(2)
  })

  it('a failed bootstrap is not cached, so the next call tries again', async () => {
    const { transport, tokenReads } = harness([reply(200)], [{ ok: false, kind: 'unauthenticated', status: null, body: '', message: "gh isn't signed in to github.com" }, { ok: true, token: 't' }])
    expect(await transport(GRAPHQL)).toMatchObject({ ok: false, kind: 'unauthenticated', status: null })
    expect((await transport(GRAPHQL)).ok).toBe(true)
    expect(tokenReads()).toBe(2)
  })

  it('passes a missing gh through verbatim and sends no request', async () => {
    const missing: TokenRead = { ok: false, kind: 'not-found', command: 'gh', searched: ['/usr/bin'] }
    const { transport, sent } = harness([reply(200)], [missing])
    expect(await transport(GRAPHQL)).toEqual(missing)
    expect(sent).toEqual([])
  })

  it('classifies a non-2xx response, keeping its body', async () => {
    const { transport } = harness([reply(422, '{"message":"Validation Failed"}')])
    expect(await transport(GRAPHQL)).toEqual({ ok: false, kind: 'unknown', status: 422, body: '{"message":"Validation Failed"}', message: 'GitHub: Validation Failed (HTTP 422)' })
  })

  it('words a failure without a JSON message by its status alone', async () => {
    const { transport } = harness([reply(502, '<html>bad gateway</html>')])
    expect(await transport(REST)).toMatchObject({ ok: false, kind: 'network', message: 'GitHub: HTTP 502' })
  })

  it('a fetch rejection is a network failure with no status', async () => {
    const { transport } = harness([() => Promise.reject(new TypeError('fetch failed'))])
    expect(await transport(REST)).toEqual({ ok: false, kind: 'network', status: null, body: '', message: 'GitHub is unreachable: fetch failed' })
  })

  it('an abort is a timeout', async () => {
    const { transport } = harness([() => Promise.reject(new DOMException('timed out', 'TimeoutError'))])
    expect(await transport(REST)).toEqual({ ok: false, kind: 'timeout', timeoutMs: 30_000, stderr: '' })
  })

  it('a body over the cap is output-too-large, never a truncated parse', async () => {
    const { transport } = harness([reply(200, 'x'.repeat(2048))], [{ ok: true, token: 't' }], { maxBytes: 1024 })
    expect(await transport(REST)).toEqual({ ok: false, kind: 'output-too-large', maxBytes: 1024 })
  })
})
