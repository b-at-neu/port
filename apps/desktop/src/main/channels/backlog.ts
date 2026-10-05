// `'backlog:list'`'s composition: registry lookup, then the one round trip `fetchBacklog` makes.
import type { BacklogResponse } from '../../shared/backlog/types'
import type { IpcMap } from '../../shared/ipc'
import { fetchBacklog } from '../github/backlog'
import { listRepositories, requireReadyRepo, requireRepoId } from '../registry'
import type { RegistryDeps } from '../registry'

export interface BacklogListDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchBacklog: typeof fetchBacklog
}

export const defaultBacklogListDeps: BacklogListDeps = { listRepositories, fetchBacklog }

// `repoId` must name a registered, `ready` repository; the repo ref and vocabulary come from its own config.
export async function resolveBacklogList(
  registryDeps: RegistryDeps,
  request: IpcMap['backlog:list']['request'],
  deps: BacklogListDeps = defaultBacklogListDeps,
): Promise<BacklogResponse> {
  const repoId = requireRepoId(request?.repoId, "'backlog:list'")
  const entry = await requireReadyRepo(registryDeps, "'backlog:list'", repoId, deps.listRepositories)

  return deps.fetchBacklog({ repo: { owner: entry.config.owner, name: entry.config.name }, vocabulary: entry.config.vocabulary })
}
