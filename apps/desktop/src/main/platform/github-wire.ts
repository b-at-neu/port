// Pure: classifies a GitHub HTTP response into the app's result shapes. No import from run.ts, so a route can use it without a cycle.
import type { ConditionalHttpResult, GhClassification, GitHubHttpResult } from '@/types/platform'

export type HttpFailure = Exclude<GitHubHttpResult, { ok: true }>

/** A response before classification, so a 304 keeps its headers. */
export type Exchange = { readonly ok: true; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string } | HttpFailure

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

export function toResult(status: number, headers: Readonly<Record<string, string>>, body: string): GitHubHttpResult {
  const kind = classifyHttpStatus(status, headers, body)
  if (kind === 'ok') return { ok: true, status, headers, body }
  return { ok: false, kind, status, body, message: messageOf(status, body) }
}

export function toConditionalResult(exchange: Exchange, validatorSent: boolean): ConditionalHttpResult {
  if (!exchange.ok) return exchange
  if (exchange.status === 304 && validatorSent) return { ok: true, notModified: true, status: 304, headers: exchange.headers }
  const result = toResult(exchange.status, exchange.headers, exchange.body)
  return result.ok ? { ok: true, notModified: false, status: result.status, headers: result.headers, body: result.body } : result
}
