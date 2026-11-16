import { SOURCE_KINDS, type BoardSnapshot } from '@/types/board'
import type { BoardRefreshDeps } from '@/types/channels'
import type { IpcMap } from '@/types/ipc'
import type { RegistryDeps } from '@/types/registry'

export async function resolveBoardRefresh(
  registryDeps: RegistryDeps,
  request: IpcMap['board:refresh']['request'],
  deps: BoardRefreshDeps,
): Promise<BoardSnapshot> {
  if (request?.repoId !== undefined) {
    if (typeof request.repoId !== 'string' || request.repoId === '') {
      throw new Error("'board:refresh' repoId must be a non-empty string when present")
    }
    const list = await deps.listRepositories(registryDeps)
    if (!list.ok) throw new Error(`'board:refresh' could not list repositories: ${list.message}`)
    if (!list.repositories.some((repository) => repository.id === request.repoId)) {
      throw new Error(`'board:refresh' found no repository registered with id '${request.repoId}'`)
    }
  }
  if (request?.source !== undefined && !(SOURCE_KINDS as readonly string[]).includes(request.source)) {
    throw new Error(`'board:refresh' source must be one of ${SOURCE_KINDS.join(', ')}`)
  }
  return deps.refresh(request)
}
