import type { IpcMap } from '@/types/ipc'
import type { RuntimeProbe } from '@/types/runtime'
import { runtimeProbe } from '@/main/runtime/preflight'
import type { RegistryDeps } from '@/types/registry'
import type { RepoId } from '@/utils/repos'

/** `repoId` must be a non-empty string or exactly `null` — explicit, so a caller can't drop the key by accident. */
function requireRepoIdOrNull(repoId: unknown, channel: string): RepoId | null {
  if (repoId === null) return null
  if (typeof repoId !== 'string' || repoId === '') throw new Error(`${channel} requires 'repoId' to be a non-empty string or null`)
  return repoId as RepoId
}

/** Repository-free mode (`repoId: null`) never touches the registry at all. */
export async function resolveRuntimeProbe(registryDeps: RegistryDeps, request: IpcMap['runtime:probe']['request'], probeDir: string): Promise<RuntimeProbe> {
  const repoId = requireRepoIdOrNull(request?.repoId, "'runtime:probe'")
  return runtimeProbe({ registryDeps, repoId, probeDir })
}
