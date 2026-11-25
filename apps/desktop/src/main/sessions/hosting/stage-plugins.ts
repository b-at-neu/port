import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'
import type { StageAgent } from '@/types/tick'

interface PluginSettingsShape {
  readonly enabledPlugins?: unknown
}

/** Any value but `false` enables, since `enabledPlugins` also takes version constraints. */
function enabledIds(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.entries(value).filter(([, enabled]) => enabled !== false).map(([id]) => id)
}

/** The plugin ids the repository's own project and local settings enable. */
export function repositoryPlugins(repository: readonly unknown[]): readonly string[] {
  return [...new Set(repository.flatMap(enabledIds))]
}

/** The operator's own plugins that the repository does not enable itself. */
export function userOnlyPlugins(user: unknown, repository: readonly unknown[]): readonly string[] {
  const kept = new Set(repositoryPlugins(repository))
  return enabledIds(user).filter((id) => !kept.has(id))
}

type PluginSettingsContext = Pick<Platform, 'fs' | 'claudeHome'>

async function readEnabledPlugins(ctx: PluginSettingsContext, path: string): Promise<unknown> {
  const result = await ctx.fs.readJson<PluginSettingsShape>(path)
  return result.ok ? result.value.enabledPlugins : undefined
}

function repositorySettings(ctx: PluginSettingsContext, cwd: string): Promise<readonly unknown[]> {
  return Promise.all([readEnabledPlugins(ctx, pathOps.join(cwd, '.claude', 'settings.json')), readEnabledPlugins(ctx, pathOps.join(cwd, '.claude', 'settings.local.json'))])
}

/** A stage session turns these off, so their skills, hooks and MCP servers stay out of its context. A missing or unparseable file reads as no plugins. */
export async function readStageDisabledPlugins(ctx: PluginSettingsContext, cwd: string): Promise<readonly string[]> {
  const [user, repository] = await Promise.all([readEnabledPlugins(ctx, pathOps.join(ctx.claudeHome, 'settings.json')), repositorySettings(ctx, cwd)])
  return userOnlyPlugins(user, repository)
}

interface InstalledPluginsShape {
  readonly plugins?: unknown
}

/** The first record's install path for each id; an id with no usable record is absent. */
function installPathsOf(installed: unknown, ids: readonly string[]): ReadonlyMap<string, string> {
  const paths = new Map<string, string>()
  const plugins = typeof installed === 'object' && installed !== null ? (installed as InstalledPluginsShape).plugins : undefined
  if (typeof plugins !== 'object' || plugins === null) return paths
  const records = plugins as Record<string, unknown>
  for (const id of ids) {
    const record = records[id]
    const first: unknown = Array.isArray(record) ? record[0] : undefined
    const installPath = typeof first === 'object' && first !== null ? (first as { readonly installPath?: unknown }).installPath : undefined
    if (typeof installPath === 'string' && installPath !== '') paths.set(id, installPath)
  }
  return paths
}

/** Plan and review list the skills of plugins the repository enables, as `<plugin>:<skill>`; impl and revise list none. Anything unreadable adds no skills and never fails the start. */
export async function readStageSkills(ctx: PluginSettingsContext, cwd: string, agent: StageAgent): Promise<readonly string[]> {
  if (agent === 'impl' || agent === 'revise') return []
  const ids = repositoryPlugins(await repositorySettings(ctx, cwd))
  if (ids.length === 0) return []
  const installed = await ctx.fs.readJson(pathOps.join(ctx.claudeHome, 'plugins', 'installed_plugins.json'))
  if (!installed.ok) return []
  const skills: string[] = []
  for (const [id, installPath] of installPathsOf(installed.value, ids)) {
    const root = pathOps.join(installPath, 'skills')
    const listed = await ctx.fs.list(root)
    if (!listed.ok) continue
    for (const entry of listed.value) {
      if (entry.kind === 'directory' && (await ctx.fs.exists(pathOps.join(root, entry.name, 'SKILL.md')))) skills.push(`${id.split('@')[0] ?? id}:${entry.name}`)
    }
  }
  return skills
}
