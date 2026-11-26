import type { RuntimeProbe } from '@/types/runtime'
import { runtimeProbe } from '@/main/sessions/runtime/preflight'
import { pathOps } from '@/main/platform/paths'
import type { Platform } from '@/main/platform'
import type { RepoId } from '@/utils/repos'

/** Repository-free mode (`repoId: null`) never touches the registry at all. */
export function probeRuntime(ctx: Parameters<typeof runtimeProbe>[0] & Pick<Platform, 'paths'>, repoId: RepoId | null): Promise<RuntimeProbe> {
  return runtimeProbe(ctx, { repoId, probeDir: pathOps.join(ctx.paths.userData, 'runtime-probe') })
}
