// The registry module's only public surface: list/add/remove orchestration.
// Every later adapter (#76-#81) takes its owner/name, branches, modules,
// reviewCycleCap and resolved label vocabulary from the entries this
// returns, rather than reading a config itself.
import { pathOps } from '../platform/paths'
import type { ReposAddResponse, ReposListResponse, ReposRemoveResponse } from '../../shared/ipc'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { ReadyEntry } from '../actions/apply'
import type { GitRunner } from './harness'
import { inspectRepository, resolveGitRoot } from './inspect'
import { readRegistry, writeRegistry } from './store'

export interface RegistryDeps {
  readonly registryDir: string
  readonly git: GitRunner
  readonly chooseDirectory: () => Promise<string | null>
}

async function inspectAll(paths: readonly string[], git: GitRunner) {
  return Promise.all(paths.map((path) => inspectRepository(path, { git })))
}

export async function listRepositories(deps: RegistryDeps): Promise<ReposListResponse> {
  const registry = await readRegistry(deps.registryDir)
  if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }
  const repositories = await inspectAll(registry.repositories, deps.git)
  return { ok: true, repositories }
}

export async function addRepository(deps: RegistryDeps): Promise<ReposAddResponse> {
  const registry = await readRegistry(deps.registryDir)
  if (!registry.ok) return { ok: false, kind: registry.kind, message: registry.message }

  const picked = await deps.chooseDirectory()
  if (picked === null) return { ok: true, outcome: 'cancelled' }

  // Resolve to the git root before the duplicate check, so a subdirectory
  // of an already-registered repository is not registered a second time. A
  // directory that is not a repository at all still gets added — its own
  // `not-a-git-repository` problem is the point of surfacing it.
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

  const repositories = await inspectAll(newPaths, deps.git)
  const added = repositories.find((entry) => pathOps.samePath(entry.path, effectivePath))
  return { ok: true, outcome: 'added', added: added?.id ?? (pathOps.pathKey(effectivePath) as unknown as RepoId), repositories }
}

/** The one `RepositoryEntry` -> `ReadyEntry` narrowing every channel that
 *  resolves a repository by id needs — previously declared separately in
 *  `main/channels/hosting.ts`, `main/channels/items.ts`, and
 *  `main/dispatch/resolve.ts`. */
export function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

/** The "find a registered, ready repository by id, or throw" lookup every
 *  repository-scoped channel composes — `subject` is the caller's own
 *  error-message prefix (e.g. `"'item:action'"` or `"claim"`), so each
 *  channel's thrown text keeps naming itself exactly as it did before this
 *  lookup was shared. `list` is the caller's own injected
 *  `listRepositories`, the same test seam every `*Deps` interface already
 *  gives its channel. */
export async function requireReadyRepo(registryDeps: RegistryDeps, subject: string, repoId: string, list: typeof listRepositories): Promise<ReadyEntry> {
  const result = await list(registryDeps)
  if (!result.ok) throw new Error(`${subject} could not list repositories: ${result.message}`)
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

  const repositories = await inspectAll(remaining, deps.git)
  return { ok: true, repositories }
}
