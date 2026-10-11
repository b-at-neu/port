// Renderer-safe contract for the runtime strip. No import here may reach a Node builtin — only `main/runtime/` resolves a path, spawns `claude`, or reads a credentials file.

/** The minimum Claude Code CLI version this app expects. Advisory only — `version.ts` never blocks on it, only sets `belowMinimum`, turning an opaque probe failure into a legible note. */
export const MINIMUM_CLAUDE_CODE_VERSION = '2.0.0'

/** Every outcome the runtime adapter can report, each with its own operator-facing copy entry, never a shared "error" catch-all. `unverified` is the honest resting state since only a completed turn can prove auth works; `token-stale` is refreshable by a plain re-login, never reported as "API key required"; `policy-refused` is the one diagnosis that routes to the account owner rather than back to `claude`. */
export type RuntimeDiagnosis = 'unverified' | 'verified' | 'cli-missing' | 'bundled-fallback' | 'cli-unusable' | 'unauthenticated' | 'token-stale' | 'policy-refused' | 'probe-failed'

/** Best-effort credentials tell — never a token value, nothing here is logged. `present: false` includes the macOS Keychain case and is not evidence of being unauthenticated. */
export interface CredentialsTell {
  readonly present: boolean
  readonly expiresAt: number | null
  readonly hasRefreshToken: boolean
}

export interface ResolvedExecutable {
  readonly path: string
}

/** `raw` is the parsed `\d+\.\d+\.\d+` prefix of `claude --version`'s output, or `null` when nothing parsed — that case alone drives `cli-unusable`, never `belowMinimum`. */
export interface VersionInfo {
  readonly raw: string | null
  readonly belowMinimum: boolean
}

/** `'runtime:preflight'`'s response. There is no failure branch: every failure *is* a diagnosis. `detail` is always the underlying message verbatim. */
export interface RuntimePreflight {
  readonly checkedAt: string
  readonly executable: ResolvedExecutable | null
  readonly version: VersionInfo | null
  readonly credentials: CredentialsTell | null
  readonly apiKeyInEnvironment: boolean
  readonly diagnosis: RuntimeDiagnosis
  readonly detail: string | null
}

/** `'runtime:probe'`'s response — one `query()` turn, against a registered repository or an app-owned scratch directory. `repo` names which repository the probe ran against; `null` is repository-free mode. */
export interface RuntimeProbe {
  readonly checkedAt: string
  readonly repo: string | null
  readonly elapsedMs: number
  readonly apiKeyInEnvironment: boolean
  readonly diagnosis: RuntimeDiagnosis
  readonly detail: string | null
}
