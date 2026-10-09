// The 'dispatch:control' channel's own validation and composition (#110,
// #314, #331) — all the branching lives here, not in `main/ipc.ts`, the same
// split every other multi-call channel in this app already follows. #326
// removes 'dispatch:relay' along with the hosted dispatcher session it
// relayed through; #331 replaces the old dispatch claim scope with
// `.agents/cockpit.json` ownership and adds the `take-over` command.
import { DISPATCH_COMMANDS, RUN_TARGET } from '../../shared/dispatch/types'
import type { DispatchCommand, DispatchControlResult, HaltReport } from '../../shared/dispatch/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { RefreshRequest } from '../state/watcher'
import type { RepoId } from '../../shared/repos'
import { isReadyEntry, listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import { releaseOwnership, takeOwnership } from './ownership'
import type { HaltDispatchDeps, HaltDispatchParams } from './halt'
import type { RunStateStore } from './store'

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

/** Every currently registered repository's id, any status — `null` when the
 *  registry itself could not be listed. Shared by `resolveDispatchControl`'s
 *  own `repoId` validation (run/drain/pause: "a registered repository, any
 *  status") and by `main/dispatch/store.ts`'s own v1 migration, which
 *  `main/ipc.ts` wires as `runStates.load`'s own `registered` callback. */
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

/** Maps a failed `takeOwnership`/`releaseOwnership` write into the one
 *  `'unwritable'` reason every `DispatchControlResult` failure already
 *  carries for a run-state write it cannot distinguish further — an
 *  ownership-file write failure is just as fatal as a run-state one. */
function ownershipWriteFailureReason(result: Extract<Awaited<ReturnType<typeof takeOwnership>>, { readonly ok: false }>): { readonly reason: 'terminal-owned'; readonly since: string } | { readonly reason: 'ownership-unreadable'; readonly message: string; readonly path: string } | { readonly reason: 'unwritable'; readonly message: string; readonly path: string } {
  if (result.kind === 'refused') {
    return result.verdict.kind === 'terminal'
      ? { reason: 'terminal-owned', since: result.verdict.since }
      : { reason: 'ownership-unreadable', message: result.verdict.message, path: result.verdict.path }
  }
  return { reason: 'unwritable', message: result.message, path: result.path }
}

/**
 * `command` validated against `DISPATCH_COMMANDS` by name — the same rail
 * `resolveItemAction` already follows for `OPERATOR_ACTIONS`. `halt` carries
 * no `repoId` and sweeps every ready repository; `run`/`drain`/`pause`/
 * `take-over` each require a `repoId` naming a currently registered
 * repository (any status).
 *
 * `run` → `takeOwnership({ force: false })` when a ready entry exists for
 * this repository (refused outright on `terminal`/`unreadable`/a write
 * failure, with no run-state write), then `runStates.set([repoId],
 * RUN_TARGET.run, …)`, refused outright on any write failure, then one
 * `refresh({ repoId })`. `drain` → the same ownership take, then
 * `runStates.set([repoId], 'draining', …)`, never refused on an unwritable
 * run-state failure (`persisted: false` instead — the gate still closed in
 * memory), refused outright only when the run-state store itself is
 * unreadable; no refresh, since nothing about the poll needs to change.
 * `pause` → `haltDispatch` scoped to `[repoId]` (which itself writes
 * `'paused'` first), then `releaseOwnership` for this repository (a release
 * failure surfaces as `released: false`, never thrown — the halt itself
 * still succeeded), then one `refresh({ repoId })`. `halt` → `haltDispatch`
 * across every ready repository (which itself writes `'paused'` for each
 * first), then `releaseOwnership` for each of them, then one `refresh({})`
 * regardless of whether the halt completed or aborted, since the run state
 * itself may have changed either way. `take-over` → `takeOwnership({ force:
 * true })` (refused only on a genuine write failure, since `force`
 * overrides a `terminal`/`unreadable` record), then the same run-state write
 * and refresh as `run`.
 */
export async function resolveDispatchControl(
  registryDeps: RegistryDeps,
  request: { readonly command: DispatchCommand; readonly repoId?: RepoId },
  deps: ResolveDispatchControlDeps,
): Promise<DispatchControlResult> {
  if (typeof request?.command !== 'string' || !(DISPATCH_COMMANDS as readonly string[]).includes(request.command)) {
    throw new Error(`'dispatch:control' requires 'command' to be one of ${DISPATCH_COMMANDS.join(', ')}`)
  }

  if (request.command === 'halt') {
    if (request.repoId !== undefined) throw new Error("'dispatch:control' halt must not carry a 'repoId'")
    const list = await deps.listRepositories(registryDeps)
    const entries = list.ok ? list.repositories.filter(isReadyEntry) : []
    const report = await deps.haltDispatch({ snapshot: deps.snapshot(), entries, runStates: deps.runStates, repoIds: entries.map((e) => e.id), auditDir: deps.auditDir, now: deps.now })
    const releases = await Promise.all(entries.map((entry) => deps.releaseOwnership({ repoRoot: entry.path, repo: entry.config.repo })))
    await deps.refresh({})
    return { ok: true, command: 'halt', report, released: releases.every((r) => r.ok) }
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

  if (request.command === 'take-over') {
    const entry = await findReadyEntry(registryDeps, repoId, deps)
    if (entry === null) throw new Error(`'dispatch:control' take-over requires '${repoId}' to be a ready repository`)
    const taken = await deps.takeOwnership({ repoRoot: entry.path, repo: entry.config.repo, force: true, now: deps.now })
    // `force: true` means `taken.kind` can never actually be `'refused'` —
    // narrowed here only so this compiles against `TakeOwnershipResult`'s
    // full union.
    if (!taken.ok) return { ok: false, command: 'take-over', repoId, reason: 'unwritable', message: taken.kind === 'refused' ? 'ownership write unexpectedly refused despite force' : taken.message, path: taken.path }
    const written = await deps.runStates.set([repoId], RUN_TARGET.run, deps.now().toISOString())
    if (!written.ok) return { ok: false, command: 'take-over', repoId, reason: 'unwritable', message: written.message, path: deps.runStates.path }
    await deps.refresh({ repoId })
    return { ok: true, command: 'take-over', repoId, runState: deps.runStates.current(repoId) }
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
