// #98: pure mapping from `SessionStartMode` to `Options`, holding every
// constant in one place. `sessionId` is deliberately never passed — the
// `init` message stays the single source of the id (see shared/hosting/
// types.ts's "Two identifiers, never one").
import type { CanUseTool, Options } from './sdk'
import type { SessionStartMode } from '../../shared/hosting/types'

export interface BuildSessionOptionsParams {
  readonly mode: SessionStartMode
  /** The ready registry entry's own path — never a second-guessed cwd. */
  readonly cwd: string
  /** #97's resolved executable — never left to the SDK's own bundled
   *  fallback. */
  readonly executablePath: string
  /** #99: this handle's own permission broker's `canUseTool`. */
  readonly canUseTool: CanUseTool
}

/** `includePartialMessages: true` now, not later — #219's "text appears as
 *  it arrives" is impossible without it. `permissionMode: 'default'` is set
 *  explicitly rather than omitted (#99) — the CLI flag outranks a
 *  `defaultMode` in the user's own settings, so leaving it out would let a
 *  `bypassPermissions` default silently skip the host prompt entirely.
 *  `permissionPromptToolName` is never set: the SDK throws when both it and
 *  `canUseTool` are present. */
export function buildSessionOptions(params: BuildSessionOptionsParams): Options {
  const base: Options = {
    cwd: params.cwd,
    pathToClaudeCodeExecutable: params.executablePath,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: 'default',
    canUseTool: params.canUseTool,
  }

  switch (params.mode.kind) {
    case 'fresh':
      return base
    case 'resume':
      return { ...base, resume: params.mode.sessionId }
    case 'resume-at': {
      const withResume: Options = { ...base, resume: params.mode.sessionId, resumeSessionAt: params.mode.messageUuid }
      return params.mode.resumeDropsTurn === null ? withResume : { ...withResume, resumeDropsTurn: params.mode.resumeDropsTurn }
    }
    case 'fork':
      return { ...base, resume: params.mode.sessionId, forkSession: true }
  }
}
