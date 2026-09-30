// #98: pure mapping from `SessionStartMode` to `Options`, holding every
// constant in one place. `sessionId` is deliberately never passed — the
// `init` message stays the single source of the id (see shared/hosting/
// types.ts's "Two identifiers, never one").
import type { CanUseTool, Options } from './sdk'
import type { PluginRequest, SessionStartMode } from '../../shared/hosting/types'

/** #101: explicit, never omitted — omitting it matches today's CLI default,
 *  but that is an SDK default this app does not own. `[]` would drop the
 *  repository's `permissions.deny`, its `enabledPlugins` (so no installed
 *  `port`), and `CLAUDE.md`; under `permissionMode: 'dontAsk'` elsewhere in
 *  this pipeline, a session with no allow rules can do nothing. */
export const SETTING_SOURCES: readonly ('user' | 'project' | 'local')[] = ['user', 'project', 'local']

export interface BuildSessionOptionsParams {
  readonly mode: SessionStartMode
  /** The ready registry entry's own path — never a second-guessed cwd. */
  readonly cwd: string
  /** #97's resolved executable — never left to the SDK's own bundled
   *  fallback. */
  readonly executablePath: string
  /** #99: this handle's own permission broker's `canUseTool`. */
  readonly canUseTool: CanUseTool
  /** #101: which plugin path this session asked for — the `repository`
   *  source adds `plugins: [{ type: 'local', path }]`, so the bundled CLI
   *  overrides the installed copy with the working tree; the `installed`
   *  source passes no `plugins` at all, loading `port@port` from
   *  `enabledPlugins` exactly as every other repository does today. Never
   *  a `skills` option key here — a command runs as a typed slash command
   *  in the live session, never through the Skill-tool filter (see
   *  `capabilities.ts`'s own header). */
  readonly plugin: PluginRequest
}

/** `includePartialMessages: true` now, not later — #219's "text appears as
 *  it arrives" is impossible without it. `permissionMode: 'default'` is set
 *  explicitly rather than omitted (#99) — the CLI flag outranks a
 *  `defaultMode` in the user's own settings, so leaving it out would let a
 *  `bypassPermissions` default silently skip the host prompt entirely.
 *  `permissionPromptToolName` is never set: the SDK throws when both it and
 *  `canUseTool` are present. `settingSources` is always the three sources
 *  above (#101). */
export function buildSessionOptions(params: BuildSessionOptionsParams): Options {
  const base: Options = {
    cwd: params.cwd,
    pathToClaudeCodeExecutable: params.executablePath,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: 'default',
    canUseTool: params.canUseTool,
    settingSources: [...SETTING_SOURCES],
    ...(params.plugin.source === 'repository' ? { plugins: [{ type: 'local' as const, path: params.plugin.path }] } : {}),
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
