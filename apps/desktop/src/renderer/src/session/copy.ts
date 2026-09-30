// #219: every string the session view renders — pure copy tables keyed
// exhaustively on `SessionPhase` and `SessionEndReason`, the same
// `Record`-exhaustiveness rule `board/copy.ts` and `permission/copy.ts`
// already establish: a phase or end reason added to either union with no
// entry here is a compile error, never a silently blank pill. `Record`
// exhaustiveness is the #99 hand-off named in the plan — adding an
// awaiting-permission phase later fails typecheck until its own copy exists
// here. End diagnoses reuse `RUNTIME_COPY` from `shared/runtime/copy.ts`,
// never new wording of their own.
import type { SessionEnd, SessionEndReason, SessionPhase, SessionStartResult } from '../../../shared/hosting/types'
import { RUNTIME_COPY } from '../../../shared/runtime/copy'

export type StopState = 'enabled' | 'disabled' | 'stopping' | 'hidden'
export type CloseState = 'enabled' | 'confirm' | 'closing' | 'hidden'

export interface PhaseCopy {
  readonly pill: string
  readonly stop: StopState
  readonly close: CloseState
  readonly composerDisabled: boolean
  readonly composerPlaceholder: string
  /** `null` when the composer has no send button at all (`closing`,
   *  `ended`) — the placeholder alone explains why. */
  readonly sendLabel: string | null
}

const WORKING_PLACEHOLDER = 'Claude is working — this message runs next.'

/** Every `SessionPhase` member, both directions pinned by the
 *  `desktop-hosting` check the same way `SessionPhase`'s own members are
 *  already pinned against `handle.ts`'s assignments. */
export const PHASE_COPY: Readonly<Record<SessionPhase, PhaseCopy>> = {
  starting: { pill: '◌ Starting', stop: 'disabled', close: 'enabled', composerDisabled: false, composerPlaceholder: 'Message Claude…', sendLabel: 'Send' },
  ready: { pill: '○ Idle', stop: 'disabled', close: 'enabled', composerDisabled: false, composerPlaceholder: 'Message Claude…', sendLabel: 'Send' },
  streaming: { pill: '● Streaming', stop: 'enabled', close: 'confirm', composerDisabled: false, composerPlaceholder: WORKING_PLACEHOLDER, sendLabel: 'Queue' },
  interrupting: { pill: '◐ Stopping…', stop: 'stopping', close: 'confirm', composerDisabled: false, composerPlaceholder: WORKING_PLACEHOLDER, sendLabel: 'Queue' },
  closing: { pill: '◐ Closing…', stop: 'disabled', close: 'closing', composerDisabled: true, composerPlaceholder: '', sendLabel: null },
  ended: { pill: '', stop: 'hidden', close: 'hidden', composerDisabled: true, composerPlaceholder: 'This session has ended.', sendLabel: null },
}

export interface EndCopy {
  readonly title: string
  readonly body: string
}

/** Every `SessionEndReason` member, both directions pinned the same way. The
 *  SDK's own `message` and a non-null `diagnosis`'s `RUNTIME_COPY` entry are
 *  layered on top by `view.ts`, never folded in here — this table is only
 *  ever the fixed title/body the ticket's own **Ended** list states. */
export const END_COPY: Readonly<Record<SessionEndReason, EndCopy>> = {
  completed: { title: 'Ended', body: 'Claude Code ended the session.' },
  closed: { title: 'Closed', body: 'You closed this session. Its transcript is under Repositories → Transcripts.' },
  'exit-nonzero': { title: 'Crashed', body: 'Claude Code exited with code {exitCode}.' },
  signal: { title: 'Crashed', body: 'Claude Code was stopped by signal {signal}.' },
  'process-error': { title: 'Crashed', body: 'Claude Code failed to run.' },
  'stream-error': { title: 'Ended unexpectedly', body: "The session ended with an error Port doesn't recognise." },
  'resume-rejected': { title: 'Resume refused', body: 'Claude Code refused to resume at that point.' },
}

/** Fills in `{exitCode}`/`{signal}` — the only two end reasons whose body
 *  carries a placeholder. */
export function endBody(end: SessionEnd): string {
  const template = END_COPY[end.reason].body
  return template.replace('{exitCode}', String(end.exitCode)).replace('{signal}', String(end.signal))
}

export interface ComposerCopy {
  readonly disabled: boolean
  readonly placeholder: string
  readonly sendLabel: string | null
}

/** `sessionGone` is the `unknown-session` send failure (#219 plan → "Send
 *  failed"): the main process no longer has this session at all, distinct
 *  from a merely-rejected IPC call, so the composer disables regardless of
 *  what `phase` still says -- `phase` alone never reaches a disabled state
 *  for this case, since nothing tells the phase machine the session died. */
export function composerCopy(phase: SessionPhase, sessionGone = false): ComposerCopy {
  const copy = PHASE_COPY[phase]
  return { disabled: copy.composerDisabled || sessionGone, placeholder: copy.composerPlaceholder, sendLabel: copy.sendLabel }
}

export interface StartFailureCopy {
  readonly title: string
  readonly body: string
  readonly detail: string | null
}

/** `at-capacity` names the limit rather than a bare refusal; `runtime`
 *  reuses #97's own `RUNTIME_COPY`, never a second error vocabulary. */
export function startFailureCopy(result: Extract<SessionStartResult, { readonly ok: false }>): StartFailureCopy {
  if (result.kind === 'at-capacity') {
    return { title: 'Port is busy', body: `Port is already hosting ${String(result.limit)} sessions. Close one before starting another.`, detail: null }
  }
  const copy = RUNTIME_COPY[result.diagnosis]
  return { title: copy.title, body: copy.body, detail: result.detail }
}

/** The note under the composer after **Stop** — `0` carries no note at all
 *  (the `Turn ended early` row already says enough); `null` is reported as
 *  "couldn't confirm", never coerced to zero (ENGINEERING §4). */
export function interruptNote(queuedAfterInterrupt: number | null): string | null {
  if (queuedAfterInterrupt === null) return "Stopped. Port couldn't confirm whether queued messages were cancelled."
  if (queuedAfterInterrupt === 0) return null
  return `Stopped. ${String(queuedAfterInterrupt)} queued message${queuedAfterInterrupt === 1 ? '' : 's'} will still run.`
}

export const BUSY_BANNER = 'Close the current session before starting a new one.'
export const EMPTY_TITLE = 'No session open.'
export const EMPTY_HINT = 'Start one with New session on a repository card.'
export const RECONNECTING = 'Reconnecting to your session…'

export function startingCopy(repoLabel: string): string {
  return `Starting a session in ${repoLabel}…`
}

export const SEND_FAILED_UNKNOWN_SESSION = "Port no longer has this session. It may have ended when the app restarted."
export const SEND_FAILED_UNREACHABLE = "Couldn't reach the main process. Your message wasn't sent."
export const START_UNREACHABLE = "Couldn't reach the main process."

export function windowNote(): string {
  return "Earlier messages aren't shown here. The full conversation is in this session's transcript under Repositories → Transcripts."
}

export const CLOSE_CONFIRM_PROMPT = 'Close while Claude is working? The current turn is abandoned.'
export const CLOSE_CONFIRM_YES = 'Close anyway'
export const CLOSE_CONFIRM_NO = 'Keep working'

export const NEW_SESSION_BUTTON = 'New session'
export const STOP_BUTTON = 'Stop'
export const CLOSE_BUTTON = 'Close session'

export const COMPOSER_HINT = 'Enter to send · Shift+Enter for a new line'
