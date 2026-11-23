import type { RunStateStore, HaltDispatchParams, HaltDispatchDeps } from '@/types/dispatch'

// The 'dispatch:control' channel's own validation and composition — all the branching lives here,
// not in main/ipc.ts, the same split every other multi-call channel in this app follows.
import { DISPATCH_COMMANDS, RUN_TARGET } from '@/types/dispatch'
import type { DispatchCommand, DispatchControlResult, HaltReport } from '@/types/dispatch'
import type { BoardSnapshot } from '@/types/board'
import type { RefreshRequest } from '@/types/state'
import type { RepoId } from '@/utils/repos'
import { isReadyEntry, listRepositories } from '@/main/repos'
import type { RegistryDeps } from '@/types/registry'
import { releaseOwnership, takeOwnership } from '@/main/repos/ownership'



export interface ResolveDispatchControlDeps {
  readonly listRepositories: typeof listRepositories
  readonly runStates: RunStateStore
  readonly haltDispatch: (params: HaltDispatchParams, deps?: HaltDispatchDeps) => Promise<HaltReport>
  readonly takeOwnership: typeof takeOwnership
  readonly releaseOwnership: typeof releaseOwnership
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request?: RefreshRequest) => Promise<BoardSnapshot>
  readonly auditDir: string
  readonly now: () => Date
}

/** Every currently registered repository's id, any status — `null` when the registry itself
 *  could not be listed. */
export async function registeredRepoIds(registryDeps: RegistryDeps, deps: { readonly listRepositories: typeof listRepositories } = { listRepositories }): Promise<readonly RepoId[] | null> {
  const list = await deps.listRepositories(registryDeps)
  return list.ok ? list.repositories.map((r) => r.id) : null
}

async function findReadyEntry(registryDeps: RegistryDeps, repoId: RepoId, deps: Pick<ResolveDispatchControlDeps, 'listRepositories'>) {
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) return null
  const entry = list.repositories.find((e) => e.id === repoId)
  return entry !== undefined && isReadyEntry(entry) ? entry : null
}

/** Maps a failed `takeOwnership`/`releaseOwnership` write into the same reasons a run-state write failure carries. */
function ownershipWriteFailureReason(result: Extract<Awaited<ReturnType<typeof takeOwnership>>, { readonly ok: false }>): { readonly reason: 'ownership-unreadable' | 'unwritable'; readonly message: string; readonly path: string } {
  if (result.kind === 'refused') return { reason: 'ownership-unreadable', message: result.verdict.message, path: result.verdict.path }
  return { reason: 'unwritable', message: result.message, path: result.path }
}

/** Every command requires a registered `repoId`; `run`/`drain` take ownership and `pause` releases it. */
export async function resolveDispatchControl(
  registryDeps: RegistryDeps,
  request: { readonly command: DispatchCommand; readonly repoId?: RepoId },
  deps: ResolveDispatchControlDeps,
): Promise<DispatchControlResult> {
  if (typeof request?.command !== 'string' || !(DISPATCH_COMMANDS as readonly string[]).includes(request.command)) {
    throw new Error(`'dispatch:control' requires 'command' to be one of ${DISPATCH_COMMANDS.join(', ')}`)
  }

  if (typeof request.repoId !== 'string' || request.repoId === '') {
    throw new Error(`'dispatch:control' requires a non-empty 'repoId' for command '${request.command}'`)
  }
  const repoId = request.repoId
  const ids = await registeredRepoIds(registryDeps, deps)
  if (ids === null) throw new Error(`'dispatch:control' could not list repositories to validate '${repoId}'`)
  if (!ids.includes(repoId)) throw new Error(`'dispatch:control' found no repository registered with id '${repoId}'`)

  if (request.command === 'run') {
    const entry = await findReadyEntry(registryDeps, repoId, deps)
    if (entry !== null) {
      const taken = await deps.takeOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      if (!taken.ok) return { ok: false, command: 'run', repoId, ...ownershipWriteFailureReason(taken) }
    }
    const written = await deps.runStates.set([repoId], RUN_TARGET.run, deps.now().toISOString())
    if (!written.ok) return { ok: false, command: 'run', repoId, reason: written.reason, message: written.message, path: deps.runStates.path }
    await deps.refresh({ repoId })
    return { ok: true, command: 'run', repoId, runState: deps.runStates.current(repoId) }
  }

  if (request.command === 'drain') {
    const entry = await findReadyEntry(registryDeps, repoId, deps)
    if (entry !== null) {
      const taken = await deps.takeOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      if (!taken.ok) return { ok: false, command: 'drain', repoId, ...ownershipWriteFailureReason(taken) }
    }
    const written = await deps.runStates.set([repoId], RUN_TARGET.drain, deps.now().toISOString())
    if (!written.ok && written.reason === 'unreadable') {
      return { ok: false, command: 'drain', repoId, reason: 'unreadable', message: written.message, path: deps.runStates.path }
    }
    return { ok: true, command: 'drain', repoId, runState: deps.runStates.current(repoId), persisted: written.ok }
  }

  // 'pause'
  const list = await deps.listRepositories(registryDeps)
  const scoped = list.ok ? list.repositories.filter(isReadyEntry).filter((e) => e.id === repoId) : []
  const report = await deps.haltDispatch({ snapshot: deps.snapshot(), entries: scoped, runStates: deps.runStates, repoIds: [repoId], auditDir: deps.auditDir, now: deps.now })
  const released = (await Promise.all(scoped.map((entry) => deps.releaseOwnership({ repoRoot: entry.path, repo: entry.config.repo })))).every((r) => r.ok)
  await deps.refresh({ repoId })
  return { ok: true, command: 'pause', repoId, runState: deps.runStates.current(repoId), report, released }
}
