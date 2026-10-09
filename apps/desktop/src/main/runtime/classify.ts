// Two pure functions, driven by the decision-case table — no I/O, so every rung is exercised without a real `claude` binary or credentials file.
//
// Ambiguous probe text resolves toward `unauthenticated`, never `policy-refused`: a wrong `unauthenticated` costs one login, a wrong `policy-refused` sends the operator to their account owner over what might be a stale token.
import type { CredentialsTell, RuntimeDiagnosis } from '../../shared/runtime/types'

/** `now` is explicit, never `Date.now()` read internally, so both functions stay pure. */
function isTokenStale(tell: CredentialsTell | null, now: number): boolean {
  if (tell === null || !tell.present || !tell.hasRefreshToken) return false
  return tell.expiresAt !== null && tell.expiresAt <= now
}

export interface ClassifyPreflightInput {
  readonly locate: 'found' | 'not-found' | 'bundled-fallback'
  readonly versionUsable: boolean
  readonly credentials: CredentialsTell | null
  readonly now: number
}

/** `unverified` is a first-class state, not a synonym for ready — the cheap preflight can never prove auth works, only a completed turn can. */
export function classifyPreflight(input: ClassifyPreflightInput): RuntimeDiagnosis {
  if (input.locate === 'not-found') return 'cli-missing'
  if (input.locate === 'bundled-fallback') return 'bundled-fallback'
  if (!input.versionUsable) return 'cli-unusable'
  if (isTokenStale(input.credentials, input.now)) return 'token-stale'
  return 'unverified'
}

const OAUTH_REFRESH_RE = /\boauth\b|\brefresh[ -]?token\b|\btoken[ -]?refresh\b/i
const LOGIN_RE = /\blog(?:in|ged in|ged-in)?\b|\/login\b|\bunauthenticated\b|\bapi key\b/i
const POLICY_RE = /\bpolicy\b|\bnot permitted\b|\borganization\b|\baccount (?:owner|admin)\b/i

export interface ClassifyProbeFailureInput {
  readonly text: string
  readonly credentials: CredentialsTell | null
  readonly now: number
}

/** First match wins; `probe-failed` carries the underlying message verbatim, never invented. */
export function classifyProbeFailure(input: ClassifyProbeFailureInput): RuntimeDiagnosis {
  if (isTokenStale(input.credentials, input.now)) return 'token-stale'
  if (OAUTH_REFRESH_RE.test(input.text)) return 'token-stale'
  if (LOGIN_RE.test(input.text)) return 'unauthenticated'
  if (POLICY_RE.test(input.text)) return 'policy-refused'
  return 'probe-failed'
}
