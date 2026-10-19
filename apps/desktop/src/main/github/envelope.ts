// Pure envelope parse and failure classification — no I/O. gh api graphql exits non-zero whenever
// the response carries errors, even when data is still usable, so the envelope itself decides.
import type { GhResult } from '@/types/platform'
import type { AliasInfo, EnvelopeFailureKind, GraphQLErrorEntry, SweepAlias, UnavailableAlias } from '@/types/github'

export interface GraphQLEnvelope {
  readonly data?: Readonly<Record<string, unknown>> | null
  readonly errors?: readonly GraphQLErrorEntry[]
}

export function stdoutOf(result: GhResult): string | undefined {
  return 'stdout' in result ? result.stdout : undefined
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
  | { readonly kind: Exclude<GhResult, { ok: true }>['kind'] | EnvelopeFailureKind; readonly message: string }

/** Classification order, first match wins: an unresolved `gh` binary, any non-`unknown` classified
 *  exit, then the envelope itself (a partial response is `unavailable` per alias, not a failure). */
export function classifyFailure(ghResult: GhResult, envelope: ParsedEnvelope | undefined): FailureVerdict {
  if (!ghResult.ok) {
    switch (ghResult.kind) {
      case 'not-found':
        return { kind: 'not-found', message: `gh isn't on PATH — looked in ${ghResult.searched.length} places` }
      case 'cwd-missing':
        return { kind: 'cwd-missing', message: `working directory does not exist: ${ghResult.cwd}` }
      case 'signalled':
        return { kind: 'signalled', message: `gh was killed by signal ${ghResult.signal}` }
      case 'timeout':
        return { kind: 'timeout', message: `gh timed out after ${ghResult.timeoutMs}ms` }
      case 'output-too-large':
        return { kind: 'output-too-large', message: `gh's output exceeded ${ghResult.maxBytes} bytes` }
      case 'spawn-failed':
        return { kind: 'spawn-failed', message: ghResult.message }
      case 'unauthenticated':
      case 'rate-limited':
      case 'forbidden':
      case 'http-not-found':
      case 'network':
        return { kind: ghResult.kind, message: ghResult.stderr }
      case 'unknown':
        break // fall through to the envelope check below
      default: {
        const _exhaustive: never = ghResult
        return { kind: 'unknown', message: `unhandled gh classification: ${(_exhaustive as { kind: string }).kind}` }
      }
    }
  }

  if (envelope === undefined || !envelope.ok) {
    if (!ghResult.ok) return { kind: 'unknown', message: ghResult.stderr }
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
