// Pure mapping from SessionStartMode to Options. sessionId is deliberately never passed; init stays the single source.
import type { CanUseTool, Options } from './sdk'
import type { PluginRequest, SessionDefaults, SessionStartMode } from '../../shared/hosting/types'

/** Explicit, never omitted — `[]` would drop the repository's deny rules, plugins, and `CLAUDE.md`. */
export const SETTING_SOURCES: readonly ('user' | 'project' | 'local')[] = ['user', 'project', 'local']

export interface BuildSessionOptionsParams {
  readonly mode: SessionStartMode
  readonly cwd: string
  /** Never left to the SDK's own bundled fallback. */
  readonly executablePath: string
  readonly canUseTool: CanUseTool
  /** `repository` adds a local plugin entry overriding the installed copy; `installed` passes none. */
  readonly plugin: PluginRequest
  /** `model` is set only when non-null, matching Claude Code's own default. */
  readonly defaults: SessionDefaults
}

/** `permissionMode` is always explicit, so a `bypassPermissions` default can't silently skip the host prompt. */
export function buildSessionOptions(params: BuildSessionOptionsParams): Options {
  const base: Options = {
    cwd: params.cwd,
    pathToClaudeCodeExecutable: params.executablePath,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: params.defaults.permissionMode,
    canUseTool: params.canUseTool,
    settingSources: [...SETTING_SOURCES],
    ...(params.plugin.source === 'repository' ? { plugins: [{ type: 'local' as const, path: params.plugin.path }] } : {}),
    ...(params.defaults.model !== null ? { model: params.defaults.model } : {}),
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
