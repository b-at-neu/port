// The board's item-level writes — `item:action` and `item:decide`. Every
// stale-renderer mistake throws here, never a value `main/actions/` defends.
import { OPERATOR_ACTIONS, OPERATOR_DECISIONS, UNBLOCK_ROUTES } from '../../shared/actions/types'
import type { ItemActionResult, ItemDecisionResult, OperatorDecision, UnblockRoute } from '../../shared/actions/types'
import { MAX_REVISE_NOTE_CHARS } from '../../shared/actions/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { RepositoryEntry } from '../../shared/repos'
import type { IpcMap } from '../../shared/ipc'
import type { RegistryDeps } from '../registry'
import { listRepositories } from '../registry'
import type { ApplyItemActionParams, ReadyEntry } from '../actions/apply'
import type { ApplyItemDecisionParams } from '../actions/decide'

export interface ItemActionDeps {
  readonly listRepositories: typeof listRepositories
  readonly applyItemAction: (params: ApplyItemActionParams) => Promise<ItemActionResult>
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

export function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

/** Validates the request, then forces one refresh after an applied outcome
 *  so the row updates immediately rather than after the next poll. */
export async function resolveItemAction(registryDeps: RegistryDeps, request: IpcMap['item:action']['request'], auditDir: string, deps: ItemActionDeps): Promise<ItemActionResult> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'item:action' requires a non-empty 'repoId'")
  }
  if (request.kind !== 'issue' && request.kind !== 'pull-request') {
    throw new Error("'item:action' requires 'kind' to be 'issue' or 'pull-request'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'item:action' requires 'number' to be a positive integer")
  }
  if (!(OPERATOR_ACTIONS as readonly string[]).includes(request.action)) {
    throw new Error(`'item:action' requires 'action' to be one of ${OPERATOR_ACTIONS.join(', ')}`)
  }
  const expectedStage: unknown = request.expectedStage
  if (expectedStage !== null && (typeof expectedStage !== 'string' || expectedStage === '')) {
    throw new Error("'item:action' requires 'expectedStage' to be a non-empty string or null")
  }

  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'item:action' could not list repositories: ${list.message}`)
  const found = list.repositories.find((repository) => repository.id === request.repoId)
  if (!found) throw new Error(`'item:action' found no repository registered with id '${request.repoId}'`)
  if (!isReadyEntry(found)) throw new Error(`'item:action' requires a 'ready' repository, got '${found.problem.kind}'`)

  const result = await deps.applyItemAction({
    request: { repoId: request.repoId, kind: request.kind, number: request.number, action: request.action, expectedStage: request.expectedStage },
    snapshot: deps.snapshot(),
    entry: found,
    auditDir,
  })

  if (result.ok && result.outcome.kind === 'applied') {
    // A refresh failure here is logged and swallowed, never left to mask
    // the write's own already-successful result.
    try {
      await deps.refresh({ repoId: request.repoId, source: 'github' })
    } catch (error) {
      console.error(`'item:action' post-write refresh failed for '${request.repoId}':`, error)
    }
  }
  return result
}

/** The seam `'item:decide'` composes through. */
export interface ItemDecisionDeps {
  readonly listRepositories: typeof listRepositories
  readonly applyItemDecision: (params: ApplyItemDecisionParams) => Promise<ItemDecisionResult>
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

function isOperatorDecision(value: unknown): value is OperatorDecision {
  return (OPERATOR_DECISIONS as readonly string[]).includes(value as string)
}

function isUnblockRoute(value: unknown): value is UnblockRoute {
  return (UNBLOCK_ROUTES as readonly string[]).includes(value as string)
}

// Validates the request and its route/note pair, then forces one refresh
// on an applied label outcome, the same rule `resolveItemAction` follows.
export async function resolveItemDecision(registryDeps: RegistryDeps, request: IpcMap['item:decide']['request'], auditDir: string, scratchDir: string, deps: ItemDecisionDeps): Promise<ItemDecisionResult> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'item:decide' requires a non-empty 'repoId'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'item:decide' requires 'number' to be a positive integer")
  }
  if (!isOperatorDecision(request.decision)) {
    throw new Error(`'item:decide' requires 'decision' to be one of ${OPERATOR_DECISIONS.join(', ')}`)
  }
  const expectedStage: unknown = request.expectedStage
  if (expectedStage !== null && (typeof expectedStage !== 'string' || expectedStage === '')) {
    throw new Error("'item:decide' requires 'expectedStage' to be a non-empty string or null")
  }
  if (typeof request.skipComment !== 'boolean') {
    throw new Error("'item:decide' requires 'skipComment' to be a boolean")
  }
  if (request.decision === 'unblock') {
    if (!isUnblockRoute(request.route)) throw new Error(`'item:decide' requires 'route' to be one of ${UNBLOCK_ROUTES.join(', ')} for 'unblock'`)
    if (request.note !== null) throw new Error("'item:decide' requires 'note' to be null for 'unblock'")
  } else {
    if (request.route !== null) throw new Error("'item:decide' requires 'route' to be null for 'revise'")
    if (typeof request.note !== 'string' || request.note.length > MAX_REVISE_NOTE_CHARS) {
      throw new Error(`'item:decide' requires 'note' to be a string of at most ${String(MAX_REVISE_NOTE_CHARS)} characters for 'revise'`)
    }
  }

  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'item:decide' could not list repositories: ${list.message}`)
  const found = list.repositories.find((repository) => repository.id === request.repoId)
  if (!found) throw new Error(`'item:decide' found no repository registered with id '${request.repoId}'`)
  if (!isReadyEntry(found)) throw new Error(`'item:decide' requires a 'ready' repository, got '${found.problem.kind}'`)

  const result = await deps.applyItemDecision({
    request: { repoId: request.repoId, number: request.number, decision: request.decision, expectedStage: request.expectedStage, route: request.route, note: request.note, skipComment: request.skipComment },
    snapshot: deps.snapshot(),
    entry: found,
    auditDir,
    scratchDir,
  })

  const labelsApplied = result.ok && result.labels.kind === 'applied'
  if (labelsApplied) {
    try {
      await deps.refresh({ repoId: request.repoId, source: 'github' })
    } catch (error) {
      console.error(`'item:decide' post-write refresh failed for '${request.repoId}':`, error)
    }
  }
  return result
}
