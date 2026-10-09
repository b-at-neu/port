// The runtime strip's operator-facing copy table — one entry per `RuntimeDiagnosis`, never a shared "error" catch-all. A new diagnosis is a compile error here, never a silently blank line.
import type { RuntimeDiagnosis } from './types'

/** What kind of remedy a diagnosis implies — `retry` covers "try again"; `login`/`update` name a concrete external step; `account-owner` names one the app cannot offer as a button. Never an `'api-key'` member. */
export type RuntimeAction = 'install' | 'login' | 'update' | 'account-owner' | 'retry'

export interface RuntimeCopy {
  readonly title: string
  readonly body: string
  readonly action: RuntimeAction | null
}

/** Every `RuntimeDiagnosis` member, both directions pinned. Ambiguous probe text resolves toward `unauthenticated`, never `policy-refused`: a wrong `unauthenticated` costs one login, while a wrong `policy-refused` sends the operator to their account owner over what might be a stale token. */
export const RUNTIME_COPY: Readonly<Record<RuntimeDiagnosis, RuntimeCopy>> = {
  unverified: {
    title: 'Not verified yet',
    body: 'A test runs one short turn against a registered repository.',
    action: null,
  },
  verified: {
    title: 'Verified',
    body: 'The last test turn completed successfully.',
    action: null,
  },
  'cli-missing': {
    title: "Claude Code isn't installed, or isn't on this app's PATH.",
    body: "Install it, then retry. If it's installed somewhere unusual, set PORT_CLAUDE_PATH to its full path.",
    action: 'install',
  },
  'bundled-fallback': {
    title: "Refusing the SDK's bundled binary.",
    body: 'The resolved path is inside the Agent SDK package. Point PORT_CLAUDE_PATH at your own installed claude.',
    action: 'retry',
  },
  'cli-unusable': {
    title: "Found claude, but it didn't run.",
    body: 'See the detail below for what the CLI reported.',
    action: 'retry',
  },
  unauthenticated: {
    title: "Claude Code isn't logged in.",
    body: 'Run claude in a terminal and log in, then retry.',
    action: 'login',
  },
  'token-stale': {
    title: 'Your Claude Code login needs refreshing.',
    body: "The stored token can't be refreshed. Run claude in a terminal and log in again, then retry.",
    action: 'login',
  },
  'policy-refused': {
    title: "Your account isn't permitted to use Claude Code this way.",
    body: "This isn't something logging in again will fix — check with whoever owns the account policy.",
    action: 'account-owner',
  },
  'probe-failed': {
    title: 'The test turn failed.',
    body: 'See the detail below for what went wrong.',
    action: 'retry',
  },
}

/** The one advisory line shown beside another diagnosis, never alone as a block — not itself a `RuntimeDiagnosis`, since an old CLI still gets a real probe. */
export const CLI_OUTDATED_COPY: RuntimeCopy = {
  title: 'Claude Code is older than the version this app expects.',
  body: 'It may still work — this is advisory only.',
  action: 'update',
}

/** Shared by the runtime strip and the Settings screen so there is one copy of each. Deliberately not entries on `RUNTIME_COPY`, since these strings are not per-diagnosis. */
export const RUNTIME_STRIP_LOADING = 'Checking the Claude Code runtime…'
export const RUNTIME_STRIP_ERROR = "Couldn't reach the main process to check the Claude Code runtime."
export const RUNTIME_UNVERIFIED_STRIP_NOTE = 'Not verified yet — a test runs one short turn.'
export const RUNTIME_PROBE_ERROR = "Couldn't reach the main process to test the connection."
export const RUNTIME_API_KEY_NOTE = 'An ANTHROPIC_API_KEY is set in this environment — this turn may not have used your subscription.'
export const RUNTIME_NO_READY_REPO_NOTE = 'Register a repository to test the connection.'

/** `'Test connection'` for the honest resting state, `'Retry'` otherwise, no button for `verified`/`policy-refused`. */
export function runtimeActionLabel(diagnosis: RuntimeDiagnosis): string | null {
  if (diagnosis === 'verified' || diagnosis === 'policy-refused') return null
  if (diagnosis === 'unverified') return 'Test connection'
  return 'Retry'
}
