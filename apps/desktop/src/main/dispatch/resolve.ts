// The 'dispatch:control' channel's own validation and composition (#110,
// #314) — all the branching lives here, not in `main/ipc.ts`, the same split
// every other multi-call channel in this app already follows. #265 adds
// 'dispatch:claim:set' alongside it, same shape; #326 removes 'dispatch:relay'
// along with the hosted dispatcher session it relayed through.
import { DISPATCH_COMMANDS, RUN_TARGET } from '../../shared/dispatch/types'
import type { DispatchClaimSetResult, DispatchCommand, DispatchControlResult, HaltReport, RepoDispatchStatus } from '../../shared/dispatch/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { RefreshRequest } from '../state/watcher'
import type { RepoId } from '../../shared/repos'
import { isReadyEntry, listRepositories, requireReadyRepo } from '../registry'
import type { RegistryDeps } from '../registry'
import type { ReadyEntry } from '../actions/apply'
import { GATE_CLAIM_OWNER } from '../../shared/gate/types'
import { releaseClaimScope, takeClaimScope } from '../writes/claim'
import type { ClaimWriteResult } from '../../shared/writes/types'
import type { Dispatcher } from './dispatcher'
import type { HaltDispatchDeps, HaltDispatchParams } from './halt'
import type { RunStateStore } from './store'

export interface ResolveDispatchControlDeps {
  readonly listRepositories: typeof listRepositories
  readonly runStates: RunStateStore
  readonly haltDispatch: (params: HaltDispatchParams, deps?: HaltDispatchDeps) => Promise<HaltReport>
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

/**
 * `command` validated against `DISPATCH_COMMANDS` by name — the same rail
 * `resolveItemAction` already follows for `OPERATOR_ACTIONS`. `halt` carries
 * no `repoId` and sweeps every ready repository; `run`/`drain`/`pause` each
 * require a `repoId` naming a currently registered repository (any status).
 *
 * `run` → `runStates.set([repoId], RUN_TARGET.run, …)`, refused outright on
 * any write failure, then one `refresh({ repoId })`. `drain` →
 * `runStates.set([repoId], 'draining', …)`, never refused on an unwritable
 * failure (`persisted: false` instead — the gate still closed in memory),
 * refused outright only when the store itself is unreadable; no refresh,
 * since nothing about the poll needs to change. `pause` → `haltDispatch`
 * scoped to `[repoId]` (which itself writes `'paused'` first), then one
 * `refresh({ repoId })`. `halt` → `haltDispatch` across every ready
 * repository (which itself writes `'paused'` for each first), then one
 * `refresh({})` regardless of whether the halt completed or aborted, since
 * the run state itself may have changed either way.
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
    await deps.refresh({})
    return { ok: true, command: 'halt', report }
  }

  if (typeof request.repoId !== 'string' || request.repoId === '') {
    throw new Error(`'dispatch:control' requires a non-empty 'repoId' for command '${request.command}'`)
  }
  const repoId = request.repoId
  const ids = await registeredRepoIds(registryDeps, deps)
  if (ids === null) throw new Error(`'dispatch:control' could not list repositories to validate '${repoId}'`)
  if (!ids.includes(repoId)) throw new Error(`'dispatch:control' found no repository registered with id '${repoId}'`)

  if (request.command === 'run') {
    const written = await deps.runStates.set([repoId], RUN_TARGET.run, deps.now().toISOString())
    if (!written.ok) return { ok: false, command: 'run', repoId, reason: written.reason, message: written.message, path: deps.runStates.path }
    await deps.refresh({ repoId })
    return { ok: true, command: 'run', repoId, runState: deps.runStates.current(repoId) }
  }

  if (request.command === 'drain') {
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
  await deps.refresh({ repoId })
  return { ok: true, command: 'pause', repoId, runState: deps.runStates.current(repoId), report }
}

export interface ResolveDispatchClaimSetDeps {
  readonly listRepositories: typeof listRepositories
  readonly dispatcher: Dispatcher
  readonly refresh: (request?: RefreshRequest) => Promise<BoardSnapshot>
  readonly now: () => Date
}

function resolveReadyRepoRoot(registryDeps: RegistryDeps, repoId: RepoId, deps: Pick<ResolveDispatchClaimSetDeps, 'listRepositories'>): Promise<ReadyEntry> {
  return requireReadyRepo(
    registryDeps,
    'dispatch claim',
    repoId,
    deps.listRepositories,
    (message) => `dispatch claim requires the registry, which could not be listed: ${message}`,
  )
}

/**
 * `'dispatch:claim:set'`'s composition (#265) — the mirror of
 * `main/actions/gate.ts`'s own `gateClaimSet`, for the `dispatch` scope
 * instead of `plan-gate`. A claim is created or released only by this
 * explicit operator action, through the scope-preserving pair so a held
 * `plan-gate` is never dropped by taking or releasing `dispatch`. Runs one
 * `refresh({ repoId })` afterwards — the dispatcher's own `consider` rides
 * that refresh's `onSnapshot`, so the owner line reflects the new claim on
 * its very next render rather than waiting for the next scheduled tick.
 */
export async function resolveDispatchClaimSet(
  registryDeps: RegistryDeps,
  request: { readonly repoId: RepoId; readonly held: boolean },
  deps: ResolveDispatchClaimSetDeps,
): Promise<DispatchClaimSetResult> {
  const entry = await resolveReadyRepoRoot(registryDeps, request.repoId, deps)
  const result: ClaimWriteResult = request.held
    ? await takeClaimScope({ repoRoot: entry.path, repo: entry.config.repo, owner: GATE_CLAIM_OWNER, scope: 'dispatch', now: deps.now })
    : await releaseClaimScope({ repoRoot: entry.path, repo: entry.config.repo, scope: 'dispatch' })
  if (!result.ok) return { kind: 'failed', result }

  await deps.refresh({ repoId: request.repoId })
  const status: RepoDispatchStatus = deps.dispatcher.status().find((s) => s.repoId === request.repoId) ?? {
    repoId: request.repoId,
    owner: request.held ? 'app' : 'cockpit',
    state: { kind: 'idle' },
    runState: 'paused',
    claimedAt: null,
    budget: null,
    observed: [],
  }
  return { kind: 'ok', status }
}
