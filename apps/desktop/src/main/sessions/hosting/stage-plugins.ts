import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'

interface PluginSettingsShape {
  readonly enabledPlugins?: unknown
}

/** Any value but `false` enables, since `enabledPlugins` also takes version constraints. */
function enabledIds(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.entries(value).filter(([, enabled]) => enabled !== false).map(([id]) => id)
}

/** The operator's own plugins that the repository does not enable itself. */
export function userOnlyPlugins(user: unknown, repository: readonly unknown[]): readonly string[] {
  const kept = new Set(repository.flatMap(enabledIds))
  return enabledIds(user).filter((id) => !kept.has(id))
}

/** A stage session turns these off, so their skills, hooks and MCP servers stay out of its context. A missing or unparseable file reads as no plugins. */
export async function readStageDisabledPlugins(ctx: Pick<Platform, 'fs' | 'claudeHome'>, cwd: string): Promise<readonly string[]> {
  const read = async (path: string): Promise<unknown> => {
    const result = await ctx.fs.readJson<PluginSettingsShape>(path)
    return result.ok ? result.value.enabledPlugins : undefined
  }
  const [user, project, local] = await Promise.all([
    read(pathOps.join(ctx.claudeHome, 'settings.json')),
    read(pathOps.join(cwd, '.claude', 'settings.json')),
    read(pathOps.join(cwd, '.claude', 'settings.local.json')),
  ])
  return userOnlyPlugins(user, [project, local])
}
