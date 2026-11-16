// `'backlog:list'`'s composition: registry lookup, then the list read and per-epic children read `fetchBacklog` makes.
import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import type { IpcMap } from '@/types/ipc'
import { fetchBacklog } from '@/main/github/backlog'
import { fetchBacklogDetail } from '@/main/github/backlog-detail'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'

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

export interface BacklogDetailDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchBacklogDetail: typeof fetchBacklogDetail
}

export const defaultBacklogDetailDeps: BacklogDetailDeps = { listRepositories, fetchBacklogDetail }

// A malformed request or unusable repository throws; every GitHub-side outcome is a typed value.
export async function resolveBacklogDetail(
  registryDeps: RegistryDeps,
  request: IpcMap['backlog:detail']['request'],
  deps: BacklogDetailDeps = defaultBacklogDetailDeps,
): Promise<BacklogDetailResponse> {
  const repoId = requireRepoId(request?.repoId, "'backlog:detail'")
  const number: unknown = request.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error("'backlog:detail' requires 'number' to be a positive integer")
  }
  const entry = await requireReadyRepo(registryDeps, "'backlog:detail'", repoId, deps.listRepositories)

  return deps.fetchBacklogDetail({ repo: { owner: entry.config.owner, name: entry.config.name }, number })
}
