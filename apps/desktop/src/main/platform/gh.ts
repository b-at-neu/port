import { runCommand } from '@/main/platform/run'

import type { GhAuthStatusResult, GhResult } from '@/types/platform'
import type { RunCommandOptions } from '@/types/platform'

type GhOptions = Omit<RunCommandOptions, 'whichEnv' | 'platform'>

type GhClassification = 'unauthenticated' | 'rate-limited' | 'forbidden' | 'http-not-found' | 'network' | 'unknown'

interface GhExitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

// Classification order, first match wins: exit code 4 (gh's documented auth code) before any
// string match, then HTTP status, then a DNS/connection failure, else `unknown` verbatim.
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

// `stdout` is preserved on the classified-failure branch: `gh api graphql` exits non-zero whenever
// the response carries `errors`, even when `data` is still usable.
export async function gh(args: readonly string[], options: GhOptions = {}): Promise<GhResult> {
  const result = await runCommand('gh', args, options)
  if (result.ok) return result
  if (result.kind !== 'nonzero') return result
  const kind = classifyGhExit({ code: result.code, stdout: result.stdout, stderr: result.stderr })
  return { ok: false, kind, stdout: result.stdout, stderr: result.stderr }
}

type GhJsonResult<T> = { readonly ok: true; readonly data: T } | Exclude<GhResult, { ok: true }> | { readonly ok: false; readonly kind: 'unparseable'; readonly stdout: string }

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

/** Reads the exit code directly rather than routing through `classifyGhExit`, which is tuned
 *  for HTTP-bearing API failures this command never produces. */
export async function ghAuthStatus(options?: GhOptions): Promise<GhAuthStatusResult> {
  const result = await runCommand('gh', ['auth', 'status'], options)
  if (result.ok) return { ok: true, authenticated: true, output: `${result.stdout}\n${result.stderr}` }
  if (result.kind === 'nonzero') return { ok: true, authenticated: false, output: `${result.stdout}\n${result.stderr}` }
  return result
}

