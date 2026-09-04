import { runCommand } from './run'
import type { CommandResult, RunCommandOptions } from './run'

export type GhOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

export type GhClassification = 'unauthenticated' | 'rate-limited' | 'forbidden' | 'http-not-found' | 'network' | 'unknown'

export interface GhExitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Pure and unit-testable without spawning `gh` — `gh.test.ts` drives this
 * directly. Classification order, first match wins:
 * 1. exit code `4` → `unauthenticated` (gh's documented auth exit code, ahead
 *    of any string match).
 * 2. `(HTTP <nnn>)` parsed from stdout/stderr.
 * 3. stderr naming a DNS or connection failure → `network`.
 * 4. otherwise → `unknown`, carrying stderr verbatim — never coerced into an
 *    empty success.
 */
export function classifyGhExit(outcome: GhExitOutcome): GhClassification {
  if (outcome.code === 4) return 'unauthenticated'

  const text = `${outcome.stderr}\n${outcome.stdout}`
  const httpMatch = /\(HTTP (\d+)\)/.exec(text)
  if (httpMatch) {
    const status = Number(httpMatch[1] ?? '')
    if (status === 401) return 'unauthenticated'
    if (status === 403) return /rate limit/i.test(text) ? 'rate-limited' : 'forbidden'
    if (status === 429) return 'rate-limited'
    if (status === 404) return 'http-not-found'
    if (status >= 500 && status < 600) return 'network'
  }

  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|dial tcp|no such host|network is unreachable/i.test(text)) {
    return 'network'
  }

  return 'unknown'
}

export type GhResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | Exclude<CommandResult, { ok: true } | { ok: false; kind: 'nonzero' }>
  | { readonly ok: false; readonly kind: GhClassification; readonly stderr: string }

/** `gh(args)` — never spawned by an adapter directly; a second failure
 *  classifier at a call site would drift from this one over time. The layer
 *  never reads, stores, or logs a token. */
export async function gh(args: readonly string[], options: GhOptions = {}): Promise<GhResult> {
  const result = await runCommand('gh', args, options)
  if (result.ok) return result
  if (result.kind !== 'nonzero') return result
  const kind = classifyGhExit({ code: result.code, stdout: result.stdout, stderr: result.stderr })
  return { ok: false, kind, stderr: result.stderr }
}

export type GhJsonResult<T> = { readonly ok: true; readonly data: T } | Exclude<GhResult, { ok: true }> | { readonly ok: false; readonly kind: 'unparseable'; readonly stdout: string }

/** Parses stdout and returns `unparseable` with the raw stdout on failure —
 *  never `null`, which a caller could otherwise mistake for a real value. */
export async function ghJson<T>(args: readonly string[], options?: GhOptions): Promise<GhJsonResult<T>> {
  const result = await gh(args, options)
  if (!result.ok) return result
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T }
  } catch {
    return { ok: false, kind: 'unparseable', stdout: result.stdout }
  }
}

export type GhAuthStatusResult = { readonly ok: true; readonly authenticated: boolean } | Exclude<GhResult, { ok: true } | { ok: false; kind: 'unauthenticated' }>

/** Runs `gh auth status` and reads its own exit code directly — 0 is
 *  authenticated, any other nonzero exit is not — rather than routing
 *  through `classifyGhExit`, which is tuned for HTTP-bearing API failures
 *  and never sees an `(HTTP nnn)` string or exit code `4` from this
 *  command. No token is ever buffered or inspected either way. */
export async function ghAuthStatus(options?: GhOptions): Promise<GhAuthStatusResult> {
  const result = await runCommand('gh', ['auth', 'status'], options)
  if (result.ok) return { ok: true, authenticated: true }
  if (result.kind === 'nonzero') return { ok: true, authenticated: false }
  return result
}
