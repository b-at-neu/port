// The runtime strip's operator-facing copy table (#97) — one entry per
// `RuntimeDiagnosis`, never a shared "error" catch-all, in the shape
// `board/copy.ts` already uses for its own unions: a new diagnosis is a
// compile error here, never a silently blank line. Pure data; no DOM here.
import type { RuntimeDiagnosis } from './types'

/** What kind of remedy a diagnosis implies — `retry` covers "try again",
 *  possibly after a config change (`bundled-fallback`) or a binary install
 *  (`cli-missing`); `login`/`update` name a concrete external step;
 *  `account-owner` names one the app cannot offer as a button at all. Never
 *  an `'api-key'` member — the `desktop-runtime` check pins that absence,
 *  and `unauthenticated`/`token-stale` are pinned to `login` specifically,
 *  since #145's two-week cost was exactly this pair being misread as an API
 *  key problem instead. */
export type RuntimeAction = 'install' | 'login' | 'update' | 'account-owner' | 'retry'

export interface RuntimeCopy {
  readonly title: string
  readonly body: string
  readonly action: RuntimeAction | null
}

/** Every `RuntimeDiagnosis` member, both directions pinned by
 *  `desktop-runtime.mjs` — a variant added to the union with no entry here
 *  is a compile error (`Record`'s exhaustiveness), and an entry with no
 *  corresponding variant is dead copy the check also rejects.
 *
 *  Ambiguous probe text resolves toward `unauthenticated`, never
 *  `policy-refused` (`main/runtime/classify.ts`'s own header states the same
 *  direction): a wrong `unauthenticated` costs one `claude` login the
 *  operator was going to run anyway, while a wrong `policy-refused` sends
 *  them to their account owner over what might be nothing but a stale
 *  token — the exact two-week failure #145 recorded. */
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

/** The one advisory line shown *beside* another diagnosis, never alone as a
 *  block (`belowMinimum` on `RuntimePreflight['version']`) — not itself a
 *  `RuntimeDiagnosis`, since the policy is "try it and see": an old CLI
 *  still gets a real probe, this is only ever a note appended to whatever
 *  the probe or preflight actually reported. */
export const CLI_OUTDATED_COPY: RuntimeCopy = {
  title: 'Claude Code is older than the version this app expects.',
  body: 'It may still work — this is advisory only.',
  action: 'update',
}
