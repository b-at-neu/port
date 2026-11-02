// The only `fetch` caller under apps/desktop/src/main/. The token comes only from `gh auth token` and lives in process memory.
import { e2eFakePath, runCommand } from '@/main/platform/run'

import type { CommandResult, GhClassification, GitHubHttpResult, GitHubRequest, GitHubTransport } from '@/types/platform'

const API_BASE = 'https://api.github.com'
const TIMEOUT_MS = 30_000
const MAX_BYTES = 32 * 1024 * 1024
const TOKEN_TIMEOUT_MS = 8_000

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

export function createGitHubTransport(options: TransportOptions): GitHubTransport {
  let cached: Promise<TokenRead> | null = null

  function token(refresh: boolean): Promise<TokenRead> {
    if (refresh || cached === null) {
      const pending = options.readToken()
      cached = pending
      void pending.then((read) => {
        if (!read.ok && cached === pending) cached = null
      })
    }
    return cached
  }

  async function send(request: GitHubRequest, bearer: string): Promise<GitHubHttpResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      'User-Agent': 'port-desktop',
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: request.accept ?? 'application/vnd.github+json',
    }
    if (request.body !== undefined) headers['Content-Type'] = 'application/json'
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
      return toResult(response.status, lowered, text)
    } catch (error) {
      if (isAbort(error)) return { ok: false, kind: 'timeout', timeoutMs: options.timeoutMs, stderr: '' }
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, kind: 'network', status: null, body: '', message: `GitHub is unreachable: ${detail}` }
    }
  }

  return async (request) => {
    const first = await token(false)
    if (!first.ok) return first
    const result = await send(request, first.token)
    if (result.ok || result.kind !== 'unauthenticated' || result.status !== 401) return result

    const second = await token(true)
    if (!second.ok) return second
    return send(request, second.token)
  }
}

function fromFake(result: CommandResult): GitHubHttpResult {
  if (!result.ok) {
    if (result.kind !== 'nonzero') return result
    return { ok: false, kind: 'unknown', status: null, body: '', message: result.stderr.trim() }
  }
  try {
    const reply = JSON.parse(result.stdout) as { status: number; headers: Record<string, string>; body: string }
    return toResult(reply.status, reply.headers, reply.body)
  } catch {
    return { ok: false, kind: 'unknown', status: null, body: '', message: "the e2e fake's reply wasn't JSON" }
  }
}

const real = createGitHubTransport({ fetch, readToken: readGhToken, apiBase: API_BASE, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES })

/** Under E2E the request goes to the fake instead, so no host `gh` and no network are ever reached. */
export const githubHttp: GitHubTransport = async (request) => {
  if (e2eFakePath() === null) return real(request)
  return fromFake(await runCommand('gh', ['e2e-http', JSON.stringify(request)]))
}
