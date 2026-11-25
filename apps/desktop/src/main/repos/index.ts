// The registry module's only public surface: list/add/remove orchestration. Every later adapter takes its config from the entries this returns, rather than reading a config itself.
import { pathOps } from '@/main/platform/paths'
import { hostFs, type Platform } from '@/main/platform'
import type { ReposAddResponse, ReposListResponse, ReposRemoveResponse } from '@/types/ipc'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { ReadyEntry } from '@/types/actions'
import { inspectRepository, resolveGitRoot } from '@/main/repos/inspect'
import { readRegistry, writeRegistry } from '@/main/repos/registry-store'
import type { RegistryDeps } from '@/types/registry'

const ctxOf = (deps: RegistryDeps): Pick<Platform, 'git' | 'fs'> => ({ git: deps.git, fs: deps.fs ?? hostFs })

async function inspectAll(paths: readonly string[], deps: RegistryDeps) {
  const ctx = ctxOf(deps)
  return Promise.all(paths.map((path) => inspectRepository(ctx, path)))
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
  const registry = await readRegistry(ctxOf(deps), deps.registryDir)
  if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }
  const repositories = await inspectAll(registry.repositories, deps)
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
  const registry = await readRegistry(ctxOf(deps), deps.registryDir)
  if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }

  const picked = await deps.chooseDirectory()
  if (picked === null) return { ok: true, outcome: 'cancelled' }

  // Resolve to the git root before the duplicate check, so a subdirectory of an already-registered repository is not registered a second time.
  const rootResult = await resolveGitRoot(ctxOf(deps), picked)
  const effectivePath = rootResult.ok ? rootResult.root : picked

  const existingIndex = registry.repositories.findIndex((existing) => pathOps.samePath(existing, effectivePath))
  if (existingIndex !== -1) {
    const repositories = await inspectAll(registry.repositories, deps)
    const existing = repositories[existingIndex]
    return {
      ok: true,
      outcome: 'already-registered',
      existing: existing?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId),
      repositories,
    }
  }

  const newPaths = [...registry.repositories, effectivePath]
  const written = await writeRegistry(ctxOf(deps), deps.registryDir, newPaths)
  if (!written.ok) return { ok: false, kind: written.kind, message: written.message }

  const readAt = clockOf(deps)
  const repositories = await inspectAll(newPaths, deps)
  replaceCache(deps, readAt, repositories)
  const added = repositories.find((entry) => pathOps.samePath(entry.path, effectivePath))
  return { ok: true, outcome: 'added', added: added?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId), repositories }
}

/** The one `RepositoryEntry` -> `ReadyEntry` narrowing every channel that resolves a repository by id needs. */
export function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
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
  /** Transitional handle for callers still on `listRepositories(ctx.repos.deps)`; it shares this service's cache. */
  readonly deps: RegistryDeps
}

export function createRepos(platform: Pick<Platform, 'paths' | 'git' | 'fs' | 'dialogs' | 'clock'>): Repos {
  const { paths, git, fs, dialogs, clock } = platform
  const deps: RegistryDeps = { registryDir: paths.userData, git, fs, chooseDirectory: dialogs.chooseDirectory, now: () => clock.now().getTime() }
  return {
    list: (options) => listRepositories(deps, options),
    add: () => addRepository(deps),
    remove: (id) => removeRepository(deps, id),
    resolve: async (repoId) => readyOf(await listRepositories(deps), repoId),
    deps,
  }
}

export async function removeRepository(deps: RegistryDeps, id: RepoId): Promise<ReposRemoveResponse> {
  const registry = await readRegistry(ctxOf(deps), deps.registryDir)
  if (!registry.ok) return { ok: false, kind: 'registry-unwritable', message: registry.message }

  const remaining = registry.repositories.filter((path) => (pathOps.pathKey(path) as unknown as RepoId) !== id)
  if (remaining.length === registry.repositories.length) {
    return { ok: false, kind: 'not-registered', message: `no repository is registered with id '${id}'` }
  }

  const written = await writeRegistry(ctxOf(deps), deps.registryDir, remaining)
  if (!written.ok) return { ok: false, kind: 'registry-unwritable', message: written.message }

  const readAt = clockOf(deps)
  const repositories = await inspectAll(remaining, deps)
  replaceCache(deps, readAt, repositories)
  return { ok: true, repositories }
}
