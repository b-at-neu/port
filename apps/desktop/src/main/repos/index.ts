// The registry module's only public surface: list/add/remove orchestration. Every later adapter takes its config from the entries this returns, rather than reading a config itself.
import { pathOps } from '@/main/platform/paths'
import type { Platform } from '@/main/platform'
import type { ReposAddResponse, ReposListResponse, ReposRemoveResponse } from '@/types/ipc'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { ReadyEntry } from '@/types/actions'
import { inspectRepository, resolveGitRoot } from '@/main/repos/inspect'
import { readRegistry, writeRegistry } from '@/main/repos/registry-store'

export const REPOSITORY_LIST_TTL_MS = 5_000

type ReposContext = Pick<Platform, 'paths' | 'git' | 'fs' | 'dialogs' | 'clock'>

interface ListCache {
  generation: number
  inFlight: Promise<ReposListResponse> | null
  settled: { readonly readAt: number; readonly result: ReposListResponse } | null
}

/** The one `RepositoryEntry` -> `ReadyEntry` narrowing every channel that resolves a repository by id needs. */
export function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

export type RepoResolution =
  | { readonly ok: true; readonly entry: ReadyEntry }
  | { readonly ok: false; readonly kind: 'unlistable' | 'not-registered' | 'not-ready'; readonly message: string }

/** A missing or unready repository is something a person can cause, so it is a value, never a throw. */
export function readyOf(list: ReposListResponse, repoId: RepoId): RepoResolution {
  if (!list.ok) return { ok: false, kind: 'unlistable', message: list.message }
  const entry = list.repositories.find((repository) => repository.id === repoId)
  if (entry === undefined) return { ok: false, kind: 'not-registered', message: `no repository is registered with id '${repoId}'` }
  if (!isReadyEntry(entry)) return { ok: false, kind: 'not-ready', message: `repository '${repoId}' is '${entry.problem.kind}', not ready` }
  return { ok: true, entry }
}

export interface Repos {
  readonly list: (options?: { readonly fresh?: boolean }) => Promise<ReposListResponse>
  readonly add: () => Promise<ReposAddResponse>
  readonly remove: (id: RepoId) => Promise<ReposRemoveResponse>
  readonly resolve: (repoId: RepoId) => Promise<RepoResolution>
}

export function createRepos(ctx: ReposContext): Repos {
  const registryDir = ctx.paths.userData
  const now = (): number => ctx.clock.now().getTime()
  const cache: ListCache = { generation: 0, inFlight: null, settled: null }

  const inspectAll = (paths: readonly string[]) => Promise.all(paths.map((path) => inspectRepository(ctx, path)))

  async function readAndInspect(): Promise<ReposListResponse> {
    const registry = await readRegistry(ctx, registryDir)
    if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }
    const repositories = await inspectAll(registry.repositories)
    return { ok: true, repositories }
  }

  /** Invalidates the cache, then seeds it with a list the caller just inspected, so the refetch after an add or remove costs no git. */
  function replaceCache(readAt: number, repositories: readonly RepositoryEntry[]): void {
    cache.generation++
    cache.inFlight = null
    cache.settled = { readAt, result: { ok: true, repositories } }
  }

  function list(options?: { readonly fresh?: boolean }): Promise<ReposListResponse> {
    const fresh = options?.fresh === true
    if (!fresh) {
      if (cache.settled && now() - cache.settled.readAt < REPOSITORY_LIST_TTL_MS) return Promise.resolve(cache.settled.result)
      if (cache.inFlight) return cache.inFlight
    }

    const readAt = now()
    const generation = cache.generation
    const read: Promise<ReposListResponse> = readAndInspect().then(
      (result) => {
        if (cache.inFlight === read) cache.inFlight = null
        if (result.ok && cache.generation === generation) cache.settled = { readAt, result }
        return result
      },
      (error: unknown) => {
        if (cache.inFlight === read) cache.inFlight = null
        throw error
      },
    )
    cache.inFlight = read
    return read
  }

  async function add(): Promise<ReposAddResponse> {
    const registry = await readRegistry(ctx, registryDir)
    if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }

    const picked = await ctx.dialogs.chooseDirectory()
    if (picked === null) return { ok: true, outcome: 'cancelled' }

    // Resolve to the git root before the duplicate check, so a subdirectory of an already-registered repository is not registered a second time.
    const rootResult = await resolveGitRoot(ctx, picked)
    const effectivePath = rootResult.ok ? rootResult.root : picked

    const existingIndex = registry.repositories.findIndex((existing) => pathOps.samePath(existing, effectivePath))
    if (existingIndex !== -1) {
      const repositories = await inspectAll(registry.repositories)
      const existing = repositories[existingIndex]
      return {
        ok: true,
        outcome: 'already-registered',
        existing: existing?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId),
        repositories,
      }
    }

    const newPaths = [...registry.repositories, effectivePath]
    const written = await writeRegistry(ctx, registryDir, newPaths)
    if (!written.ok) return { ok: false, kind: written.kind, message: written.message }

    const readAt = now()
    const repositories = await inspectAll(newPaths)
    replaceCache(readAt, repositories)
    const added = repositories.find((entry) => pathOps.samePath(entry.path, effectivePath))
    return { ok: true, outcome: 'added', added: added?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId), repositories }
  }

  async function remove(id: RepoId): Promise<ReposRemoveResponse> {
    const registry = await readRegistry(ctx, registryDir)
    if (!registry.ok) return { ok: false, kind: 'registry-unwritable', message: registry.message }

    const remaining = registry.repositories.filter((path) => (pathOps.pathKey(path) as unknown as RepoId) !== id)
    if (remaining.length === registry.repositories.length) {
      return { ok: false, kind: 'not-registered', message: `no repository is registered with id '${id}'` }
    }

    const written = await writeRegistry(ctx, registryDir, remaining)
    if (!written.ok) return { ok: false, kind: 'registry-unwritable', message: written.message }

    const readAt = now()
    const repositories = await inspectAll(remaining)
    replaceCache(readAt, repositories)
    return { ok: true, repositories }
  }

  return { list, add, remove, resolve: async (repoId) => readyOf(await list(), repoId) }
}
