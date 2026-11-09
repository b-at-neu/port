import type { ConditionalHttpResult, ConditionalRequest, ConditionalTransport, GhClassification, GitHubHttpResult, GitHubRequest, GitHubTransport } from '@/types/platform'

export function httpOk(body: string, headers: Readonly<Record<string, string>> = {}): GitHubHttpResult {
  return { ok: true, status: 200, headers, body }
}

export function httpFail(kind: GhClassification, status: number, body = '', message = `GitHub: HTTP ${status}`): Exclude<GitHubHttpResult, { ok: true }> {
  return { ok: false, kind, status, body, message }
}

export function fakeTransport(result: GitHubHttpResult): GitHubTransport {
  return () => Promise.resolve(result)
}

export interface RecordingTransport {
  readonly transport: GitHubTransport
  readonly requests: GitHubRequest[]
}

/** Answers each request from `reply`, a bare string being a 200 body. */
export function recordingTransport(reply: (request: GitHubRequest, index: number) => GitHubHttpResult | string): RecordingTransport {
  const requests: GitHubRequest[] = []
  const transport: GitHubTransport = (request) => {
    const answer = reply(request, requests.length)
    requests.push(request)
    return Promise.resolve(typeof answer === 'string' ? httpOk(answer) : answer)
  }
  return { transport, requests }
}

export function httpNotModified(headers: Readonly<Record<string, string>> = {}): ConditionalHttpResult {
  return { ok: true, notModified: true, status: 304, headers }
}

export interface RecordingConditionalTransport {
  readonly transport: ConditionalTransport
  readonly requests: ConditionalRequest[]
}

/** Answers each request from `reply`, recording it first so a test can read the `ifNoneMatch` it sent. */
export function recordingConditionalTransport(reply: (request: ConditionalRequest, index: number) => ConditionalHttpResult): RecordingConditionalTransport {
  const requests: ConditionalRequest[] = []
  const transport: ConditionalTransport = (request) => {
    const answer = reply(request, requests.length)
    requests.push(request)
    return Promise.resolve(answer)
  }
  return { transport, requests }
}

interface GraphqlBody {
  readonly query: string
  readonly variables: Readonly<Record<string, string>>
}

export function graphqlBodyOf(request: GitHubRequest | undefined): GraphqlBody {
  if (request === undefined) throw new Error('no request was recorded')
  return JSON.parse(request.body ?? '{}') as GraphqlBody
}

export function queryOf(request: GitHubRequest | undefined): string {
  return graphqlBodyOf(request).query
}
