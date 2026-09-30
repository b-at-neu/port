// #97: two pure functions, both driven by the authoritative decision-case
// table (`classify.cases.json`, pinned by `desktop-runtime.ts` per
// ENGINEERING §2) — no I/O here, so every rung is exercised without a real
// `claude` binary or a real credentials file.
//
// Direction, stated once: ambiguous probe text resolves toward
// `unauthenticated`, never `policy-refused`. A wrong `unauthenticated` costs
// one `claude` login the operator was going to run anyway; a wrong
// `policy-refused` sends them to their account owner over what might be
// nothing but a stale token — the exact two-week failure #145 recorded.
// That is why the login-wording check below runs before the
// policy-wording check, not after.
import type { CredentialsTell, RuntimeDiagnosis } from '../../shared/runtime/types'

/** `now` is an explicit input, never `Date.now()` read internally, so both
 *  functions stay pure and `classify.cases.json` can encode a
 *  deterministic, permanently-valid "in the past" instant. */
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

/** The preflight ladder: `cli-missing` → `bundled-fallback` → `cli-unusable`
 *  → `token-stale` → otherwise `unverified`. `unverified` is a first-class
 *  state, not a synonym for ready — the cheap preflight can never prove
 *  auth works, only a completed turn can (ENGINEERING §4's "an absent
 *  signal is never read as a passing one" applied to the happy path). */
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

/** First match wins: the credentials tell, then OAuth/refresh wording →
 *  `token-stale`; login wording → `unauthenticated`; unambiguous
 *  policy/organization wording → `policy-refused`; otherwise
 *  `probe-failed`, carrying the underlying message verbatim (never
 *  invented — every worded sentence lives in the copy table instead). */
export function classifyProbeFailure(input: ClassifyProbeFailureInput): RuntimeDiagnosis {
  if (isTokenStale(input.credentials, input.now)) return 'token-stale'
  if (OAUTH_REFRESH_RE.test(input.text)) return 'token-stale'
  if (LOGIN_RE.test(input.text)) return 'unauthenticated'
  if (POLICY_RE.test(input.text)) return 'policy-refused'
  return 'probe-failed'
}
