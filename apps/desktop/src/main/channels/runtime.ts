// `'runtime:probe'`'s own validation (#97) — moved out of `main/ipc.ts`
// (#314) to keep that file under the 500-line limit (ENGINEERING §7: "move
// out as each is next touched"), a pure relocation with no behaviour change.
import type { IpcMap } from '../../shared/ipc'
import type { RuntimeProbe } from '../../shared/runtime/types'
import { runtimeProbe } from '../runtime/preflight'
import type { RegistryDeps } from '../registry'

/** `runtimeProbe` (`../runtime`) resolves the registry lookup itself, same
 *  as `resolveClaimPreflight`/`main/claim.ts`. */
export async function resolveRuntimeProbe(registryDeps: RegistryDeps, request: IpcMap['runtime:probe']['request']): Promise<RuntimeProbe> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') throw new Error("'runtime:probe' requires a non-empty 'repoId'")
  return runtimeProbe({ registryDeps, repoId: request.repoId })
}
