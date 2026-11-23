// The registry module's only public surface: list/add/remove orchestration. Every later adapter takes its config from the entries this returns, rather than reading a config itself.
import { pathOps } from '@/main/platform/paths'
import type { ReposAddResponse, ReposListResponse, ReposRemoveResponse } from '@/types/ipc'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { ReadyEntry } from '@/types/actions'
import type { GitRunner } from '@/types/platform'
import { inspectRepository, resolveGitRoot } from '@/main/repos/inspect'
import { readRegistry, writeRegistry } from '@/main/repos/registry-store'
import type { RegistryDeps } from '@/types/registry'

async function inspectAll(paths: readonly string[], git: GitRunner) {
  return Promise.all(paths.map((path) => inspectRepository(path, { git })))
}

export const REPOSITORY_LIST_TTL_MS = 5_000

interface ListCache {
  generation: number
  inFlight: Promise<ReposListResponse> | null
  settled: { readonly readAt: number; readonly result: ReposListResponse } | null
}

const listCaches = new WeakMap<RegistryDeps, ListCache>()

function cacheOf(deps: RegistryDeps): ListCache {
  const existing = listCaches.get(deps)
  if (existing) return existing
  const created: ListCache = { generation: 0, inFlight: null, settled: null }
  listCaches.set(deps, created)
  return created
}

const clockOf = (deps: RegistryDeps): number => (deps.now ?? Date.now)()

async function readAndInspect(deps: RegistryDeps): Promise<ReposListResponse> {
  const registry = await readRegistry(deps.registryDir)
  if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }
  const repositories = await inspectAll(registry.repositories, deps.git)
  return { ok: true, repositories }
}

/** Invalidates the cache, then seeds it with a list the caller just inspected, so the refetch after an add or remove costs no git. */
function replaceCache(deps: RegistryDeps, readAt: number, repositories: readonly RepositoryEntry[]): void {
  const cache = cacheOf(deps)
  cache.generation++
  cache.inFlight = null
  cache.settled = { readAt, result: { ok: true, repositories } }
}

export function listRepositories(deps: RegistryDeps, options?: { readonly fresh?: boolean }): Promise<ReposListResponse> {
  const cache = cacheOf(deps)
  const fresh = options?.fresh === true
  if (!fresh) {
    if (cache.settled && clockOf(deps) - cache.settled.readAt < REPOSITORY_LIST_TTL_MS) return Promise.resolve(cache.settled.result)
    if (cache.inFlight) return cache.inFlight
  }

  const readAt = clockOf(deps)
  const generation = cache.generation
  const read: Promise<ReposListResponse> = readAndInspect(deps).then(
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

export async function addRepository(deps: RegistryDeps): Promise<ReposAddResponse> {
  const registry = await readRegistry(deps.registryDir)
  if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }

  const picked = await deps.chooseDirectory()
  if (picked === null) return { ok: true, outcome: 'cancelled' }

  // Resolve to the git root before the duplicate check, so a subdirectory of an already-registered repository is not registered a second time.
  const rootResult = await resolveGitRoot(deps.git, picked)
  const effectivePath = rootResult.ok ? rootResult.root : picked

  const existingIndex = registry.repositories.findIndex((existing) => pathOps.samePath(existing, effectivePath))
  if (existingIndex !== -1) {
    const repositories = await inspectAll(registry.repositories, deps.git)
    const existing = repositories[existingIndex]
    return {
      ok: true,
      outcome: 'already-registered',
      existing: existing?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId),
      repositories,
    }
  }

  const newPaths = [...registry.repositories, effectivePath]
  const written = await writeRegistry(deps.registryDir, newPaths)
  if (!written.ok) return { ok: false, kind: written.kind, message: written.message }

  const readAt = clockOf(deps)
  const repositories = await inspectAll(newPaths, deps.git)
  replaceCache(deps, readAt, repositories)
  const added = repositories.find((entry) => pathOps.samePath(entry.path, effectivePath))
  return { ok: true, outcome: 'added', added: added?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId), repositories }
}

/** The one `RepositoryEntry` -> `ReadyEntry` narrowing every channel that resolves a repository by id needs. */
export function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

/** The non-empty-string check every channel that takes a `repoId` opens with, before ever reaching `requireReadyRepo`. */
export function requireRepoId(repoId: unknown, channel: string): RepoId {
  if (typeof repoId !== 'string' || repoId === '') throw new Error(`${channel} requires a non-empty 'repoId'`)
  return repoId as RepoId
}

/** "Find a registered, ready repository by id, or throw" — every repository-scoped channel composes this. `notListableMessage` lets a caller keep its own original wording. */
export async function requireReadyRepo(
  registryDeps: RegistryDeps,
  subject: string,
  repoId: RepoId,
  list: typeof listRepositories,
  notListableMessage: (message: string) => string = (message) => `${subject} could not list repositories: ${message}`,
): Promise<ReadyEntry> {
  const result = await list(registryDeps)
  if (!result.ok) throw new Error(notListableMessage(result.message))
  const entry = result.repositories.find((repository) => repository.id === repoId)
  if (!entry) throw new Error(`${subject} found no repository registered with id '${repoId}'`)
  if (!isReadyEntry(entry)) throw new Error(`${subject} requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
}

export async function removeRepository(deps: RegistryDeps, id: RepoId): Promise<ReposRemoveResponse> {
  const registry = await readRegistry(deps.registryDir)
  if (!registry.ok) return { ok: false, kind: 'registry-unwritable', message: registry.message }

  const remaining = registry.repositories.filter((path) => (pathOps.pathKey(path) as unknown as RepoId) !== id)
  if (remaining.length === registry.repositories.length) {
    return { ok: false, kind: 'not-registered', message: `no repository is registered with id '${id}'` }
  }

  const written = await writeRegistry(deps.registryDir, remaining)
  if (!written.ok) return { ok: false, kind: 'registry-unwritable', message: written.message }

  const readAt = clockOf(deps)
  const repositories = await inspectAll(remaining, deps.git)
  replaceCache(deps, readAt, repositories)
  return { ok: true, repositories }
}
