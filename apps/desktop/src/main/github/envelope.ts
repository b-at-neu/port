// Pure envelope parse and failure classification — no I/O. A GraphQL reply can carry errors beside
// usable data, so the envelope itself decides, never the status alone.
import type { GitHubHttpResult } from '@/types/platform'
import type { AliasInfo, EnvelopeFailureKind, GraphQLErrorEntry, SweepAlias, UnavailableAlias } from '@/types/github'

export interface GraphQLEnvelope {
  readonly data?: Readonly<Record<string, unknown>> | null
  readonly errors?: readonly GraphQLErrorEntry[]
}

/** The reply body when there is one; a classified failure keeps its body, a transport failure has none. */
export function bodyOf(result: GitHubHttpResult): string | undefined {
  return 'body' in result ? result.body : undefined
}

/** The read-side counterpart of `release.ts`'s `describe`, which stays on `GhResult` for the writes. */
export function describeHttp(result: Exclude<GitHubHttpResult, { ok: true }>): string {
  if ('message' in result && result.kind !== 'spawn-failed') return result.message
  if (result.kind === 'not-found') return "gh isn't on PATH"
  if (result.kind === 'spawn-failed') return result.message
  return result.kind
}

type ParsedEnvelope = { readonly ok: true; readonly value: GraphQLEnvelope } | { readonly ok: false }

/** `JSON.parse`, guarded against a non-object top level (an array or a bare
 *  primitive is not a GraphQL envelope, whatever `JSON.parse` makes of it). */
export function parseEnvelope(raw: string): ParsedEnvelope {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

type FailureVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: Exclude<GitHubHttpResult, { ok: true }>['kind'] | EnvelopeFailureKind; readonly message: string }

/** Classification order, first match wins: a failed token bootstrap, any non-`unknown` classified
 *  status, then the envelope itself (a partial response is `unavailable` per alias, not a failure). */
export function classifyFailure(result: GitHubHttpResult, envelope: ParsedEnvelope | undefined): FailureVerdict {
  if (!result.ok) {
    switch (result.kind) {
      case 'not-found':
        return { kind: 'not-found', message: `gh isn't on PATH — looked in ${result.searched.length} places` }
      case 'cwd-missing':
        return { kind: 'cwd-missing', message: `working directory does not exist: ${result.cwd}` }
      case 'signalled':
        return { kind: 'signalled', message: `gh was killed by signal ${result.signal}` }
      case 'timeout':
        return { kind: 'timeout', message: `GitHub didn't reply within ${result.timeoutMs}ms` }
      case 'output-too-large':
        return { kind: 'output-too-large', message: `GitHub's reply exceeded ${result.maxBytes} bytes` }
      case 'spawn-failed':
        return { kind: 'spawn-failed', message: result.message }
      case 'unauthenticated':
      case 'rate-limited':
      case 'forbidden':
      case 'http-not-found':
      case 'network':
        return { kind: result.kind, message: result.message }
      case 'unknown':
        break // fall through to the envelope check below
      default: {
        const _exhaustive: never = result
        return { kind: 'unknown', message: `unhandled GitHub classification: ${(_exhaustive as { kind: string }).kind}` }
      }
    }
  }

  if (envelope === undefined || !envelope.ok) {
    if (!result.ok) return { kind: 'unknown', message: result.message }
    return { kind: 'unparseable', message: "GitHub's reply wasn't JSON" }
  }

  const body = envelope.value
  if (body.errors?.some((error) => error.type === 'RATE_LIMITED')) {
    return { kind: 'rate-limited', message: 'GitHub reports the rate limit is exhausted' }
  }
  if (body.data === undefined || body.data === null) {
    return { kind: 'no-data', message: 'the response carried no data — a blind fetch' }
  }
  if (body.data.repository === null) {
    return { kind: 'repo-not-found', message: 'the repository does not exist, or is not visible to this token' }
  }
  return { kind: 'ok' }
}

/** Maps `errors[].path` to the alias table built alongside the query, so a partial failure
 *  names the surface rather than a bare alias string. */
export function collectUnavailable(errors: readonly GraphQLErrorEntry[] | undefined, aliasIndex: ReadonlyMap<SweepAlias, AliasInfo>): readonly UnavailableAlias[] {
  if (!errors) return []
  const seen = new Set<SweepAlias>()
  const result: UnavailableAlias[] = []
  for (const error of errors) {
    const alias = error.path?.[1]
    if (alias !== 'issues' && alias !== 'pullRequests') continue
    if (seen.has(alias)) continue
    const info = aliasIndex.get(alias)
    if (!info) continue
    seen.add(alias)
    result.push({ alias, surface: info.surface })
  }
  return result
}
