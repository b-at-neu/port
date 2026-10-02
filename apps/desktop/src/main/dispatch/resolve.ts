// The 'dispatch:control' channel's own validation and composition (#110) —
// all the branching lives here, not in `main/ipc.ts`, the same split every
// other multi-call channel in this app already follows. #265 adds
// 'dispatch:claim:set' and 'dispatch:relay' alongside it, same shape.
import { DISPATCH_COMMANDS } from '../../shared/dispatch/types'
import type { DispatchClaimSetResult, DispatchCommand, DispatchControlResult, DispatchRelayResult, HaltReport, RepoDispatchStatus } from '../../shared/dispatch/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { RefreshRequest } from '../state'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import { listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import type { ReadyEntry } from '../actions'
import { GATE_CLAIM_OWNER } from '../../shared/gate/types'
import { releaseClaimScope, takeClaimScope } from '../writes'
import type { ClaimWriteResult } from '../writes'
import type { Dispatcher } from './dispatcher'
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

export interface ResolveDispatchClaimSetDeps {
  readonly listRepositories: typeof listRepositories
  readonly dispatcher: Dispatcher
  readonly refresh: (request?: RefreshRequest) => Promise<BoardSnapshot>
  readonly now: () => Date
}

async function resolveReadyRepoRoot(registryDeps: RegistryDeps, repoId: RepoId, deps: Pick<ResolveDispatchClaimSetDeps, 'listRepositories'>): Promise<ReadyEntry> {
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`dispatch claim requires the registry, which could not be listed: ${list.message}`)
  const entry = list.repositories.find((repository) => repository.id === repoId)
  if (entry === undefined) throw new Error(`dispatch claim found no repository registered with id '${String(repoId)}'`)
  if (!isReadyEntry(entry)) throw new Error(`dispatch claim requires a 'ready' repository, got '${entry.problem.kind}'`)
  return entry
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
    draining: false,
    claudeSessionId: null,
    claimedAt: null,
  }
  return { kind: 'ok', status }
}

export interface ResolveDispatchRelayDeps {
  readonly listRepositories: typeof listRepositories
  readonly dispatcher: Dispatcher
  readonly maxReplyChars: number
}

/**
 * `'dispatch:relay'`'s composition (#265) — validates the request shape
 * itself (a bad shape throws, the same rail every other channel in this
 * app follows), resolves the repository is actually `ready`, then delegates
 * to `dispatcher.relay`, which itself refuses `not-owner`/`unknown-agent`/
 * `no-dispatcher`.
 */
export async function resolveDispatchRelay(
  registryDeps: RegistryDeps,
  request: { readonly repoId: RepoId; readonly agentId: string; readonly text: string },
  deps: ResolveDispatchRelayDeps,
): Promise<DispatchRelayResult> {
  if (typeof request?.repoId !== 'string' || typeof request.agentId !== 'string' || request.agentId === '' || typeof request.text !== 'string' || request.text === '' || request.text.length > deps.maxReplyChars) {
    throw new Error("'dispatch:relay' requires a ready repoId, a non-empty agentId, and non-empty text within MAX_REPLY_CHARS")
  }
  await resolveReadyRepoRoot(registryDeps, request.repoId, deps)
  return deps.dispatcher.relay({ repoId: request.repoId, agentId: request.agentId, text: request.text })
}
