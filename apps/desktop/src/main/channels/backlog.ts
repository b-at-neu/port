// `'backlog:list'`'s composition: registry lookup, then the tracker's list read and per-epic children read.
import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import type { IpcMap } from '@/types/ipc'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/registry'
import { defaultTracker } from '@/main/tracker'
import type { RegistryDeps } from '@/types/registry'
import type { TrackedRef } from '@/types/pipeline-state'
import type { Tracker } from '@/types/tracker'
import type { RepoId } from '@/utils/repos'

export interface BacklogListDeps {
  readonly listRepositories: typeof listRepositories
  readonly listBacklog: Tracker['listBacklog']
  /** The store's tracked refs for a repository; `null` is a labels view. */
  readonly trackedRefs: (repoId: RepoId) => readonly TrackedRef[] | null
}

export const defaultBacklogListDeps: BacklogListDeps = { listRepositories, listBacklog: defaultTracker.listBacklog, trackedRefs: () => null }

// `repoId` must name a registered, `ready` repository; the repo ref and vocabulary come from its own config.
export async function resolveBacklogList(
  registryDeps: RegistryDeps,
  request: IpcMap['backlog:list']['request'],
  deps: BacklogListDeps = defaultBacklogListDeps,
): Promise<BacklogResponse> {
  const repoId = requireRepoId(request?.repoId, "'backlog:list'")
  const entry = await requireReadyRepo(registryDeps, "'backlog:list'", repoId, deps.listRepositories)

  const refs = deps.trackedRefs(repoId)
  const tracked = refs === null ? null : new Set(refs.filter((ref) => ref.kind === 'issue').map((ref) => ref.number))
  return deps.listBacklog({ repo: { owner: entry.config.owner, name: entry.config.name }, vocabulary: entry.config.vocabulary, tracked })
}

export interface BacklogDetailDeps {
  readonly listRepositories: typeof listRepositories
  readonly readTicket: Tracker['readTicket']
}

export const defaultBacklogDetailDeps: BacklogDetailDeps = { listRepositories, readTicket: defaultTracker.readTicket }

// A malformed request or unusable repository throws; every tracker-side outcome is a typed value.
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

  return deps.readTicket({ repo: { owner: entry.config.owner, name: entry.config.name }, number })
}
