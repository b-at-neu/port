// The only `fetch` caller under apps/desktop/src/main/. The token comes only from `gh auth token` and lives in process memory for a short TTL, so a `gh auth logout` is noticed; one transport reads public data with no token at all.
import { e2eFakePath, runCommand } from '@/main/platform/run'

import type { CommandResult, ConditionalHttpResult, ConditionalTransport, GhClassification, GitHubHttpResult, GitHubTransport } from '@/types/platform'

export const DEFAULT_ACCEPT = 'application/vnd.github+json'
const API_BASE = 'https://api.github.com'
const TIMEOUT_MS = 30_000
const MAX_BYTES = 32 * 1024 * 1024
const TOKEN_TIMEOUT_MS = 8_000
const TOKEN_TTL_MS = 30_000

type HttpFailure = Exclude<GitHubHttpResult, { ok: true }>

type TokenRead = { readonly ok: true; readonly token: string } | HttpFailure

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  readonly status: number
  readonly headers: { forEach(callback: (value: string, key: string) => void): void }
  text(): Promise<string>
}>

interface TransportOptions {
  readonly fetch: FetchLike
  readonly readToken: () => Promise<TokenRead>
  readonly now: () => number
  readonly tokenTtlMs: number
  readonly apiBase: string
  readonly timeoutMs: number
  readonly maxBytes: number
}

/** First match wins; a 403 is rate-limited only on an explicit signal, never assumed. */
export function classifyHttpStatus(status: number, headers: Readonly<Record<string, string>>, body: string): GhClassification | 'ok' {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'unauthenticated'
  if (status === 403) {
    const limited = headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined || /rate limit/i.test(body)
    return limited ? 'rate-limited' : 'forbidden'
  }
  if (status === 429) return 'rate-limited'
  if (status === 404) return 'http-not-found'
  if (status >= 500 && status < 600) return 'network'
  return 'unknown'
}

function messageOf(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    const message = typeof parsed === 'object' && parsed !== null ? (parsed as { message?: unknown }).message : undefined
    if (typeof message === 'string' && message !== '') return `GitHub: ${message} (HTTP ${status})`
  } catch {
    // a non-JSON body carries no message
  }
  return `GitHub: HTTP ${status}`
}

function toResult(status: number, headers: Readonly<Record<string, string>>, body: string): GitHubHttpResult {
  const kind = classifyHttpStatus(status, headers, body)
  if (kind === 'ok') return { ok: true, status, headers, body }
  return { ok: false, kind, status, body, message: messageOf(status, body) }
}

function unauthenticated(message: string): HttpFailure {
  return { ok: false, kind: 'unauthenticated', status: null, body: '', message }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ((error as { name?: unknown }).name === 'TimeoutError' || (error as { name?: unknown }).name === 'AbortError')
}

async function readGhToken(): Promise<TokenRead> {
  const result = await runCommand('gh', ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: TOKEN_TIMEOUT_MS })
  if (result.ok) {
    const token = result.stdout.trim()
    return token === '' ? unauthenticated("gh isn't signed in to github.com") : { ok: true, token }
  }
  if (result.kind === 'nonzero') return unauthenticated("gh isn't signed in to github.com")
  return result
}

/** A response before classification, so a 304 keeps its headers. */
type Exchange = { readonly ok: true; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string } | HttpFailure

interface WireRequest {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly accept?: string
  readonly body?: string
  readonly ifNoneMatch?: string
}

function toConditionalResult(exchange: Exchange, validatorSent: boolean): ConditionalHttpResult {
  if (!exchange.ok) return exchange
  if (exchange.status === 304 && validatorSent) return { ok: true, notModified: true, status: 304, headers: exchange.headers }
  const result = toResult(exchange.status, exchange.headers, exchange.body)
  return result.ok ? { ok: true, notModified: false, status: result.status, headers: result.headers, body: result.body } : result
}

