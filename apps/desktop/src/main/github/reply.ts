// One GraphQL round trip's reply, shared by both halves of the board read: the envelope decides, never the status alone.
import type { GitHubTransport } from '@/types/platform'
import type { GitHubRepoRef, GraphQLErrorEntry, RateLimitInfo, ReadFailure } from '@/types/github'
import { bodyOf, classifyFailure, parseEnvelope } from '@/main/github/envelope'
import { repoGraphqlRequest } from '@/main/github/request'

type Reply =
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>>; readonly repository: Readonly<Record<string, unknown>>; readonly errors: readonly GraphQLErrorEntry[] | undefined }
  | ReadFailure

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : undefined
}

/** `undefined`, never zeros, when the reply carried no `rateLimit` at all. */
function readRateLimit(value: unknown): RateLimitInfo | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  return {
    cost: typeof raw.cost === 'number' ? raw.cost : 0,
    remaining: typeof raw.remaining === 'number' ? raw.remaining : 0,
    resetAt: typeof raw.resetAt === 'string' ? raw.resetAt : '',
    limit: typeof raw.limit === 'number' ? raw.limit : 0,
  }
}

export const NO_RATE_LIMIT: RateLimitInfo = { cost: 0, remaining: 0, resetAt: '', limit: 0 }

/** `cost` sums every round trip; the other fields come from the last reply that carried them. */
export function addRateLimit(total: RateLimitInfo, reply: unknown): RateLimitInfo {
  const read = readRateLimit(reply)
  if (read === undefined) return total
  return { ...read, cost: total.cost + read.cost }
}

export async function graphql(github: GitHubTransport, repo: GitHubRepoRef, document: string): Promise<Reply> {
  const result = await github(repoGraphqlRequest(document, repo))
  const text = bodyOf(result)
  const parsed = text !== undefined ? parseEnvelope(text) : undefined
  const verdict = classifyFailure(result, parsed)

  if (verdict.kind !== 'ok') return { ok: false, kind: verdict.kind, message: verdict.message }
  // Re-checked here rather than asserted, so a contract violation is a reported value, never thrown.
  if (parsed === undefined || !parsed.ok) return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without a parsed envelope' }
  const body = parsed.value
  const repository = asRecord(body.data?.repository)
  if (body.data === undefined || body.data === null || repository === undefined) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without usable repository data' }
  }
  return { ok: true, data: body.data, repository, errors: body.errors }
}

export const DETAIL_CHUNK_SIZE = 100
export const MAX_SWEEP_PAGES = 10
