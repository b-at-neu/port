// The 'dispatch:control' channel's own validation and composition (#110) —
// all the branching lives here, not in `main/ipc.ts`, the same split every
// other multi-call channel in this app already follows.
import { DISPATCH_COMMANDS } from '../../shared/dispatch/types'
import type { DispatchCommand, DispatchControlResult, HaltReport } from '../../shared/dispatch/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { RefreshRequest } from '../state'
import type { RepositoryEntry } from '../../shared/repos'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import type { ReadyEntry } from '../actions'
import type { HaltDispatchDeps, HaltDispatchParams } from './halt'
import type { DrainStore } from './store'

export interface ResolveDispatchControlDeps {
  readonly listRepositories: typeof listRepositories
  readonly drain: DrainStore
  readonly haltDispatch: (params: HaltDispatchParams, deps?: HaltDispatchDeps) => Promise<HaltReport>
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request?: RefreshRequest) => Promise<BoardSnapshot>
  readonly auditDir: string
  readonly now: () => Date
}

function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

/**
 * `command` validated against `DISPATCH_COMMANDS` by name — the same rail
 * `resolveItemAction` already follows for `OPERATOR_ACTIONS` — then: `drain`
 * → `drain.set(true)`, never followed by a refresh (the plan's own "Drain
 * gates dispatch, never the poll" — nothing about the poll needs to change);
 * `resume` → `drain.set(false)`, refused outright on a failed write, then one
 * `refresh({})` (the ticket's own "run one tick immediately"); `halt` →
 * `haltDispatch` (which itself calls `drain.set(true)` first), then one
 * `refresh({})` regardless of whether the halt completed or aborted, since
 * the drain state itself may have changed either way.
 */
export async function resolveDispatchControl(
  registryDeps: RegistryDeps,
  request: { readonly command: DispatchCommand },
  deps: ResolveDispatchControlDeps,
): Promise<DispatchControlResult> {
  if (typeof request?.command !== 'string' || !(DISPATCH_COMMANDS as readonly string[]).includes(request.command)) {
    throw new Error(`'dispatch:control' requires 'command' to be one of ${DISPATCH_COMMANDS.join(', ')}`)
  }

  if (request.command === 'drain') {
    const written = await deps.drain.set(true, deps.now().toISOString())
    return { ok: true, command: 'drain', drain: deps.drain.current(), persisted: written.ok }
  }

  if (request.command === 'resume') {
    const written = await deps.drain.set(false, deps.now().toISOString())
    if (!written.ok) return { ok: false, command: 'resume', reason: 'drain-unwritable', message: written.message, path: deps.drain.path }
    await deps.refresh({})
    return { ok: true, command: 'resume', drain: deps.drain.current() }
  }

  // 'halt'
  const list = await deps.listRepositories(registryDeps)
  const entries = list.ok ? list.repositories.filter(isReadyEntry) : []
  const report = await deps.haltDispatch({ snapshot: deps.snapshot(), entries, drain: deps.drain, auditDir: deps.auditDir, now: deps.now })
  await deps.refresh({})
  return { ok: true, command: 'halt', drain: deps.drain.current(), report }
}
