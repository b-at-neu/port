// #101: resolves which plugin path a hosted session should request, before
// spawn — the repository's own `plugins/port/` wins over the installed
// cache when this checkout's own manifest names `port`, so self-hosting
// sees a fix the moment it lands in the working tree rather than waiting on
// a machine-local install to catch up (ENGINEERING §1's own "installed
// copy is a stale trap" framing, restated for this app). Every other
// repository this app hosts a session on passes no `plugins` option at
// all — the CLI loads `port@port` from `enabledPlugins` exactly as it does
// today.
import { listDirectory, readJsonFile } from '../platform/files'
import type { PathOps } from '../platform/paths'
import { pathOps } from '../platform/paths'
import type { PluginRequest } from '../../shared/hosting/types'

export interface PluginManifest {
  readonly name?: string
}

export interface ResolvePluginRequestDeps {
  readonly readJsonFile: typeof readJsonFile
  readonly join: PathOps['join']
}

export const defaultResolvePluginRequestDeps: ResolvePluginRequestDeps = { readJsonFile, join: (base, ...segments) => pathOps.join(base, ...segments) }

/** `repoRoot` is the ready registry entry's own path — never re-derived or
 *  second-guessed. `not-found`, or a readable manifest naming anything but
 *  `port`, resolves to the installed copy. A manifest that exists but
 *  cannot be read or parsed **still** resolves to `repository` — this fails
 *  loud: verification then reports `missing` rather than silently falling
 *  back to a different plugin than the one this repository actually
 *  declares. */
export async function resolvePluginRequest(repoRoot: string, deps: ResolvePluginRequestDeps = defaultResolvePluginRequestDeps): Promise<PluginRequest> {
  const pluginPath = deps.join(repoRoot, 'plugins', 'port')
  const manifestPath = deps.join(pluginPath, '.claude-plugin', 'plugin.json')
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
  readonly join: PathOps['join']
}

export const defaultReadExpectedComponentsDeps: ReadExpectedComponentsDeps = { listDirectory, join: (base, ...segments) => pathOps.join(base, ...segments) }

const MARKDOWN_EXTENSION = '.md'

/** `null` on either read failing — never treated as complete by
 *  `verify.ts`'s `checkComponents` (this app's "fails closed on complete"
 *  direction, ENGINEERING §4). Skills are directory names under `skills/`;
 *  agents are `.md` basenames under `agents/`, extension dropped. */
export async function readExpectedComponents(pluginPath: string, deps: ReadExpectedComponentsDeps = defaultReadExpectedComponentsDeps): Promise<ExpectedComponents | null> {
  const [skillsResult, agentsResult] = await Promise.all([deps.listDirectory(deps.join(pluginPath, 'skills')), deps.listDirectory(deps.join(pluginPath, 'agents'))])
  if (!skillsResult.ok || !agentsResult.ok) return null
  const skills = skillsResult.value.filter((entry) => entry.kind === 'directory').map((entry) => entry.name)
  const agents = agentsResult.value.filter((entry) => entry.kind === 'file' && entry.name.endsWith(MARKDOWN_EXTENSION)).map((entry) => entry.name.slice(0, -MARKDOWN_EXTENSION.length))
  return { skills, agents }
}
