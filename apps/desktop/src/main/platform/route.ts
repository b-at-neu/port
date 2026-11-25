// The host route: commands resolve through `which` and GitHub is read over the real client.
import { which } from '@/main/platform/which'
import type { PlatformRoute } from '@/types/platform'

export const resolveCommand: PlatformRoute['resolveCommand'] = async (command, args, options) => {
  const resolved = await (options.resolve ?? ((resolveOptions) => which(resolveOptions)))({ command, env: options.whichEnv ?? options.env ?? process.env, platform: options.platform ?? process.platform })
  return resolved.ok ? { ok: true, path: resolved.path, args, env: options.env } : resolved
}

export const githubClient: PlatformRoute['githubClient'] = (real) => real
