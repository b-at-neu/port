// `'backlog:list'`'s composition (#365): registry lookup, then the one
// round trip `fetchBacklog` makes — the same `resolveWorktreesReport`
// id/ready rail every other channel here already applies.
import type { BacklogResponse } from '../../shared/backlog/types'
import type { IpcMap } from '../../shared/ipc'
import { fetchBacklog } from '../github'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'

export interface BacklogListDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchBacklog: typeof fetchBacklog
}

export const defaultBacklogListDeps: BacklogListDeps = { listRepositories, fetchBacklog }

/** `repoId` must name a registered, `ready` repository — otherwise this
 *  throws, matching the stale-renderer rail every channel uses. The repo ref
 *  and vocabulary both come from that entry's own resolved config, never a
 *  second config read. */
export async function resolveBacklogList(
  registryDeps: RegistryDeps,
  request: IpcMap['backlog:list']['request'],
  deps: BacklogListDeps = defaultBacklogListDeps,
): Promise<BacklogResponse> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'backlog:list' requires a non-empty 'repoId'")
  }
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'backlog:list' could not list repositories: ${list.message}`)
  const entry = list.repositories.find((repository) => repository.id === request.repoId)
  if (!entry) throw new Error(`'backlog:list' found no repository registered with id '${request.repoId}'`)
  if (!('config' in entry)) throw new Error(`'backlog:list' requires a 'ready' repository, got '${entry.problem.kind}'`)

  return deps.fetchBacklog({ repo: { owner: entry.config.owner, name: entry.config.name }, vocabulary: entry.config.vocabulary })
}
