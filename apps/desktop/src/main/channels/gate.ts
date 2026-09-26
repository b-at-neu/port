// The plan gate's four channels' validation and composition (#92) — every
// stale-renderer mistake throws here, never becomes a value `main/actions/
// gate.ts` has to defend against, the same rail `main/ipc.ts`'s own
// `resolveItemAction` already applies. Forces one `board:refresh` on an
// `applied` label outcome, swallowing and logging a refresh failure so it
// can never mask the write's own success — `repository.issues` is
// read-your-writes consistent (`query.ts` Decision 2), the same reasoning
// `resolveItemAction`'s own forced refresh already relies on.
import { GATE_DECISIONS } from '../../shared/gate/types'
import type { GateAnswerResponse, GateClaimResponse, GateDecision, GatePreflightResponse } from '../../shared/gate/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { ClaimRead } from '../../shared/writes/types'
import type { IpcMap } from '../../shared/ipc'
import type { RegistryDeps } from '../registry'
import type { GateAnswerParams, GateClaimReadParams, GateClaimSetParams, GatePreflightParams } from '../actions'

/** One binding per composed function, plus the board's own `refresh` —
 *  the same seam `main/ipc.ts`'s `ItemActionDeps` gives `resolveItemAction`,
 *  so every validation branch below is testable without Electron, a real
 *  registry, or a real `gh`. `main/ipc.ts` wires each field to `main/actions/
 *  gate.ts`'s own export (already bound to its own `defaultGateDeps`) and to
 *  the live watcher's `refresh`. */
export interface GateChannelDeps {
  readonly gatePreflight: (params: GatePreflightParams) => Promise<GatePreflightResponse>
  readonly gateClaimRead: (params: GateClaimReadParams) => Promise<ClaimRead>
  readonly gateClaimSet: (params: GateClaimSetParams) => Promise<GateClaimResponse>
  readonly gateAnswer: (params: GateAnswerParams) => Promise<GateAnswerResponse>
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

/** `'gate:preflight'`'s validation: `repoId` a non-empty string, `number` a
 *  positive integer — the same rail every other channel applies. Whether the
 *  id names a currently-registered, `ready` repository is `main/actions/
 *  gate.ts`'s own `resolveReadyEntry` to decide, never duplicated here. */
export async function resolveGatePreflight(registryDeps: RegistryDeps, request: IpcMap['gate:preflight']['request'], deps: GateChannelDeps): Promise<GatePreflightResponse> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'gate:preflight' requires a non-empty 'repoId'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'gate:preflight' requires 'number' to be a positive integer")
  }
  return deps.gatePreflight({ registryDeps, repoId: request.repoId, number: request.number })
}

export async function resolveGateClaimRead(registryDeps: RegistryDeps, request: IpcMap['gate:claim:read']['request'], deps: GateChannelDeps): Promise<ClaimRead> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'gate:claim:read' requires a non-empty 'repoId'")
  }
  return deps.gateClaimRead({ registryDeps, repoId: request.repoId })
}

/** `held` is the target state the operator's own button named — `true` to
 *  take, `false` to release — never a toggle this channel infers. */
export async function resolveGateClaimSet(registryDeps: RegistryDeps, request: IpcMap['gate:claim:set']['request'], deps: GateChannelDeps): Promise<GateClaimResponse> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'gate:claim:set' requires a non-empty 'repoId'")
  }
  if (typeof request.held !== 'boolean') {
    throw new Error("'gate:claim:set' requires 'held' to be a boolean")
  }
  return deps.gateClaimSet({ registryDeps, repoId: request.repoId, held: request.held })
}

function isGateDecision(value: unknown): value is GateDecision {
  return (GATE_DECISIONS as readonly string[]).includes(value as string)
}

/**
 * `'gate:answer'`'s validation: the same `repoId`/`number` rail every other
 * channel applies, `decision` restricted to `GATE_DECISIONS`, `skipComment`
 * a boolean, and `feedback` a non-empty string when — and only when —
 * `decision` is `'request-changes'` and `skipComment` is `false`. On an
 * `applied` label outcome, forces one `board:refresh` before returning, the
 * same rule `resolveItemAction` already follows.
 */
export async function resolveGateAnswer(
  registryDeps: RegistryDeps,
  request: IpcMap['gate:answer']['request'],
  auditDir: string,
  scratchDir: string,
  deps: GateChannelDeps,
): Promise<GateAnswerResponse> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'gate:answer' requires a non-empty 'repoId'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'gate:answer' requires 'number' to be a positive integer")
  }
  if (!isGateDecision(request.decision)) {
    throw new Error(`'gate:answer' requires 'decision' to be one of ${GATE_DECISIONS.join(', ')}`)
  }
  if (typeof request.skipComment !== 'boolean') {
    throw new Error("'gate:answer' requires 'skipComment' to be a boolean")
  }
  const feedbackRequired = request.decision === 'request-changes' && !request.skipComment
  if (feedbackRequired && (typeof request.feedback !== 'string' || request.feedback.trim() === '')) {
    throw new Error("'gate:answer' requires a non-empty 'feedback' when 'decision' is 'request-changes' and 'skipComment' is false")
  }

  const result = await deps.gateAnswer({
    registryDeps,
    repoId: request.repoId,
    number: request.number,
    decision: request.decision,
    feedback: request.feedback ?? null,
    skipComment: request.skipComment,
    auditDir,
    scratchDir,
  })

  if (result.kind === 'answered' && result.labels.kind === 'applied') {
    try {
      await deps.refresh({ repoId: request.repoId, source: 'github' })
    } catch (error) {
      console.error(`'gate:answer' post-write refresh failed for '${request.repoId}':`, error)
    }
  }
  return result
}
