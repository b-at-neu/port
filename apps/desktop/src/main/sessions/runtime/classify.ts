// Two pure functions, driven by the decision-case table — no I/O, so every rung is exercised without a real `claude` binary.
//
// Ambiguous probe text resolves toward `unauthenticated`, never `policy-refused`: a wrong `unauthenticated` costs one login, a wrong `policy-refused` sends the operator to their account owner over what might be a stale token.
import type { RuntimeDiagnosis } from '@/types/runtime'

export interface ClassifyPreflightInput {
  readonly locate: 'found' | 'not-found' | 'bundled-fallback'
  readonly versionUsable: boolean
}

/** `unverified` is a first-class state, not a synonym for ready — the cheap preflight can never prove auth works, only a completed turn can. */
export function classifyPreflight(input: ClassifyPreflightInput): RuntimeDiagnosis {
  if (input.locate === 'not-found') return 'cli-missing'
  if (input.locate === 'bundled-fallback') return 'bundled-fallback'
  if (!input.versionUsable) return 'cli-unusable'
  return 'unverified'
}

const REFRESH_FAILED_RE =
  /\b(?:refresh[ -]?token|token[ -]?refresh)\b[^.\n]{0,40}\b(?:fail(?:ed|ure)?|expired|invalid|revoked|rejected)\b|\b(?:fail(?:ed|ure)?|unable|could ?not|couldn't)\b[^.\n]{0,40}\brefresh\b|\boauth token (?:has )?expired\b/i
const LOGIN_RE = /\blog(?:in|ged in|ged-in)?\b|\/login\b|\bunauthenticated\b|\bapi key\b/i
const POLICY_RE = /\bpolicy\b|\bnot permitted\b|\borganization\b|\baccount (?:owner|admin)\b/i

export interface ClassifyProbeFailureInput {
  readonly text: string
}

/** First match wins; `probe-failed` carries the underlying message verbatim, never invented. */
export function classifyProbeFailure(input: ClassifyProbeFailureInput): RuntimeDiagnosis {
  if (REFRESH_FAILED_RE.test(input.text)) return 'token-stale'
  if (LOGIN_RE.test(input.text)) return 'unauthenticated'
  if (POLICY_RE.test(input.text)) return 'policy-refused'
  return 'probe-failed'
}
