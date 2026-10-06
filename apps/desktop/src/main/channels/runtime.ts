// `'runtime:probe'`'s own validation (#97) — moved out of `main/ipc.ts`
// (#314) to keep that file under the 500-line limit (ENGINEERING §7: "move
// out as each is next touched"), a pure relocation with no behaviour change.
import type { IpcMap } from '../../shared/ipc'
import type { RuntimeProbe } from '../../shared/runtime/types'
import { runtimeProbe } from '../runtime/preflight'
import type { RegistryDeps } from '../registry'
import type { RepoId } from '../../shared/repos'

/** `repoId` must be a non-empty string or exactly `null` — an explicit
 *  `null` rather than an optional field, so a caller can't drop the key by
 *  accident and silently get repository-free mode. */
function requireRepoIdOrNull(repoId: unknown, channel: string): RepoId | null {
  if (repoId === null) return null
  if (typeof repoId !== 'string' || repoId === '') throw new Error(`${channel} requires 'repoId' to be a non-empty string or null`)
  return repoId as RepoId
}

/** `runtimeProbe` (`../runtime`) resolves the registry lookup itself, same
 *  as `resolveClaimPreflight`/`main/claim.ts`, except in repository-free
 *  mode (`repoId: null`), which never touches the registry at all. */
export async function resolveRuntimeProbe(registryDeps: RegistryDeps, request: IpcMap['runtime:probe']['request'], probeDir: string): Promise<RuntimeProbe> {
  const repoId = requireRepoIdOrNull(request?.repoId, "'runtime:probe'")
  return runtimeProbe({ registryDeps, repoId, probeDir })
}
