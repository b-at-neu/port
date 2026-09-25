// Renderer-safe contract for the runtime strip (#97) — no import here may
// reach a Node builtin, the same rule `shared/claim/types.ts` states for
// itself: `main/runtime/` is the only place that resolves a path, spawns
// `claude`, or reads a credentials file, but the renderer strip is this
// ticket's consumer, so this file compiles under `tsconfig.web.json` too.

/** The minimum Claude Code CLI version this app expects (#97). Advisory
 *  only — the policy is "try it and see": `main/runtime/version.ts` never
 *  blocks on this, it only sets `belowMinimum`, which turns an otherwise
 *  opaque probe failure into a legible "update Claude Code" note. The only
 *  place this number is written; `version.ts` imports it rather than
 *  retyping the literal (`desktop-runtime` pins the single declaration). */
export const MINIMUM_CLAUDE_CODE_VERSION = '2.0.0'

/**
 * Every outcome the runtime adapter can report, from the cheap preflight and
 * the one-turn probe alike — each gets its own operator-facing copy entry
 * (`shared/runtime/copy.ts`), never a shared "error" catch-all:
 *
 * - `unverified` — the common, honest resting state. A cheap preflight can
 *   never prove auth works, only a completed turn can (ENGINEERING §4's "an
 *   absent signal is never read as a passing one" applied to the happy path).
 * - `verified` — a probe turn completed.
 * - `cli-missing` — `claude` could not be resolved anywhere `which` looked.
 * - `bundled-fallback` — the resolved path sits inside the Agent SDK's own
 *   bundled per-platform binary package, never the operator's own install.
 * - `cli-unusable` — resolved, but `claude --version` did not run or its
 *   output did not parse.
 * - `unauthenticated` — the CLI runs but reports no login.
 * - `token-stale` — `accessToken.expiresAt` is `0` or already past, with a
 *   refresh token still present — refreshable by a plain re-login, and the
 *   one #145 spent two weeks on: never reported as "API key required".
 * - `policy-refused` — the account's own policy disallows this, the one
 *   diagnosis that routes anywhere other than back to `claude`.
 * - `probe-failed` — the probe turn failed for a reason none of the above
 *   names; `detail` carries the underlying message verbatim.
 */
export type RuntimeDiagnosis = 'unverified' | 'verified' | 'cli-missing' | 'bundled-fallback' | 'cli-unusable' | 'unauthenticated' | 'token-stale' | 'policy-refused' | 'probe-failed'

/** Best-effort credentials tell (`main/runtime/credentials.ts`) — never a
 *  token value, and nothing here is logged. `present: false` is also the
 *  macOS Keychain case (no on-disk file at all), which is **not** evidence
 *  of being unauthenticated; it is `unknown`, and the classification ladder
 *  falls through to the probe rather than trusting it either way. */
export interface CredentialsTell {
  readonly present: boolean
  readonly expiresAt: number | null
  readonly hasRefreshToken: boolean
}

export interface ResolvedExecutable {
  readonly path: string
}

/** `raw` is the parsed `\d+\.\d+\.\d+` prefix of `claude --version`'s
 *  output, or `null` when nothing parsed out of it (that case alone is what
 *  drives `cli-unusable`, never `belowMinimum`). */
export interface VersionInfo {
  readonly raw: string | null
  readonly belowMinimum: boolean
}

/** `'runtime:preflight'`'s response — the composition root's own result
 *  (`main/runtime/preflight.ts`). There is no failure branch: every failure
 *  *is* a diagnosis. `detail` is always the underlying message verbatim;
 *  every invented sentence lives in the copy table instead. */
export interface RuntimePreflight {
  readonly checkedAt: string
  readonly executable: ResolvedExecutable | null
  readonly version: VersionInfo | null
  readonly credentials: CredentialsTell | null
  readonly apiKeyInEnvironment: boolean
  readonly diagnosis: RuntimeDiagnosis
  readonly detail: string | null
}

/** `'runtime:probe'`'s response — one `query()` turn against a registered
 *  repository. `repo` names which repository the probe actually ran
 *  against, so "Test connection" never silently picks one without saying
 *  which. */
export interface RuntimeProbe {
  readonly checkedAt: string
  readonly repo: string
  readonly elapsedMs: number
  readonly apiKeyInEnvironment: boolean
  readonly diagnosis: RuntimeDiagnosis
  readonly detail: string | null
}
