// Pure mapping from SessionStartMode to Options. sessionId is deliberately never passed; init stays the single source.
import type { CanUseTool, Options } from '@/main/hosting/sdk'
import type { SessionDefaults, SessionStartMode } from '@/types/hosting'
import type { PluginRequest } from '@/types/hosting-plugin'
import type { StageAgentLaunch } from '@/types/stage'

/** Explicit, never omitted — `[]` would drop the repository's deny rules, plugins, and `CLAUDE.md`. */
export const SETTING_SOURCES: readonly ('user' | 'project' | 'local')[] = ['user', 'project', 'local']

interface BuildSessionOptionsParams {
  readonly mode: SessionStartMode
  readonly cwd: string
  /** Never left to the SDK's own bundled fallback. */
  readonly executablePath: string
  readonly canUseTool: CanUseTool
  /** `repository` adds a local plugin entry overriding the installed copy; `installed` passes none. */
  readonly plugin: PluginRequest
  /** `model` is set only when non-null, matching Claude Code's own default. Ignored entirely when `stage` is set. */
  readonly defaults: SessionDefaults
  /** Non-null only for a stage session: the inline agent, its model, and the bundle root it may read; `permissionMode` is always `'default'` — `defaults` is never read. */
  readonly stage: { readonly agent: StageAgentLaunch; readonly instructionsRoot: string; readonly model: string } | null
}

function stageOptions(stage: NonNullable<BuildSessionOptionsParams['stage']>): Options {
  return {
    agents: { [stage.agent.name]: { ...stage.agent.definition, model: stage.model } },
    agent: stage.agent.name,
    model: stage.model,
    additionalDirectories: [stage.instructionsRoot],
  }
}

/** `permissionMode` is always explicit, so a `bypassPermissions` default can't silently skip the host prompt. The stage branch never reads `defaults` and never adds `tools:`/`allowedTools`/`systemPrompt`/`bypassPermissions`. */
export function buildSessionOptions(params: BuildSessionOptionsParams): Options {
  const base: Options = {
    cwd: params.cwd,
    pathToClaudeCodeExecutable: params.executablePath,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: params.stage !== null ? 'default' : params.defaults.permissionMode,
    canUseTool: params.canUseTool,
    settingSources: [...SETTING_SOURCES],
    ...(params.plugin.source === 'repository' ? { plugins: [{ type: 'local' as const, path: params.plugin.path }] } : {}),
    ...(params.stage !== null ? stageOptions(params.stage) : params.defaults.model !== null ? { model: params.defaults.model } : {}),
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
