// Resolves which plugin path a hosted session should request: the repository's own plugins/port/
// wins over the installed cache when this checkout's manifest names `port`.
import { listDirectory, readJsonFile } from '../platform/files'
import { pathOps } from '../platform/paths'
import type { PluginRequest } from '../../shared/hosting/types'

export interface PluginManifest {
  readonly name?: string
}

export interface ResolvePluginRequestDeps {
  readonly readJsonFile: typeof readJsonFile
}

export const defaultResolvePluginRequestDeps: ResolvePluginRequestDeps = { readJsonFile }

/** `not-found`, or a manifest naming anything but `port`, resolves to the installed copy. A manifest
 *  that exists but cannot be parsed still resolves to `repository` — verification then reports `missing`. */
export async function resolvePluginRequest(repoRoot: string, deps: ResolvePluginRequestDeps = defaultResolvePluginRequestDeps): Promise<PluginRequest> {
  const pluginPath = pathOps.join(repoRoot, 'plugins', 'port')
  const manifestPath = pathOps.join(pluginPath, '.claude-plugin', 'plugin.json')
  const result = await deps.readJsonFile<PluginManifest>(manifestPath)
  if (!result.ok) {
    if (result.kind === 'not-found') return { source: 'installed' }
    return { source: 'repository', path: pluginPath }
  }
  if (result.value.name !== 'port') return { source: 'installed' }
  return { source: 'repository', path: pluginPath }
}

export interface ExpectedComponents {
  readonly skills: readonly string[]
  readonly agents: readonly string[]
}

export interface ReadExpectedComponentsDeps {
  readonly listDirectory: typeof listDirectory
}

export const defaultReadExpectedComponentsDeps: ReadExpectedComponentsDeps = { listDirectory }

const MARKDOWN_EXTENSION = '.md'

/** `null` on either read failing — never treated as complete. Skills are directory names under
 *  `skills/`; agents are `.md` basenames under `agents/`, extension dropped. */
export async function readExpectedComponents(pluginPath: string, deps: ReadExpectedComponentsDeps = defaultReadExpectedComponentsDeps): Promise<ExpectedComponents | null> {
  const [skillsResult, agentsResult] = await Promise.all([deps.listDirectory(pathOps.join(pluginPath, 'skills')), deps.listDirectory(pathOps.join(pluginPath, 'agents'))])
  if (!skillsResult.ok || !agentsResult.ok) return null
  const skills = skillsResult.value.filter((entry) => entry.kind === 'directory').map((entry) => entry.name)
  const agents = agentsResult.value.filter((entry) => entry.kind === 'file' && entry.name.endsWith(MARKDOWN_EXTENSION)).map((entry) => entry.name.slice(0, -MARKDOWN_EXTENSION.length))
  return { skills, agents }
}
