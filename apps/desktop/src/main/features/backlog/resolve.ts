// `'backlog:list'`'s composition: registry lookup, then the list read and per-epic children read `fetchBacklog` makes.
import type { BacklogDetailResponse, BacklogResponse } from '@/types/backlog'
import { fetchBacklog } from '@/main/github/tracker/backlog'
import type { GitHubReadContext } from '@/main/github/context'
import { fetchBacklogDetail } from '@/main/github/tracker/backlog-detail'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/repos'
import type { RegistryDeps } from '@/types/registry'
import type { TrackedRef } from '@/types/pipeline-state'
import type { RepoId } from '@/utils/repos'

export interface BacklogListDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchBacklog: typeof fetchBacklog
  /** The store's tracked refs for a repository; `null` is an unseeded one, which tracks nothing yet. */
  readonly trackedRefs: (repoId: RepoId) => readonly TrackedRef[] | null
}

export const defaultBacklogListDeps: BacklogListDeps = { listRepositories, fetchBacklog, trackedRefs: () => null }

// `repoId` must name a registered, `ready` repository; the repo ref comes from its own config.
export async function resolveBacklogList(
  ctx: GitHubReadContext,
  registryDeps: RegistryDeps,
  request: { readonly repoId: RepoId },
  deps: BacklogListDeps = defaultBacklogListDeps,
): Promise<BacklogResponse> {
  const repoId = requireRepoId(request?.repoId, "'backlog:list'")
  const entry = await requireReadyRepo(registryDeps, "'backlog:list'", repoId, deps.listRepositories)

  const refs = deps.trackedRefs(repoId)
  const tracked = new Set((refs ?? []).filter((ref) => ref.kind === 'issue').map((ref) => ref.number))
  return deps.fetchBacklog(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, tracked })
}

export interface BacklogDetailDeps {
  readonly listRepositories: typeof listRepositories
  readonly fetchBacklogDetail: typeof fetchBacklogDetail
}

export const defaultBacklogDetailDeps: BacklogDetailDeps = { listRepositories, fetchBacklogDetail }

// A malformed request or unusable repository throws; every GitHub-side outcome is a typed value.
export async function resolveBacklogDetail(
  ctx: GitHubReadContext,
  registryDeps: RegistryDeps,
  request: { readonly repoId: RepoId; readonly number: number },
  deps: BacklogDetailDeps = defaultBacklogDetailDeps,
): Promise<BacklogDetailResponse> {
  const repoId = requireRepoId(request?.repoId, "'backlog:detail'")
  const number: unknown = request.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error("'backlog:detail' requires 'number' to be a positive integer")
  }
  const entry = await requireReadyRepo(registryDeps, "'backlog:detail'", repoId, deps.listRepositories)

  return deps.fetchBacklogDetail(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, number })
}