/** `request` and `conditional` share one token memo and one 401 re-read-and-retry-once; `public` sends no token at all. */
export function createGitHubClient(options: TransportOptions): { readonly request: GitHubTransport; readonly conditional: ConditionalTransport; readonly public: GitHubTransport } {
  let cached: Promise<TokenRead> | null = null
  let readAt = 0

  function token(refresh: boolean): Promise<TokenRead> {
    if (refresh || cached === null || options.now() - readAt >= options.tokenTtlMs) {
      const pending = options.readToken()
      cached = pending
      readAt = options.now()
      void pending.then((read) => {
        if (!read.ok && cached === pending) cached = null
      })
    }
    return cached
  }

  async function send(request: WireRequest, bearer: string | null): Promise<Exchange> {
    const headers: Record<string, string> = {
      'User-Agent': 'port-desktop',
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: request.accept ?? DEFAULT_ACCEPT,
    }
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`
    if (request.body !== undefined) headers['Content-Type'] = 'application/json'
    if (request.ifNoneMatch !== undefined) headers['If-None-Match'] = request.ifNoneMatch
    try {
      const response = await options.fetch(`${options.apiBase}/${request.path}`, {
        method: request.method,
        headers,
        body: request.body,
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      const text = await response.text()
      if (Buffer.byteLength(text) > options.maxBytes) return { ok: false, kind: 'output-too-large', maxBytes: options.maxBytes }
      const lowered: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        lowered[key.toLowerCase()] = value
      })
      return { ok: true, status: response.status, headers: lowered, body: text }
    } catch (error) {
      if (isAbort(error)) return { ok: false, kind: 'timeout', timeoutMs: options.timeoutMs, stderr: '' }
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, kind: 'network', status: null, body: '', message: `GitHub is unreachable: ${detail}` }
    }
  }

  async function exchange(request: WireRequest): Promise<Exchange> {
    const first = await token(false)
    if (!first.ok) return first
    const result = await send(request, first.token)
    if (!result.ok || result.status !== 401) return result

    const second = await token(true)
    if (!second.ok) return second
    return send(request, second.token)
  }

  return {
    request: async (request) => {
      const result = await exchange(request)
      return result.ok ? toResult(result.status, result.headers, result.body) : result
    },
    conditional: async (request) => toConditionalResult(await exchange(request), request.ifNoneMatch !== undefined),
    public: async (request) => {
      const result = await send(request, null)
      return result.ok ? toResult(result.status, result.headers, result.body) : result
    },
  }
}

export function createGitHubTransport(options: TransportOptions): GitHubTransport {
  return createGitHubClient(options).request
}

function fromFake(result: CommandResult): Exchange {
  if (!result.ok) {
    if (result.kind !== 'nonzero') return result
    return { ok: false, kind: 'unknown', status: null, body: '', message: result.stderr.trim() }
  }
  try {
    const reply = JSON.parse(result.stdout) as { status: number; headers: Record<string, string>; body: string }
    return { ok: true, status: reply.status, headers: reply.headers, body: reply.body }
  } catch {
    return { ok: false, kind: 'unknown', status: null, body: '', message: "the e2e fake's reply wasn't JSON" }
  }
}

const real = createGitHubClient({ fetch, readToken: readGhToken, now: Date.now, tokenTtlMs: TOKEN_TTL_MS, apiBase: API_BASE, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES })

/** Under E2E the request goes to the fake instead, so no host `gh` and no network are ever reached. */
export const githubHttp: GitHubTransport = async (request) => {
  if (e2eFakePath() === null) return real.request(request)
  const reply = fromFake(await runCommand('gh', ['e2e-http', JSON.stringify(request)]))
  return reply.ok ? toResult(reply.status, reply.headers, reply.body) : reply
}

export const githubConditional: ConditionalTransport = async (request) => {
  if (e2eFakePath() === null) return real.conditional(request)
  return toConditionalResult(fromFake(await runCommand('gh', ['e2e-http', JSON.stringify(request)])), request.ifNoneMatch !== undefined)
}

/** No token, no 401 retry: only for reads of public data such as the app's own releases. */
export const githubPublic: GitHubTransport = async (request) => {
  if (e2eFakePath() === null) return real.public(request)
  const reply = fromFake(await runCommand('gh', ['e2e-http', JSON.stringify(request)]))
  return reply.ok ? toResult(reply.status, reply.headers, reply.body) : reply
}
